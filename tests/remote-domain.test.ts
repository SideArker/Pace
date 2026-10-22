import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteDomain, type RemoteBridge } from "../src/remote/domain.js";
import { type Method, type Request, type Snapshot } from "../src/remote/protocol.js";
import { Orchestrator } from "../src/core/orchestrator.js";
import { newSession, PaceStore, projectKey } from "../src/core/sessions.js";
import { operation } from "../src/core/operations.js";
import type { Config, QueuedOperation, Session } from "../src/shared/types.js";
import type { CodexRunner } from "../src/integrations/codex-types.js";
import { decision } from "./routing-fixture.js";

vi.mock("../src/core/routing/pricing.js", async original => {
  const module = await original<typeof import("../src/core/routing/pricing.js")>();
  return { ...module, refreshVersionManifest: async () => module.currentVersionManifest() };
});
const roots: string[] = [], domains: RemoteDomain[] = [];
afterEach(async () => { await Promise.all(domains.splice(0).map(domain => domain.close())); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const config: Config = { routingMode: "auto", defaultRoute: { model: "gpt-6.1-sol", effort: "medium" }, models: [{ model: "gpt-6.1-sol", efforts: ["medium"] }], skillFolder: null };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pace-remote-domain-")); roots.push(root);
  const store = new PaceStore(join(root, "storage")); await store.saveConfig(config);
  const session = newSession(root, "manual", "planning"); session.route = config.defaultRoute;
  session.plan = "# Original plan\nImplement all three requirements.";
  session.activeTask = { id: "plan-task", originalRequest: "Plan feature", instructions: [] };
  await store.save(session);
  const calls: Parameters<CodexRunner["run"]>[] = [];
  let hold: (() => Promise<void>) | undefined;
  const runner: CodexRunner = { run: async (...args) => {
    calls.push(args); await hold?.();
    return { result: "All requested work and checks recorded", completed: true, threadId: `thread-${calls.length}` };
  } };
  const vex = { choose: async (request: import("../src/core/vex/requests.js").VexRequest) => decision(request, request.options.some(item => item.id === "closed") ? "unknown" : request.options.some(item => item.id === "reroute") ? "continue" : request.options[0]?.id === "single" ? "single" : "0:medium") };
  const orchestrator = new Orchestrator(store, runner, vex);
  const create = (bridge?: RemoteBridge) => { const domain = new RemoteDomain(store, orchestrator, [root], bridge); domains.push(domain); return domain; };
  const request = (domain: RemoteDomain, method: Method, params: Record<string, unknown> = {}) => domain.handle({ v: 1, id: randomUUID(), method, params: { projectId: projectKey(root), sessionId: session.id, ...params } } as Request, "device");
  return { root, store, session, calls, orchestrator, create, request, hold: (callback?: () => Promise<void>) => { hold = callback; } };
}

it("standalone plan.run executes the latest complete plan in a fresh normal session from manual planning", async () => {
  const env = await fixture(); const domain = env.create();
  env.session.planArtifact = "artifacts/current.pace-plan.md";
  await import("node:fs/promises").then(fs => fs.mkdir(join(env.store.conversationDir(env.root, env.session.id), "artifacts"), { recursive: true }));
  await writeFile(join(env.store.conversationDir(env.root, env.session.id), env.session.planArtifact), "# Updated full plan\nChanged on disk after the last turn.");
  await env.store.saveChanges(env.session);
  await env.request(domain, "plan.run", { action: "execute", key: randomUUID() });
  await vi.waitFor(async () => expect((await env.store.list(env.root)).find(item => item.executionSource)?.turns).toHaveLength(1));
  const fresh = (await env.store.list(env.root)).find(item => item.executionSource)!;
  expect(fresh).toMatchObject({ kind: "normal", routingMode: "auto", executionSource: { sessionId: env.session.id, taskId: "plan-task", plan: "# Updated full plan\nChanged on disk after the last turn." } });
  expect(env.calls[0]?.[0]).toContain("Changed on disk"); expect(env.calls[0]?.[6]).toBe("main");
  expect((await env.store.load(env.root, env.session.id))?.kind).toBe("planning");
});

it("accept queues verify and execute with identity and recipient, then drains both without changing planning ownership", async () => {
  const env = await fixture(); const domain = env.create();
  let release!: () => void; env.hold(() => new Promise<void>(resolve => { release = resolve; }));
  await env.request(domain, "plan.run", { action: "verify", key: randomUUID() });
  await vi.waitFor(() => expect(env.calls).toHaveLength(1));
  const verify = await env.request(domain, "plan.run", { action: "verify", key: randomUUID() }) as { operationId: string };
  const execute = await env.request(domain, "plan.run", { action: "execute", key: randomUUID() }) as { operationId: string };
  const saved = (await new PaceStore(env.store.baseDir).load(env.root, env.session.id))!;
  expect(saved.queuedPrompts).toMatchObject([
    { id: verify.operationId, intent: "verify_plan", role: "verifier", taskId: "plan-task", sessionId: env.session.id },
    { id: execute.operationId, intent: "execute_plan", role: "main", taskId: "plan-task", sessionId: env.session.id },
  ]);
  env.hold(); release();
  await vi.waitFor(async () => expect((await env.store.list(env.root)).find(item => item.executionSource)?.turns).toHaveLength(1));
  expect(env.calls.map(item => item[6])).toEqual(["side", "side", "main"]);
  await vi.waitFor(async () => expect((await env.store.load(env.root, env.session.id))?.queuedPrompts).toEqual([]));
  const source = (await env.store.load(env.root, env.session.id))!;
  expect(source.queuedPrompts).toEqual([]); expect(source.kind).toBe("planning"); expect(source.threadId).toBeUndefined();
  expect(source.turns[1]?.operation?.id).toBe(verify.operationId);
});

it("restart resumes persisted operations without reclassifying legacy command text", async () => {
  const env = await fixture(); env.session.kind = "normal";
  env.session.queuedPrompts = [operation("/verify", env.session.id, "plan-task")]; await env.store.saveChanges(env.session);
  const domain = env.create(); await domain.resumeQueues();
  await vi.waitFor(async () => expect((await env.store.load(env.root, env.session.id))?.queuedPrompts).toEqual([]));
  expect(env.calls[0]?.[6]).toBe("main");
});

it("restart pauses uncertain attempts and retains queued operations", async () => {
  const env = await fixture(); const queued = { ...operation("/execute", env.session.id, "plan-task"), intent: "execute_plan" as const };
  env.session.queuedPrompts = [queued];
  env.session.attempts = [{ id: "interrupted", taskId: "plan-task", generation: 1, stage: "plan", role: "main", status: "running", route: config.defaultRoute, startedAt: "now", observations: [] }];
  await env.store.saveChanges(env.session); await env.create().resumeQueues();
  expect(env.calls).toHaveLength(0); expect((await env.store.load(env.root, env.session.id))?.queuedPrompts).toEqual([queued]);
});

it("retains a failed queued operation and exposes preparation failure in the snapshot", async () => {
  const env = await fixture(); env.session.plan = undefined;
  const queued = { ...operation("/execute", env.session.id, "plan-task"), intent: "execute_plan" as const };
  env.session.queuedPrompts = [queued]; await env.store.saveChanges(env.session);
  const domain = env.create(); await domain.resumeQueues();
  await vi.waitFor(async () => expect((await env.request(domain, "sessions.snapshot") as Snapshot).operationError).toContain("No plan found"));
  expect((await env.store.load(env.root, env.session.id))?.queuedPrompts).toEqual([queued]); expect(env.calls).toHaveLength(0);
});

it("UI bridge receives the same fresh execution service and queue metadata", async () => {
  const env = await fixture(); let busy = true;
  const submitted: { prompt: string; session: Session; item?: QueuedOperation }[] = [];
  const bridge: RemoteBridge = {
    busy: () => busy, cancel: () => false, session: () => env.session, changed: () => {},
    queue: async (session, item) => { session.queuedPrompts = [...(session.queuedPrompts ?? []), item]; await env.store.saveChanges(session); return true; },
    submit: async (prompt, session, _intent, item) => { submitted.push({ prompt, session, item }); },
  };
  const domain = env.create(bridge);
  await env.request(domain, "plan.run", { action: "verify", key: randomUUID() });
  expect(env.session.queuedPrompts?.[0]).toMatchObject({ intent: "verify_plan", role: "verifier", taskId: "plan-task" });
  busy = false;
  await env.request(domain, "plan.run", { action: "execute", key: randomUUID() });
  await vi.waitFor(() => expect(submitted).toHaveLength(1));
  expect(submitted[0]?.session).toMatchObject({ kind: "normal", executionSource: { sessionId: env.session.id, plan: env.session.plan } });
  expect(submitted[0]?.item).toMatchObject({ intent: "execute_plan", sessionId: env.session.id });
});

it("routing.set applies intent to latest storage and publishes the saved snapshot to the UI bridge", async () => {
  const env = await fixture();
  let displayed = env.session;
  const changed = vi.fn((session: Session) => { displayed = session; });
  const bridge: RemoteBridge = {
    busy: () => false, cancel: () => false, session: () => displayed, changed,
    queue: async () => false, submit: async () => {},
  };
  const domain = env.create(bridge);
  const latest = await env.store.update(env.session, session => {
    session.activeTask!.workflow = { version: 1, generation: 2, shape: "scout_plan", stage: "plan", status: "completed", source: "vex", scoutHandoff: "Verified findings" };
    session.manualWorkflow = { shape: "scout_plan", routes: { scout: "vex", final: "vex" } };
    session.turns = [{ prompt: "Plan", result: "Current plan", at: "now" }];
  });
  await env.request(domain, "routing.set", { mode: "manual", route: config.defaultRoute });
  expect(changed).toHaveBeenCalledTimes(1);
  expect(displayed).toEqual(await env.store.load(env.root, env.session.id));
  expect(displayed.activeTask?.workflow).toEqual({ ...latest.activeTask!.workflow, source: "user", mainRoute: config.defaultRoute });
  expect(displayed.turns).toEqual(latest.turns);
  expect(displayed.manualWorkflow).toBeUndefined();
  await env.request(domain, "routing.set", { mode: "auto", route: {} });
  expect(changed).toHaveBeenCalledTimes(2);
  expect(displayed.routingMode).toBe("auto");
  expect(displayed).toEqual(await env.store.load(env.root, env.session.id));
  expect(displayed.controlDecisions).toHaveLength(1);
});

it("queued adoption preserves its source through restart and records only that finding", async () => {
  const env = await fixture(); env.session.kind = "normal";
  env.session.sideAnswers = [{ id: "selected", taskId: "plan-task", attemptId: "side-attempt", snapshotAt: "snapshot", question: "Explain", result: "Verified fact", route: config.defaultRoute }];
  const item = { ...operation("/adopt selected", env.session.id, "plan-task"), intent: "adopt_side" as const, sourceSideId: "selected" };
  env.session.queuedPrompts = [item]; await env.store.saveChanges(env.session);
  await env.create().resumeQueues();
  await vi.waitFor(async () => expect((await env.store.load(env.root, env.session.id))?.queuedPrompts).toEqual([]));
  expect(env.calls[0]?.[0]).toContain("Source side answer: selected");
  const saved = (await env.store.load(env.root, env.session.id))!;
  expect(saved.turns[0]?.operation).toEqual(item); expect(saved.sideAnswers?.[0]?.adopted).toBe(true);
});

it("restart acknowledges an executed operation without launching a second implementation session", async () => {
  const env = await fixture();
  const item = { ...operation("/execute", env.session.id, "plan-task"), intent: "execute_plan" as const };
  const { preparePlanExecution } = await import("../src/core/operations.js");
  const execution = await preparePlanExecution(env.store, env.session, config, undefined, item.id);
  await env.orchestrator.turn(execution.prompt, execution.session, config, () => {}, undefined, true, item.intent, undefined, item);
  expect(env.calls).toHaveLength(1);
  env.session.queuedPrompts = [item]; await env.store.saveChanges(env.session);
  await env.create().resumeQueues();
  await vi.waitFor(async () => expect((await env.store.load(env.root, env.session.id))?.queuedPrompts).toEqual([]));
  expect(env.calls).toHaveLength(1);
  expect((await env.store.list(env.root)).filter(session => session.executionSource)).toHaveLength(1);
});
