import type { ApprovalMode, Route } from "../shared/types.js";
import { realpath } from "node:fs/promises";
import type { Usage } from "@openai/codex-sdk";
import { CodexRunError, type ApprovalDecision, type CodexRunner, type Execution, type Progress, type RunnerMode, type UserAnswers, type UserQuestion } from "./codex-types.js";
import { AppServer, isRecord, type AppServerConnection, type JsonRecord } from "./app-server-process.js";
import { appServerThreadParams, appServerTurnParams, appUsage } from "./app-server-protocol.js";
import { appItemProgress, fileChangeProgress } from "./codex-events.js";
import { contextMeasurement } from "../core/context.js";
import { commandRisk } from "../core/command-protection.js";
import { turnImageInput } from "./image-input.js";

type RpcMessage = { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { message?: string } };
export type CompactionResult = {
  threadId: string;
  outcome: "completed" | "failed" | "cancelled";
  durationMs: number;
  usage?: Usage;
  error?: string;
  turnId?: string;
  route: Route;
  knownUsage?: Usage;
  usageComplete: boolean;
};

function sumUsage(left: Usage, right: Usage): Usage {
  return {
    input_tokens: left.input_tokens + right.input_tokens,
    cached_input_tokens: left.cached_input_tokens + right.cached_input_tokens,
    cache_write_input_tokens: left.cache_write_input_tokens + right.cache_write_input_tokens,
    output_tokens: left.output_tokens + right.output_tokens,
    reasoning_output_tokens: left.reasoning_output_tokens + right.reasoning_output_tokens,
  };
}

/** A cumulative total identifies one model request within an identified turn.
 * Repeated readings update that request; they are not additional inference. */
class TurnUsage {
  private readonly requests = new Map<number, Usage | undefined>();
  private unidentified = false;
  private fallback?: Usage;
  private billingStopped = false;
  context?: Execution["context"];
  private contextTotal = -1;

  markUnknown(): void { this.unidentified = true; }

  stopBilling(): void {
    // Without per-request model metadata, later inference cannot be priced on
    // the requested route. Preserve only the subtotal observed before reroute.
    this.billingStopped = true;
    this.markUnknown();
    this.context = undefined;
  }

  observe(value: unknown, model?: string): void {
    if (this.billingStopped) return;
    const raw = isRecord(value) ? value : {};
    const total = isRecord(raw.total) ? raw.total.totalTokens : undefined;
    if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0) {
      this.markUnknown();
      this.context = undefined;
      return;
    }
    this.requests.set(total, billableUsage(raw));
    if (total >= this.contextTotal) {
      this.contextTotal = total;
      this.context = contextMeasurement(raw, model);
    }
  }

  complete(...values: unknown[]): void {
    // Completion usage is a compatibility fallback, never a second charge.
    if (!this.requests.size && !this.billingStopped) this.fallback = values.map(billableUsage).find(value => value !== undefined);
  }

  get knownUsage(): Usage | undefined {
    let sum = this.fallback;
    for (const reading of this.requests.values()) if (reading) sum = sum ? sumUsage(sum, reading) : reading;
    return sum;
  }

  get usageComplete(): boolean {
    return !this.unidentified && (this.requests.size > 0
      ? [...this.requests.values()].every(reading => reading !== undefined)
      : this.fallback !== undefined);
  }

  get usage(): Usage | undefined { return this.usageComplete ? this.knownUsage : undefined; }
}

function billableUsage(value: unknown): Usage | undefined {
  if (!isRecord(value)) return undefined;
  const last = isRecord(value.last) ? value.last : value;
  const keys = [
    ["input_tokens", "inputTokens"], ["cached_input_tokens", "cachedInputTokens"],
    ["cache_write_input_tokens", "cacheWriteInputTokens"], ["output_tokens", "outputTokens"],
    ["reasoning_output_tokens", "reasoningOutputTokens"],
  ];
  if (keys.some(([snake, camel]) => {
    const number = last[snake!] ?? last[camel!];
    return typeof number !== "number" || !Number.isSafeInteger(number) || number < 0;
  })) return undefined;
  const usage = appUsage(value);
  if (!usage || usage.cached_input_tokens + usage.cache_write_input_tokens > usage.input_tokens ||
      usage.reasoning_output_tokens > usage.output_tokens) return undefined;
  // Native compaction can report context size with no billing measurement.
  if (typeof last.totalTokens === "number" && last.totalTokens > 0 &&
      usage.input_tokens === 0 && usage.output_tokens === 0) return undefined;
  return usage;
}

function eventTurnId(params: JsonRecord): unknown {
  return isRecord(params.turn) ? params.turn.id : params.turnId;
}

export class AppServerRunner implements CodexRunner {
  constructor(
    private readonly createServer: (
      onMessage: (message: RpcMessage) => void,
      onExit: (error: Error) => void,
    ) => AppServerConnection = (onMessage, onExit) => new AppServer(onMessage, onExit),
  ) {}

  async compact(
    threadId: string,
    project: string,
    route: Route,
    onProgress: (progress: Progress) => void | Promise<void>,
    signal?: AbortSignal,
  ): Promise<CompactionResult> {
    const started = performance.now();
    const accounting = new TurnUsage();
    const sourceRoute = { ...route };
    let activeTurnId: string | undefined;
    let sawCompaction = false;
    let completedStatus: string | undefined;
    let failure: string | undefined;
    let compacting = false;
    const previousTurnIds = new Set<string>();
    const buffered: RpcMessage[] = [];
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    const handleMessage = (message: RpcMessage): void => {
      const params = isRecord(message.params) ? message.params : {};
      if (!compacting) {
        const turnId = eventTurnId(params);
        if (params.threadId === threadId && typeof turnId === "string") previousTurnIds.add(turnId);
        return;
      }
      if (typeof params.threadId === "string" && params.threadId && params.threadId !== threadId) return;
      if (!activeTurnId) {
        // compact/start has no turn in its response. The protocol starts a new
        // identified turn; buffer usage until that lifecycle event arrives.
        if (message.method === "turn/started" && params.threadId === threadId && typeof eventTurnId(params) === "string") {
          if (previousTurnIds.has(eventTurnId(params) as string)) return;
          activeTurnId = eventTurnId(params) as string;
          for (const pending of buffered.splice(0)) handleMessage(pending);
        } else if (message.method === "turn/completed" &&
            (params.threadId !== threadId || typeof eventTurnId(params) !== "string")) {
          failure = "Codex compaction completion is missing thread or turn identity";
          finish();
        } else buffered.push(message);
        return;
      }
      const turnId = eventTurnId(params);
      if (typeof turnId === "string" && turnId && turnId !== activeTurnId) return;
      if (params.threadId !== threadId || turnId !== activeTurnId) {
        if (message.method === "thread/tokenUsage/updated") accounting.markUnknown();
        if (message.method === "turn/completed") { failure = "Codex completion is missing thread or turn identity"; finish(); }
        return;
      }
      if (message.method === "model/rerouted") accounting.stopBilling();
      if (message.method === "thread/tokenUsage/updated") accounting.observe(params.tokenUsage, sourceRoute.model);
      if (message.method === "item/completed" && isRecord(params.item) && params.item.type === "contextCompaction") {
        sawCompaction = true;
        void onProgress({ kind: "status", text: "Context compacted; finishing…" });
      }
      if (message.method === "turn/completed") {
        const turn = isRecord(params.turn) ? params.turn : {};
        accounting.complete(params.tokenUsage, turn.tokenUsage, turn.usage);
        completedStatus = typeof turn.status === "string" ? turn.status : undefined;
        if (isRecord(turn.error) && typeof turn.error.message === "string") failure = turn.error.message;
        finish();
      }
      if (message.method === "error" && params.willRetry !== true) {
        failure = isRecord(params.error) && typeof params.error.message === "string" ? params.error.message : "Codex app-server error";
        finish();
      }
    };
    const server = this.createServer(handleMessage, error => { failure = error.message; finish(); });
    const measurement = () => ({ turnId: activeTurnId, route: sourceRoute, usage: accounting.usage,
      knownUsage: accounting.knownUsage, usageComplete: !!activeTurnId && accounting.usageComplete });
    let cancelled = !!signal?.aborted;
    let abort!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      abort = () => {
        cancelled = true;
        void server.request("turn/interrupt", { threadId }).catch(() => {});
        reject(new Error("Compaction cancelled"));
      };
      signal?.addEventListener("abort", abort, { once: true });
    });
    const race = <T,>(work: Promise<T>) => Promise.race([work, aborted]);
    try {
      if (cancelled) throw new Error("Compaction cancelled");
      const cwd = await race(realpath(project));
      await race(server.request("initialize", {
        clientInfo: { name: "pace", title: "Pace", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      }));
      server.notify("initialized", {});
      const response = await race(server.request("thread/resume", appServerThreadParams(cwd, route, threadId, "main")));
      const resumed = isRecord(response) && isRecord(response.thread) ? response.thread.id : undefined;
      if (resumed !== threadId) throw new Error("Codex resumed a different thread");
      if (isRecord(response) && isRecord(response.thread) && Array.isArray(response.thread.turns)) {
        for (const turn of response.thread.turns) if (isRecord(turn) && typeof turn.id === "string") previousTurnIds.add(turn.id);
      }
      await race(Promise.resolve(onProgress({ kind: "status", text: "Compacting context…" })));
      compacting = true;
      await race(server.request("thread/compact/start", { threadId }));
      await race(done);
      if (failure) throw new Error(failure);
      if (completedStatus !== "completed" || !sawCompaction)
        throw new Error(`Compaction ended without a completed contextCompaction item (${completedStatus ?? "unknown"})`);
      return { threadId, outcome: "completed", durationMs: Math.round(performance.now() - started), ...measurement() };
    } catch (error) {
      return {
        threadId,
        outcome: cancelled ? "cancelled" : "failed",
        durationMs: Math.round(performance.now() - started),
        ...measurement(),
        error: String(error),
      };
    } finally {
      signal?.removeEventListener("abort", abort);
      server.kill();
    }
  }

  async run(
    prompt: string,
    project: string,
    route: Route,
    threadId: string | undefined,
    onProgress: (progress: Progress) => void | Promise<void>,
    signal?: AbortSignal,
    mode: RunnerMode = "main",
    trustedFolders: string[] = [],
    approvalMode: ApprovalMode = "request-approval",
    artifactDirectory?: string,
  ): Promise<Execution> {
    if (signal?.aborted) throw new Error("Turn cancelled");
    const { realpath } = await import("node:fs/promises");
    if (mode === "planning" && !artifactDirectory) throw new Error("Planning requires an artifact directory");
    const cwd = await realpath(mode === "planning" ? artifactDirectory! : project);
    signal?.throwIfAborted();
    let result = "";
    const accounting = new TurnUsage();
    const sourceRoute = { ...route };
    let activeThreadId: string | undefined;
    let activeTurnId: string | undefined;
    let turnRequested = false;
    const buffered: RpcMessage[] = [];
    let thread: JsonRecord | undefined;
    let failure: string | undefined;
    let completed = false;
    let acceptingSteers = false;
    const pendingSteers = new Set<Promise<void>>();
    const questions = new Map<string, (answers: UserAnswers) => void>();
    let turnResolve!: () => void;
    const turnDone = new Promise<void>(resolve => { turnResolve = resolve; });
    const handleMessage = (message: RpcMessage): void => {
      const params = isRecord(message.params) ? message.params : {};
      if (message.method === "serverRequest/resolved" && (typeof params.requestId === "number" || typeof params.requestId === "string")) {
        const id = String(params.requestId);
        if (questions.delete(id)) void onProgress({ kind: "questionResolved", id });
        return;
      }
      if (!turnRequested) return;
      if (!activeTurnId) { buffered.push(message); return; }
      if (typeof params.threadId === "string" && params.threadId && params.threadId !== activeThreadId) return;
      const turnId = eventTurnId(params);
      if (typeof turnId === "string" && turnId && turnId !== activeTurnId) return;
      if (params.threadId !== activeThreadId || turnId !== activeTurnId) {
        if (message.method === "thread/tokenUsage/updated") accounting.markUnknown();
        if (message.method === "turn/completed") { failure = "Codex completion is missing thread or turn identity"; turnResolve(); }
        return;
      }
      if (message.method === "item/fileChange/patchUpdated" && typeof params.itemId === "string") {
        void onProgress(fileChangeProgress({ id: params.itemId, changes: params.changes }, false, cwd));
        return;
      }
      if (message.method === "turn/completed") {
        acceptingSteers = false;
        for (const id of questions.keys()) void onProgress({ kind: "questionResolved", id });
        questions.clear();
        const turn = isRecord(params.turn) ? params.turn : {};
        accounting.complete(params.tokenUsage, turn.tokenUsage, turn.usage);
        if (turn.status === "failed" || turn.status === "interrupted") failure = isRecord(turn.error) && typeof turn.error.message === "string" ? turn.error.message : `Codex turn ${String(turn.status)}`;
        completed = turn.status === "completed";
        turnResolve();
        return;
      }
      if (message.method === "model/rerouted") accounting.stopBilling();
      if (message.method === "thread/tokenUsage/updated") {
        accounting.observe(params.tokenUsage, sourceRoute.model);
        if (accounting.usage) void onProgress({ kind: "usage", usage: accounting.usage });
      }
      if (message.method === "error" && params.willRetry !== true) {
        acceptingSteers = false;
        failure = isRecord(params.error) && typeof params.error.message === "string" ? params.error.message : "Codex app-server error";
        turnResolve();
        return;
      }
      const item = isRecord(params.item) ? params.item : undefined;
      if (!item) return;
      if (item.type === "agentMessage" && message.method === "item/completed" && typeof item.text === "string") {
        result = item.text;
      }
      const progress = appItemProgress(item, message.method ?? "", cwd);
      if (progress) {
        void onProgress(progress);
      }
    };
    const server = this.createServer(handleMessage, error => {
      acceptingSteers = false;
      failure = error.message;
      turnResolve();
    });
    const awaitAbort = <T,>(pending: Promise<T>): Promise<T> => {
      if (!signal) return pending;
      if (signal.aborted) return Promise.reject(signal.reason);
      return new Promise<T>((resolve, reject) => {
        let settled = false;
        const cleanup = () => signal.removeEventListener("abort", onAbort);
        const onAbort = () => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(signal.reason);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        pending.then(
          value => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(value);
          },
          error => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(error);
          },
        );
      });
    };
    const approvals = new Map<string, (decision: ApprovalDecision) => void>();
    server.setRequestHandler(message => {
      if (message.id === undefined) return;
      const params = isRecord(message.params) ? message.params : {};
      if (message.method === "item/tool/requestUserInput") {
        const parsed: UserQuestion[] = Array.isArray(params.questions) ? params.questions.flatMap(value => {
          if (!isRecord(value) || typeof value.id !== "string" || typeof value.question !== "string") return [];
          return [{
            id: value.id,
            header: typeof value.header === "string" ? value.header : "Question",
            question: value.question,
            options: Array.isArray(value.options) ? value.options.flatMap(option =>
              isRecord(option) && typeof option.label === "string"
                ? [{ label: option.label, description: typeof option.description === "string" ? option.description : "" }]
                : []) : [],
            isOther: value.isOther === true,
            isSecret: value.isSecret === true,
          }];
        }) : [];
        if (mode === "side" || !parsed.length || new Set(parsed.map(item => item.id)).size !== parsed.length) {
          server.respond(message.id, { answers: {} });
          return;
        }
        const requestId = message.id;
        const key = String(requestId);
        const resolve = (answers: UserAnswers) => {
          if (!questions.delete(key)) return;
          server.respond(requestId, { answers });
        };
        questions.set(key, resolve);
        void onProgress({ kind: "question", id: key, questions: parsed, respond: resolve });
        return;
      }
      const isCommandApproval = message.method === "item/commandExecution/requestApproval";
      const isFileApproval = message.method === "item/fileChange/requestApproval";
      if (!isCommandApproval && !isFileApproval) {
        server.respond(message.id, { decision: "decline" });
        return;
      }
      if (mode !== "main") {
        server.respond(message.id, { decision: "decline" });
        return;
      }
      if (isCommandApproval && typeof params.command === "string" && commandRisk(params.command).action === "block") {
        server.respond(message.id, { decision: "decline" });
        void onProgress({ kind: "status", text: `Blocked command: ${params.command}` });
        return;
      }
      const requestId = message.id;
      const approvalId = String(requestId);
      const resolve = (decision: ApprovalDecision) => {
        if (!approvals.delete(approvalId)) return;
        server.respond(requestId, { decision });
      };
      approvals.set(approvalId, resolve);
      const networkContext = isRecord(params.networkApprovalContext) ? params.networkApprovalContext : undefined;
      const networkTarget = networkContext
        ? `${String(networkContext.host ?? "host")}${networkContext.protocol ? ` (${String(networkContext.protocol)})` : ""}`
        : undefined;
      void onProgress({
        kind: "approval",
        id: String(params.itemId ?? requestId),
        command: isFileApproval
          ? "Codex requests permission to modify files"
          : typeof params.command === "string" ? params.command : networkTarget ? `Network access to ${networkTarget}` : "Codex requests permission to run a command",
        cwd: typeof params.cwd === "string" ? params.cwd : undefined,
        reason: typeof params.reason === "string" ? params.reason : undefined,
        network: !!networkContext,
        respond: resolve,
      });
    });
    try {
      const init = await awaitAbort(server.request("initialize", {
        clientInfo: { name: "pace", title: "Pace", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      }));
      void init;
      server.notify("initialized", {});
      const threadResult = await awaitAbort(server.request(
        threadId ? "thread/resume" : "thread/start",
        appServerThreadParams(cwd, route, threadId, mode, approvalMode),
      ));
      thread = isRecord(threadResult) && isRecord(threadResult.thread) ? threadResult.thread : undefined;
      const id = typeof thread?.id === "string" ? thread.id : threadId;
      if (!id) throw new Error("Codex app-server did not return a thread id");
      if (threadId && id !== threadId) throw new Error("Codex resumed a different thread");
      activeThreadId = id;
      signal?.throwIfAborted();
      await onProgress({ kind: "thread", text: id });
      const abortTurn = () => {
        for (const resolve of approvals.values()) resolve("decline");
        for (const resolve of questions.values()) resolve({});
        void server.request("turn/interrupt", { threadId: id }).catch(() => {});
      };
      signal?.addEventListener("abort", abortTurn, { once: true });
      try {
        signal?.throwIfAborted();
        await onProgress({ kind: "status", text: "Working…" });
        signal?.throwIfAborted();
        turnRequested = true;
        const turnResponse = await awaitAbort(server.request("turn/start", appServerTurnParams(prompt, cwd, route, id, mode, trustedFolders, approvalMode, artifactDirectory)));
        const responseTurn = isRecord(turnResponse) && isRecord(turnResponse.turn) ? turnResponse.turn : {};
        if (typeof responseTurn.id !== "string" || !responseTurn.id) throw new Error("Codex app-server did not return a turn id");
        activeTurnId = responseTurn.id;
        for (const pending of buffered.splice(0)) handleMessage(pending);
        acceptingSteers = !completed && !failure;
        if (acceptingSteers) await onProgress({ kind: "steering", steer: prompt => {
          if (!acceptingSteers || signal?.aborted) return Promise.reject(new Error("This turn is no longer accepting steering."));
          const expectedTurnId = activeTurnId;
          const pending = awaitAbort(server.request("turn/steer", {
            threadId: id, expectedTurnId, input: turnImageInput(prompt, mode, artifactDirectory),
          })).then(response => {
            if (!isRecord(response) || response.turnId !== expectedTurnId) throw new Error("Codex did not confirm steering for the active turn.");
          });
          pendingSteers.add(pending);
          void pending.finally(() => pendingSteers.delete(pending)).catch(() => {});
          return pending;
        } });
        await awaitAbort(turnDone);
        await Promise.allSettled(pendingSteers);
      } finally { signal?.removeEventListener("abort", abortTurn); }
      if (failure) throw new Error(failure);
      if (!completed) throw new Error("Codex stream ended without turn.completed");
      return { threadId: id, turnId: activeTurnId, route: sourceRoute,
        result: result || "Codex completed without a final message.", completed,
        usage: accounting.usage, knownUsage: accounting.knownUsage, usageComplete: accounting.usageComplete,
        context: accounting.context };
    } catch (error) {
      throw new CodexRunError(error instanceof Error ? error.message : String(error), accounting.usage, accounting.context,
        { threadId: activeThreadId, turnId: activeTurnId, route: sourceRoute,
          knownUsage: accounting.knownUsage, usageComplete: !!activeTurnId && accounting.usageComplete });
    } finally {
      acceptingSteers = false;
      try { await onProgress({ kind: "steering" }); }
      finally { server.kill(); }
    }
  }
}
