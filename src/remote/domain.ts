import { createHash, randomUUID } from "node:crypto";
import { open, realpath, stat, readdir, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { atomicJson, newSession, PaceStore } from "../core/sessions.js";
import { projectKey } from "../core/session-model.js";
import { Orchestrator } from "../core/orchestrator.js";
import { FileEdits } from "../core/file-edits.js";
import { changeFileHistory } from "../core/file-history.js";
import { artifactDirectory, artifactPath } from "../core/system/artifacts.js";
import { verifyPlanPrompt, tryReadPlanFile } from "../core/orchestrator-helpers.js";
import { operation, preparePlanExecution, currentPlan, saveRoutingSelection } from "../core/operations.js";
import { configuredSkills, enabledSkills } from "../core/system/skills.js";
import { readAvailableModels } from "../integrations/models.js";
import { readUsageLimits } from "../integrations/usage.js";
import { validRoute } from "../shared/config.js";
import type { Config, OperationIntent, QueuedOperation, Session as PaceSession } from "../shared/types.js";
import { VERSION, MAX_TEXT_BYTES, parseRequest, type Method, type PendingInteraction, type RemoteEvent, type Request, type Route, type Session as RemoteSession, type Snapshot } from "./protocol.js";

export type RemoteBridge = {
  submit(prompt: string, session: PaceSession, intent?: OperationIntent, operation?: QueuedOperation): Promise<void>;
  cancel(sessionId: string): boolean;
  busy(sessionId: string): boolean;
  queue(session: PaceSession, prompt: QueuedOperation): Promise<boolean>;
  session(sessionId: string): PaceSession | undefined;
  changed(session: PaceSession): void;
};
type Interaction = { public: PendingInteraction; respond: (answer: unknown) => void; sessionId: string; timer: ReturnType<typeof setTimeout> };
type Active = { prompt: string; status: string; activities: string[] };
type Journal = { version: 1; entries: Record<string, { digest: string; at: string }> };
const MAX_FILE = 1024 * 1024;
const PRIVATE = /(^|\/)(?:\.env(?:\..*)?|\.git|\.ssh|\.gnupg|\.aws|\.azure|\.config|node_modules|vendor|dist|build)(\/|$)/i;
const UUID = /^[0-9a-f-]{36}$/i;
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

/** Versioned domain boundary. Never exposes App Server RPC or unrestricted file access. */
export class RemoteDomain {
  private revision = 0;
  private readonly epoch = randomUUID();
  private readonly listeners = new Set<(event: RemoteEvent) => void>();
  private readonly roots = new Map<string, string>();
  private readonly sessions = new Map<string, PaceSession>();
  private readonly active = new Map<string, Active>();
  private readonly pendingLaunch = new Set<string>();
  private readonly launches = new Set<Promise<void>>();
  private readonly launchErrors = new Map<string, string>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly interactions = new Map<string, Interaction>();
  private readonly interactionIds = new Map<string, string>();
  private readonly chains = new Map<string, Promise<unknown>>();
  private journal?: Journal;
  private journalSave = Promise.resolve();
  private models?: ReturnType<typeof readAvailableModels>;
  private disposed = false;
  private readonly previousTurn: Orchestrator["turn"];
  private readonly observedTurn: Orchestrator["turn"];

  constructor(private readonly store: PaceStore, private readonly orchestrator: Orchestrator, projects: readonly string[], private readonly bridge?: RemoteBridge) {
    for (const path of projects) this.roots.set(projectKey(path), resolve(path));
    this.previousTurn = orchestrator.turn.bind(orchestrator);
    this.observedTurn = (async (prompt, session, config, callback, signal, activate, intent, displayPrompt, queuedOperation) => {
      const active = { prompt, status: "Starting…", activities: [] as string[] };
      this.sessions.set(session.id, session); this.active.set(session.id, active); this.emit(session);
      const progress = Object.assign((event: Parameters<typeof callback>[0]) => {
        if (event.kind === "status") active.status = event.text.slice(0, 500);
        if (event.kind === "activity") active.activities = [...active.activities.slice(-39), event.title.slice(0, 200)];
        if (event.kind === "approval") this.addInteraction(session, { id: randomUUID(), kind: "approval", command: event.command.slice(0, 16000), ...(event.cwd ? { cwd: event.cwd.slice(0, 1000) } : {}), ...(event.reason ? { reason: event.reason.slice(0, 2000) } : {}), ...(event.network === undefined ? {} : { network: event.network }) }, event.respond);
        if (event.kind === "question") this.addInteraction(session, { id: randomUUID(), kind: "question", questions: event.questions.map(question => ({ ...question, question: question.question.slice(0, 4000), options: question.options.slice(0, 20) })) }, event.respond);
        if (event.kind === "questionResolved") { const id = this.interactionIds.get(event.id); if (id) this.removeInteraction(id); else this.emit(session); }
        try { callback(event); } finally { this.emit(session); }
      }, { ...(callback as unknown as Record<string, unknown>) });
      const controller = signal ? undefined : new AbortController();
      if (controller) this.controllers.set(session.id, controller);
      let completed = false;
      try { const outcome = await this.previousTurn(prompt, session, config, progress, signal ?? controller!.signal, activate, intent, displayPrompt, queuedOperation); completed = true; return outcome; }
      finally {
        if (controller) this.controllers.delete(session.id);
        this.active.delete(session.id);
        for (const [id, item] of this.interactions) if (item.sessionId === session.id) this.removeInteraction(id);
        this.sessions.set(session.id, session); this.bridge?.changed(session); this.emit(session);
        if (completed && !this.pendingLaunch.has(session.id)) await this.drain(session);
      }
    }) as Orchestrator["turn"];
    orchestrator.turn = this.observedTurn;
  }

  subscribe(listener: (event: RemoteEvent) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  /** Resume queued operations after session loading has recovered interrupted attempts. */
  async resumeQueues(): Promise<void> {
    if (this.bridge) return;
    for (const project of this.roots.values()) {
      for (const session of await this.store.list(project)) {
        if (session.queuedPrompts?.length) await this.drain(session);
      }
    }
  }
  async close() {
    this.disposed = true;
    if (this.orchestrator.turn === this.observedTurn) this.orchestrator.turn = this.previousTurn;
    for (const controller of this.controllers.values()) controller.abort();
    while (this.launches.size) await Promise.allSettled([...this.launches]);
    for (const item of this.interactions.values()) clearTimeout(item.timer);
    this.interactions.clear(); this.listeners.clear();
  }

  async handle(raw: Request, deviceId: string): Promise<unknown> {
    if (this.disposed) throw new Error("Remote host is stopping.");
    const request = parseRequest(raw);
    switch (request.method) {
      case "projects.list": return [...this.roots].map(([id, path]) => ({ id, path, exists: true }));
      case "sessions.list": return this.store.listSummaries(await this.project(request.params.projectId));
      case "sessions.create": return this.serial(request.params.projectId, async () => {
        const path = await this.project(request.params.projectId); const config = await this.store.loadConfig();
        const session = newSession(path, config.routingMode, request.params.kind, config.autoLaunchSkills);
        await this.store.saveChanges(session); this.sessions.set(session.id, session); this.emit(session); return { id: session.id };
      });
      case "sessions.snapshot": return this.snapshot(request.params.projectId, request.params.sessionId);
      case "prompts.send": return this.accept(request.params.projectId, request.params.sessionId, deviceId, request.params.key, request.params, request.params.prompt);
      case "plan.run": {
        const session = await this.session(request.params.projectId, request.params.sessionId);
        if (!(await currentPlan(this.store, session))?.trim()) throw new Error("Conversation has no saved plan.");
        const intent = request.params.action === "verify" ? "verify_plan" : "execute_plan";
        const prompt = request.params.action === "verify" ? "/verify" : "/execute";
        return this.accept(request.params.projectId, session.id, deviceId, request.params.key, request.params, prompt, intent);
      }
      case "task.run": {
        const session = await this.session(request.params.projectId, request.params.sessionId);
        const task = session.tasks?.find(item => item.id === request.params.taskId); if (!task) throw new Error("Task not found.");
        return this.accept(request.params.projectId, session.id, deviceId, request.params.key, request.params, `Continue this Pace task: ${task.text}`);
      }
      case "queue.remove": {
        const session = await this.session(request.params.projectId, request.params.sessionId);
        const items = session.queuedPrompts ?? []; if (request.params.index >= items.length) throw new Error("Queued prompt not found.");
        items.splice(request.params.index, 1); session.queuedPrompts = items; await this.store.saveChanges(session); this.emit(session); return { removed: true, queuedPrompts: items.map(item => typeof item === "string" ? item : item.text) };
      }
      case "turn.cancel": {
        const session = await this.session(request.params.projectId, request.params.sessionId); const removedQueued = session.queuedPrompts?.length ?? 0;
        session.queuedPrompts = []; await this.store.saveChanges(session);
        const cancelled = this.bridge ? this.bridge.cancel(session.id) : !!this.controllers.get(session.id);
        if (!this.bridge) this.controllers.get(session.id)?.abort(); this.emit(session); return { cancelled, removedQueued };
      }
      case "interaction.answer": return this.answer(request.params.sessionId, request.params.interactionId, request.params.decision, request.params.answers);
      case "routing.set": return this.routing(request.params.projectId, request.params.sessionId, request.params.mode, request.params.route);
      case "approval.set": {
        const config = await this.store.loadConfig(); config.approvalMode = request.params.mode; await this.store.saveConfig(config); return { approvalMode: config.approvalMode };
      }
      case "models.list": return this.models ??= readAvailableModels();
      case "usage.get": return readUsageLimits();
      case "skills.list": {
        const config = await this.store.loadConfig(); return enabledSkills(await configuredSkills(config), config).map(({ name, description }) => ({ name, description }));
      }
      case "artifacts.list": return this.artifacts(request.params.projectId, request.params.sessionId);
      case "reader.read": return this.reader(request.params.projectId, request.params.sessionId, request.params.path, request.params.offset);
      case "diff.list": return this.diffList(request.params.projectId, request.params.sessionId, request.params.editId);
      case "diff.read": return this.diffRead(request.params.projectId, request.params.sessionId, request.params.editId, request.params.path, request.params.offset);
      case "diff.change": return this.diffChange(request.params.projectId, request.params.sessionId, request.params.editId, request.params.path, request.params.direction);
      case "devices.list": case "devices.revoke": throw new Error("Device administration is handled by host transport.");
    }
  }

  private async project(id: string) {
    const path = this.roots.get(id); if (!path) throw new Error("Project is not available to this host.");
    const actual = await realpath(path); if (projectKey(actual) !== id || !(await stat(actual)).isDirectory()) throw new Error("Project path changed; restart the host.");
    return actual;
  }
  private async session(projectId: string, sessionId: string) {
    if (!UUID.test(sessionId)) throw new Error("Conversation not found.");
    const path = await this.project(projectId); const current = this.bridge?.session(sessionId) ?? this.sessions.get(sessionId);
    const value = current?.projectPath === path && (this.bridge || this.active.has(sessionId) || this.pendingLaunch.has(sessionId)) ? current : await this.store.load(path, sessionId);
    if (!value || value.projectPath !== path) throw new Error("Conversation not found in this project.");
    this.sessions.set(value.id, value); return value;
  }
  private toDto(s: PaceSession): RemoteSession {
    return { id: s.id, ...(s.title ? { title: s.title } : {}), ...(s.kind ? { kind: s.kind } : {}), ...(s.plan ? { plan: s.plan.slice(0, MAX_FILE) } : {}), ...(s.planArtifact ? { planArtifact: s.planArtifact } : {}), projectPath: s.projectPath, routingMode: s.routingMode, route: this.wireRoute(s.route), updatedAt: s.updatedAt,
      turns: s.turns.map(t => ({ prompt: t.prompt.slice(0, 32000), ...(t.displayPrompt ? { displayPrompt: t.displayPrompt.slice(0, 32000) } : {}), result: t.result.slice(0, MAX_FILE), at: t.at, ...(t.fileEdits ? { fileEdits: t.fileEdits } : {}), ...(t.artifacts ? { artifacts: t.artifacts.filter(p => /^(?:artifacts|\.pace\/artifacts)\/[^/\\]+\.md$/.test(p)) } : {}), ...(t.failed ? { failed: true } : {}), ...(t.cancelled ? { cancelled: true } : {}), ...(t.route ? { route: this.wireRoute(t.route) } : {}), ...(t.durationMs ? { durationMs: t.durationMs } : {}), ...(t.usage ? { usage: { input_tokens: t.usage.input_tokens, output_tokens: t.usage.output_tokens } } : {}) })),
      ...(s.queuedPrompts?.length ? { queuedPrompts: s.queuedPrompts.map(item => typeof item === "string" ? item : item.text), queuedOperations: s.queuedPrompts.map(item => operation(item, s.id, s.activeTask?.id)) } : {}),
      ...(s.sideAnswers?.length ? { sideAnswers: s.sideAnswers.map(item => ({ ...item, question: item.question.slice(0, 32000), result: item.result?.slice(0, MAX_FILE), route: this.wireRoute(item.route) })) } : {}),
      ...(s.tasks ? { tasks: s.tasks.map(t => ({ ...t })) } : {}), ...(s.threadId ? { threadId: s.threadId } : {}), ...(s.threadId && s.contextByThread?.[s.threadId] ? { contextByThread: { [s.threadId]: s.contextByThread[s.threadId]! } } : {}) };
  }
  private wireRoute(route: PaceSession["route"]): RemoteSession["route"] {
    const valid = ["minimal", "low", "medium", "high", "xhigh", "ultra", "persistent"];
    return { ...(route.model ? { model: route.model } : {}), ...(route.effort && valid.includes(route.effort) ? { effort: route.effort as RemoteSession["route"]["effort"] } : {}) };
  }
  private async snapshot(projectId: string, sessionId: string): Promise<Snapshot> {
    const session = await this.session(projectId, sessionId); const active = this.active.get(sessionId);
    return { cursor: `${this.epoch}:${this.revision}`, session: this.toDto(session), ...(this.launchErrors.has(sessionId) ? { operationError: this.launchErrors.get(sessionId) } : {}), ...(active ? { active: { prompt: active.prompt, status: active.status, activities: [...active.activities] } } : {}), interactions: [...this.interactions.values()].filter(item => item.sessionId === sessionId).map(item => item.public), approvalMode: (await this.store.loadConfig()).approvalMode ?? "request-approval" };
  }
  private addInteraction(session: PaceSession, value: PendingInteraction, respond: (answer: never) => void) {
    const timer = setTimeout(() => { this.interactions.delete(value.id); this.emit(session); }, 10 * 60 * 1000);
    if (value.kind === "question") this.interactionIds.set(value.questions?.[0]?.id ?? "", value.id);
    this.interactions.set(value.id, { public: value, respond: respond as (answer: unknown) => void, sessionId: session.id, timer });
  }
  private answer(sessionId: string, id: string, decision?: "accept" | "decline", answers?: Record<string, { answers: string[] }>) {
    const item = this.interactions.get(id); if (!item || item.sessionId !== sessionId) throw new Error("Approval or question expired. Refresh the conversation.");
    if (item.public.kind === "approval") { if (!decision) throw new Error("Choose approve or decline."); item.respond(decision); }
    else {
      if (!answers || !item.public.questions) throw new Error("Question answer required.");
      const questions = new Map(item.public.questions.map(q => [q.id, q]));
      if (Object.keys(answers).length !== questions.size) throw new Error("Answer every question before submitting.");
      for (const [key, value] of Object.entries(answers)) {
        const q = questions.get(key); if (!q || value.answers.length < 1 || value.answers.length > 20 || value.answers.some(a => !q.isOther && !q.options.some(o => o.label === a))) throw new Error("Question answer is invalid.");
      }
      item.respond(answers);
    }
    clearTimeout(item.timer); this.interactions.delete(id); this.emit(this.sessions.get(sessionId)); return { accepted: true };
  }
  private async routing(projectId: string, sessionId: string, mode: "auto" | "manual", route: Route) {
    const session = await this.session(projectId, sessionId); if (this.active.has(sessionId) || this.bridge?.busy(sessionId)) throw new Error("Wait for active turn before changing routing.");
    const config = await this.store.loadConfig(); if (mode === "manual" && !validRoute(route, config.models)) throw new Error("Choose model and effort available in Pace settings.");
    const updated = await saveRoutingSelection(this.store, session, mode === "manual" ? route : "auto");
    this.sessions.set(updated.id, updated); this.bridge?.changed(updated); this.emit(updated); return { routingMode: mode, route: updated.route };
  }
  private async artifacts(projectId: string, sessionId: string) {
    const s = await this.session(projectId, sessionId); const files = await readdir(artifactDirectory(this.store, s), { withFileTypes: true }).catch(e => missing(e) ? [] : Promise.reject(e));
    return files.filter(f => f.isFile() && f.name.endsWith(".md") && !PRIVATE.test(f.name)).map(f => `artifacts/${f.name}`);
  }
  private async reader(projectId: string, sessionId: string, requested: string, offset: number) {
    const s = await this.session(projectId, sessionId); if (!requested.toLowerCase().endsWith(".md") || PRIVATE.test(requested)) throw new Error("Only approved Markdown files can be read.");
    const root = resolve(s.projectPath); const candidate = /^(?:artifacts|\.pace\/artifacts)\/[^/\\]+\.md$/.test(requested) ? artifactPath(this.store, s, requested) : resolve(root, requested);
    const actual = await realpath(candidate); const relativePath = relative(root, actual); const privateArtifacts = actual.startsWith(resolve(this.store.baseDir, "sessions", projectKey(root)) + sep);
    if ((!privateArtifacts && (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath))) || PRIVATE.test(relativePath) || !(await stat(actual)).isFile()) throw new Error("File is outside approved Markdown locations.");
    const info = await stat(actual); if (info.size > MAX_FILE) throw new Error("Markdown file exceeds 1 MiB.");
    const handle = await open(actual, "r"); let text: string; try { text = await handle.readFile({ encoding: "utf8" }); } finally { await handle.close(); }
    const lines = text.split("\n"); const start = Math.min(Math.max(offset, 0), lines.length); let end = start, size = 0;
    while (end < lines.length && end - start < 800 && size + Buffer.byteLength(lines[end]!) < 220 * 1024) size += Buffer.byteLength(lines[end++]!);
    return { path: requested, text: lines.slice(start, end).join("\n"), offset: start, nextOffset: end < lines.length ? end : null, totalLines: lines.length };
  }
  private async edit(projectId: string, sessionId: string, editId: string) {
    const session = await this.session(projectId, sessionId); if (!UUID.test(editId) || ![...session.turns, ...(session.undoneTurns ?? [])].some(t => t.fileEdits === editId)) throw new Error("File edit does not belong to this conversation.");
    const edits = new FileEdits(this.store, session); return { session, edits, record: await edits.load(editId) };
  }
  private async diffList(projectId: string, sessionId: string, editId: string) { const { record } = await this.edit(projectId, sessionId, editId); return record.changes.map(({ path, undone }) => ({ path, undone })); }
  private async diffRead(projectId: string, sessionId: string, editId: string, path: string, offset: number) {
    const { edits, record } = await this.edit(projectId, sessionId, editId); const change = record.changes.find(item => item.path === path); if (!change) throw new Error("File is not part of this turn.");
    const lines = (await edits.diff(change)).split("\n"); const start = Math.min(Math.max(offset, 0), lines.length); let end = start, size = 0;
    while (end < lines.length && end - start < 800 && size + Buffer.byteLength(lines[end]!) < 220 * 1024) size += Buffer.byteLength(lines[end++]!);
    return { path, text: lines.slice(start, end).join("\n"), offset: start, nextOffset: end < lines.length ? end : null, totalLines: lines.length };
  }
  private async diffChange(projectId: string, sessionId: string, editId: string, path: string, direction: "undo" | "redo") {
    const { session, record } = await this.edit(projectId, sessionId, editId); if (!record.changes.some(item => item.path === path)) throw new Error("File is not part of this turn.");
    const files = await changeFileHistory(this.store, session, editId, direction, path); this.sessions.set(session.id, session); this.bridge?.changed(session); this.emit(session); return { files, direction };
  }
  private async accept(projectId: string, sessionId: string, deviceId: string, key: string, payload: unknown, prompt: string, intent?: OperationIntent) {
    return this.serial(sessionId, async () => {
      const session = await this.session(projectId, sessionId);
      const busy = this.pendingLaunch.has(sessionId) || this.active.has(sessionId) || this.bridge?.busy(sessionId);
      if (busy && (session.queuedPrompts?.length ?? 0) >= 20) throw new Error("Conversation queue is full (20 prompts).");
      const accepted = await this.once(deviceId, key, payload); if (!accepted) return { accepted: true, duplicate: true, sessionId };
      const item = operation(prompt, session.id, session.activeTask?.id);
      const command = /^\/(verify|execute|run-plan|btw|adopt)(?:\s+([\s\S]*))?$/.exec(prompt.trim());
      item.intent = intent ?? (command?.[1] === "verify" ? "verify_plan" : command?.[1] === "execute" || command?.[1] === "run-plan" ? "execute_plan" : command?.[1] === "btw" ? "aside" : command?.[1] === "adopt" ? "adopt_side" : undefined);
      item.role = item.intent === "verify_plan" ? "verifier" : item.intent === "aside" ? "aside" : "main";
      if (item.intent === "adopt_side") item.sourceSideId = command?.[2]?.trim();
      if (busy) {
        if (this.bridge) { if (!await this.bridge.queue(session, item)) throw new Error("Conversation queue is full (20 prompts)."); }
        else await this.queue(session, item);
        return { accepted: true, queued: true, sessionId, operationId: item.id };
      }
      this.launch(session, item); return { accepted: true, queued: false, sessionId, operationId: item.id };
    });
  }
  private launch(source: PaceSession, item: QueuedOperation, queued = false) {
    this.pendingLaunch.add(source.id);
    this.launchErrors.delete(source.id);
    this.sessions.set(source.id, source);
    const work = (async () => {
      let completed = false;
      try {
        if (item.sessionId !== source.id || (item.taskId && item.taskId !== source.activeTask?.id)) throw new Error("Queued operation target changed; select its original task before running it.");
        const config = await this.store.loadConfig();
        let session = source;
        let prompt = item.text;
        let alreadyCompleted = false;
        if (item.intent === "execute_plan") {
          const argument = item.text.replace(/^\/(?:execute|run-plan)(?:\s+|$)/, "").trim();
          const execution = await preparePlanExecution(this.store, source, config, argument || undefined, item.id);
          session = execution.session; prompt = execution.prompt;
          alreadyCompleted = execution.completed;
          this.sessions.set(session.id, session); this.bridge?.changed(session); this.emit(session);
        } else if (item.intent === "verify_plan") {
          const argument = item.text.replace(/^\/verify(?:\s+|$)/, "").trim();
          const parts = argument.split(/\s+/); const file = argument ? tryReadPlanFile(parts[0]!, source.projectPath) : undefined;
          const plan = file?.content ?? await currentPlan(this.store, source);
          if (!plan?.trim()) throw new Error("Conversation has no saved plan.");
          prompt = verifyPlanPrompt(plan, source.turns[0]?.prompt, file ? parts.slice(1).join(" ") : argument || undefined);
        } else if (item.intent === "aside") prompt = item.text.replace(/^\/btw(?:\s+|$)/, "").trim();
        if (this.disposed) throw new Error("Remote host is stopping.");
        if (!alreadyCompleted) {
          if (this.bridge) await this.bridge.submit(prompt, session, item.intent, item);
          else await this.orchestrator.turn(prompt, session, config, () => {}, undefined, true, item.intent, undefined, item);
        }
        if (queued) await this.store.update(source, latest => {
          latest.queuedPrompts = latest.queuedPrompts?.filter(value => typeof value === "string" || value.id !== item.id);
        }, false);
        completed = true;
      } catch (error) { this.launchErrors.set(source.id, String(error)); this.emit(source); }
      finally { this.pendingLaunch.delete(source.id); if (completed && !this.disposed) await this.drain(source); }
    })();
    this.launches.add(work);
    void work.finally(() => this.launches.delete(work)).catch(() => {});
  }
  private async queue(session: PaceSession, item: QueuedOperation) {
    const latest = await this.store.update(session, current => {
      if ((current.queuedPrompts?.length ?? 0) >= 20) throw new Error("Conversation queue is full (20 prompts).");
      current.queuedPrompts = [...(current.queuedPrompts ?? []), item];
    });
    Object.assign(session, latest); this.emit(session);
  }
  private async drain(session: PaceSession) {
    return this.serial(session.id, async () => {
      if (this.disposed || this.pendingLaunch.has(session.id) || this.active.has(session.id) || this.bridge?.busy(session.id)) return;
      // The UI owns its in-memory queue and drains it through the turn runner.
      if (this.bridge) return;
      const latest = await this.store.load(session.projectPath, session.id);
      if (!latest || latest.deferredTurn || latest.turns.at(-1)?.failed || latest.attempts?.some(item => ["running", "awaiting_user"].includes(item.status))) return;
      Object.assign(session, latest); this.emit(session);
      const value = latest.queuedPrompts?.[0];
      if (value !== undefined) this.launch(session, operation(value, session.id, session.activeTask?.id), true);
    });
  }
  private async once(device: string, key: string, payload: unknown) {
    if (!UUID.test(key)) throw new Error("Invalid idempotency key.");
    const journal = await this.loadJournal(); const index = `${device}:${key}`; const digest = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    if (journal.entries[index]) { if (journal.entries[index]!.digest !== digest) throw new Error("Idempotency key already belongs to another request."); return false; }
    journal.entries[index] = { digest, at: new Date().toISOString() };
    journal.entries = Object.fromEntries(Object.entries(journal.entries).sort((a,b) => b[1].at.localeCompare(a[1].at)).slice(0, 2000));
    const previous = this.journalSave; let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; }); this.journalSave = previous.then(() => barrier, () => barrier); await previous.catch(() => {});
    try { await atomicJson(resolve(this.store.baseDir, "remote", "requests.json"), journal); } finally { release(); } return true;
  }
  private async loadJournal(): Promise<Journal> {
    if (this.journal) return this.journal;
    try { const value = JSON.parse(await readFile(resolve(this.store.baseDir, "remote", "requests.json"), "utf8")) as Journal; if (value.version !== 1 || !value.entries || typeof value.entries !== "object") throw new Error("Remote request journal is invalid."); return this.journal = value; }
    catch (error) { if (!missing(error)) throw error; return this.journal = { version: 1, entries: {} }; }
  }
  private async serial<T>(key: string, fn: () => Promise<T>): Promise<T> { const previous = this.chains.get(key) ?? Promise.resolve(); let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; }); this.chains.set(key, previous.then(() => barrier)); await previous.catch(() => {}); try { return await fn(); } finally { release(); } }
  private removeInteraction(id: string) { const value = this.interactions.get(id); if (value) { clearTimeout(value.timer); this.interactions.delete(id); this.emit(this.sessions.get(value.sessionId)); } }
  private emit(session?: PaceSession) { if (!session) return; const event = { v: VERSION, type: "changed", cursor: `${this.epoch}:${++this.revision}`, projectId: projectKey(session.projectPath), sessionId: session.id } satisfies RemoteEvent; for (const listener of this.listeners) { try { listener(event); } catch { /* Stale mobile sockets cannot affect Pace turns. */ } } }
}
