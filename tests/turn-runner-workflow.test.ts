import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTurnRunner } from "../src/components/turn-runner.js";
import { newSession, PaceStore } from "../src/core/sessions.js";
import { Orchestrator } from "../src/core/orchestrator.js";
import { PromptQueue } from "../src/core/prompt-queue.js";
import { operation } from "../src/core/operations.js";
import { steerQueuedPrompt } from "../src/components/queue-steering.js";
import { retainedConversationPrompt } from "../src/core/orchestrator-helpers.js";
import type { CodexRunner } from "../src/integrations/codex-types.js";
import type { Config, Session } from "../src/shared/types.js";
import { decision } from "./routing-fixture.js";
vi.mock("../src/core/routing/pricing.js", async original => {
  const module = await original<typeof import("../src/core/routing/pricing.js")>();
  return { ...module, refreshVersionManifest: async () => module.currentVersionManifest() };
});
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pace-ui-workflow-")); roots.push(root);
  const store = new PaceStore(join(root, "storage")); const source = newSession(root, "manual", "planning");
  const config: Config = { routingMode: "manual", models: [{ model: "gpt-6.1-sol", efforts: ["medium"] }], defaultRoute: { model: "gpt-6.1-sol", effort: "medium" }, skillFolder: null };
  source.route = config.defaultRoute; source.plan = "# Full current plan\nImplement all requirements."; source.title = "Plan";
  source.activeTask = { id: "task", originalRequest: "Plan full feature", instructions: [], assessment: "partial", workflow: { version: 1, generation: 1, shape: "plan", stage: "plan", mainRoute: config.defaultRoute, mainThreadId: "main-thread", source: "user" } };
  source.threadId = "main-thread"; source.threadTurnCount = 16;
  source.tasks = [{ id: "main-task", text: "Keep main task", completed: false, source: "agent" }];
  source.turns = [{ prompt: "Plan", result: "Full plan saved", at: "earlier" }];
  source.contextByThread = { "main-thread": { tokens: 900, windowTokens: 1000, model: config.defaultRoute.model } };
  await store.save(source);
  const calls: Parameters<CodexRunner["run"]>[] = [];
  const runner: CodexRunner = { run: async (...args) => {
    calls.push(args); await args[4]({ kind: "tasks", items: [{ text: "Auxiliary task", completed: true }] });
    await args[4]({ kind: "thread", text: `thread-${calls.length}` });
    return { result: "Result", completed: true, threadId: `thread-${calls.length}`, context: { tokens: 200, windowTokens: 1000 } };
  } };
  const vex = { choose: async (request: import("../src/core/vex/requests.js").VexRequest) => decision(request, request.options.some(item => item.id === "closed") ? "unknown" : request.options.some(item => item.id === "reroute") ? "continue" : request.options[0]?.id === "single" ? "single" : "0:medium") };
  const orchestrator = new Orchestrator(store, runner, vex);
  const queue = new PromptQueue(); const sessions: Session[] = []; const statuses: string[] = [];
  const jobs = { current: new Map() }; const selected = { current: source.id };
  const runTurn = createTurnRunner({
    turnSequence: { current: 0 }, activeSessionId: selected, jobs, promptQueue: { current: queue }, titleAborts: { current: new Map() }, pendingApprovals: { current: new Map() }, pendingQuestions: { current: new Map() }, unreadCompletions: { current: new Set() }, sessionLines: { current: new Map() },
    runner, orchestrator, store, rememberSession: session => sessions.push(session), onTurnStart: () => {}, setRunningIds: () => {}, addFor: () => {}, activityFor: () => {}, recordThoughtUsage: () => {}, resetThoughtUsage: () => {}, getTurnActivities: () => [], setStatusFor: (_id, value) => { statuses.push(value); }, showApproval: () => {}, showQuestion: () => {}, dismissQuestion: () => {}, setSession: () => {}, setVexState: () => {}, refreshUsage: () => {}, setQueueVersion: () => {}, setProcesses: () => {}, setLiveUsage: () => {}, getConfig: () => config,
  });
  return { store, root, source, config, runner, calls, orchestrator, queue, sessions, statuses, runTurn, jobs };
}

it("UI verifier events preserve the entire main state and never generate an already-due checkpoint", async () => {
  const env = await fixture();
  const main = structuredClone({ task: env.source.activeTask, route: env.source.route, thread: env.source.threadId, count: env.source.threadTurnCount, context: env.source.contextByThread, checkpoint: env.source.checkpoint, tasks: env.source.tasks });
  expect(await env.runTurn("Verify plan", env.source, env.config, "verify_plan")).toBe(true);
  expect(env.calls).toHaveLength(1); expect(env.calls[0]?.[6]).toBe("side");
  expect({ task: env.source.activeTask, route: env.source.route, thread: env.source.threadId, count: env.source.threadTurnCount, context: env.source.contextByThread, checkpoint: env.source.checkpoint, tasks: env.source.tasks }).toEqual(main);
  expect(env.source.verifier?.threadTurnCount).toBe(1); expect(env.source.verifier?.tasks?.[0]?.text).toBe("Auxiliary task");
});

it("UI direct execute from manual planning creates a normal fresh task using the whole plan", async () => {
  const env = await fixture();
  expect(await env.runTurn("/execute", env.source, env.config, "execute_plan")).toBe(true);
  expect(env.calls[0]?.[6]).toBe("main"); expect(env.calls[0]?.[3]).toBeUndefined();
  const fresh = (await env.store.list(env.root)).find(item => item.executionSource)!;
  expect(fresh).toMatchObject({ kind: "normal", routingMode: "auto", executionSource: { sessionId: env.source.id, taskId: "task", plan: env.source.plan } });
  expect(env.source.kind).toBe("planning"); expect(env.jobs.current.size).toBe(0);
  expect(env.statuses).toContain("Task completion unknown");
});

it("UI drains restored verify and execute operations with original identity and role", async () => {
  const env = await fixture();
  const verify = { ...operation("/verify", env.source.id, "task"), role: "verifier" as const, intent: "verify_plan" as const };
  const execute = { ...operation("/execute", env.source.id, "task"), intent: "execute_plan" as const };
  env.queue.restore(env.source.id, [verify, execute]);
  expect(await env.runTurn(verify.text, env.source, env.config, verify.intent, undefined, false, verify)).toBe(true);
  await vi.waitFor(() => expect(env.queue.list(env.source.id)).toEqual([]));
  expect(env.calls.map(item => item[6])).toEqual(["side", "main"]);
  expect(env.source.turns.at(-1)?.operation).toEqual(verify);
  const fresh = (await env.store.list(env.root)).find(item => item.executionSource)!;
  expect(fresh.turns.at(-1)?.operation).toEqual(execute);
});

it("UI pauses every queued operation after mandatory persistence failure", async () => {
  const env = await fixture(); const queued = { ...operation("/verify", env.source.id, "task"), role: "verifier" as const, intent: "verify_plan" as const };
  env.queue.restore(env.source.id, [queued]);
  vi.spyOn(env.store, "saveChanges").mockRejectedValue(new Error("disk full"));
  expect(await env.runTurn("Review", env.source, env.config, "verify_plan")).toBe(false);
  expect(env.calls).toHaveLength(0); expect(env.queue.peekOperation(env.source.id)).toEqual(queued);
});

it("UI saves accepted steering in turn history and waits before finishing the job", async () => {
  const env = await fixture();
  let finishRun!: () => void;
  let acceptSteer!: () => void;
  const finishing = new Promise<void>(resolve => { finishRun = resolve; });
  const accepted = new Promise<void>(resolve => { acceptSteer = resolve; });
  vi.spyOn(env.runner, "run").mockImplementationOnce(async (...args) => {
    await args[4]({ kind: "steering", steer: () => accepted });
    await finishing;
    await args[4]({ kind: "steering" });
    return { completed: true, result: "Guided result", threadId: "main-thread" };
  });
  const running = env.runTurn("Revise the plan", env.source, env.config);
  await vi.waitFor(() => expect(env.jobs.current.get(env.source.id)?.steer).toBeTypeOf("function"));
  env.queue.add(env.source.id, "Prioritize the keyboard flow");
  const steering = steerQueuedPrompt(env.source.id, 0, env.jobs.current, env.queue);
  finishRun();
  await vi.waitFor(() => expect(env.source.turns.at(-1)?.result).toBe("Guided result"));
  expect(env.jobs.current.has(env.source.id)).toBe(true);
  acceptSteer(); await steering; expect(await running).toBe(true);
  expect(env.queue.list(env.source.id)).toEqual([]);
  expect(env.jobs.current.size).toBe(0);
  const saved = (await env.store.load(env.root, env.source.id))!;
  expect(saved.turns.at(-1)?.steeringPrompts).toEqual(["Prioritize the keyboard flow"]);
  saved.threadId = undefined;
  expect(retainedConversationPrompt("Continue", saved)).toContain('"steering":["Prioritize the keyboard flow"]');
});
