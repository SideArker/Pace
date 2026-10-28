import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTurnRunner } from "../src/components/turn-runner.js";
import { newSession, PaceStore } from "../src/core/sessions.js";
import { Orchestrator } from "../src/core/orchestrator.js";
import { PromptQueue } from "../src/core/prompt-queue.js";
import { operation } from "../src/core/operations.js";
import { steerQueuedPrompt } from "../src/components/queue-steering.js";
import { retainedConversationPrompt } from "../src/core/orchestrator-helpers.js";
import { CodexRunError, type CodexRunner } from "../src/integrations/codex-types.js";
import { linesFromSession } from "../src/components/session-transcript.js";
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
  const queue = new PromptQueue(); const sessions: Session[] = []; const statuses: string[] = []; const lines: { role: string; text: string }[] = [];
  const jobs = { current: new Map() }; const selected = { current: source.id };
  const runTurn = createTurnRunner({
    turnSequence: { current: 0 }, activeSessionId: selected, jobs, promptQueue: { current: queue }, titleAborts: { current: new Map() }, pendingApprovals: { current: new Map() }, pendingQuestions: { current: new Map() }, unreadCompletions: { current: new Set() }, sessionLines: { current: new Map() },
    runner, orchestrator, store, rememberSession: session => sessions.push(session), onTurnStart: () => {}, setRunningIds: () => {}, addFor: (_id, role, text) => lines.push({ role, text }), activityFor: () => {}, recordThoughtUsage: () => {}, resetThoughtUsage: () => {}, getTurnActivities: () => [], setStatusFor: (_id, value) => { statuses.push(value); }, showApproval: () => {}, showQuestion: () => {}, dismissQuestion: () => {}, setSession: () => {}, setVexState: () => {}, refreshUsage: () => {}, setQueueVersion: () => {}, setProcesses: () => {}, setLiveUsage: () => {}, getConfig: () => config,
  });
  return { store, root, source, config, runner, calls, orchestrator, queue, sessions, statuses, lines, runTurn, jobs };
}

it("UI completes overlapping history saves without an error and accepts the next prompt", async () => {
  const env = await fixture();
  const display = (await env.store.load(env.root, env.source.id))!;
  const save = env.store.saveChanges.bind(env.store);
  let enriched = false;
  vi.spyOn(env.store, "saveChanges").mockImplementation(async (...args) => {
    if (!enriched && args[0] === env.source && env.source.turns.length > 1) {
      enriched = true;
      display.turns[0]!.activities = [{ category: "command", text: "npm test" }];
      await save(display, false);
    }
    await save(...args);
  });
  expect(await env.runTurn("Verify plan", env.source, env.config, "verify_plan")).toBe(true);
  expect(enriched).toBe(true);
  expect(env.lines.filter(line => line.role === "error")).toEqual([]);
  expect(env.source.turns[0]?.activities).toEqual(display.turns[0]?.activities);
  expect(await env.runTurn("Continue verification", env.source, env.config, "continue_verify")).toBe(true);
  const saved = (await env.store.load(env.root, env.source.id))!;
  expect(saved.turns).toHaveLength(3);
  expect(saved.attempts).toHaveLength(2);
  expect(env.jobs.current.size).toBe(0);
});

it("UI preserves a truly conflicting snapshot and continues from disk without restarting", async () => {
  const env = await fixture();
  const save = env.store.saveChanges.bind(env.store);
  let conflicted = false;
  vi.spyOn(env.store, "saveChanges").mockImplementation(async (...args) => {
    if (!conflicted && args[0] === env.source && env.source.turns.length > 1) {
      conflicted = true;
      const latest = (await env.store.load(env.root, env.source.id))!;
      latest.turns[0]!.result = "Saved elsewhere";
      await save(latest, false);
      env.source.turns[0]!.result = "Local divergent edit";
    }
    await save(...args);
  });
  const queued = operation("Queued verification", env.source.id, "task");
  env.queue.restore(env.source.id, [queued]);
  expect(await env.runTurn("Verify plan", env.source, env.config, "verify_plan")).toBe(false);
  expect(conflicted).toBe(true);
  expect(env.calls).toHaveLength(1);
  expect(env.jobs.current.size).toBe(0);
  expect(env.queue.peekOperation(env.source.id)).toEqual(queued);
  expect(env.lines.filter(line => line.role === "error")).toEqual([]);
  expect(env.lines.some(line => line.text.includes("no restart is needed"))).toBe(true);
  const recovered = env.sessions.at(-1)!;
  expect(recovered.turns[0]?.result).toBe("Saved elsewhere");
  const recoveryDir = join(env.store.conversationDir(env.root, env.source.id), "recovery");
  const snapshots = await readdir(recoveryDir);
  expect(snapshots).toHaveLength(1);
  const snapshot = JSON.parse(await readFile(join(recoveryDir, snapshots[0]!), "utf8"));
  expect(snapshot.turns[0].result).toBe("Local divergent edit");
  expect(snapshot.turns.at(-1).result).toBe("Result");
  env.queue.clear(env.source.id);
  expect(await env.runTurn("Continue verification", recovered, env.config, "continue_verify")).toBe(true);
  expect(env.calls).toHaveLength(2);
});

it("UI pauses queue draining and recovers when a conflict occurs during the post-turn checkpoint", async () => {
  const env = await fixture();
  env.runner.run = async (...args) => {
    env.calls.push(args);
    await args[4]({ kind: "thread", text: "main-thread" });
    return { completed: true, result: "Result", threadId: "main-thread", context: { tokens: 900, windowTokens: 1000 } };
  };
  const save = env.store.saveChanges.bind(env.store);
  let conflicted = false;
  vi.spyOn(env.store, "saveChanges").mockImplementation(async (...args) => {
    if (!conflicted && args[0].attempts?.some(item => item.stage === "checkpoint")) {
      conflicted = true;
      const latest = (await env.store.load(env.root, env.source.id))!;
      latest.title = "Other title";
      await save(latest, false);
      env.source.title = "Local title";
    }
    await save(...args);
  });
  const current = operation("Continue planning", env.source.id, "task");
  const next = operation("Queued follow-up", env.source.id, "task");
  env.queue.restore(env.source.id, [current, next]);
  expect(await env.runTurn(current.text, env.source, env.config, undefined, undefined, false, current)).toBe(false);
  expect(conflicted).toBe(true);
  expect(env.calls).toHaveLength(1);
  expect(env.queue.peekOperation(env.source.id)).toEqual(current);
  expect(env.jobs.current.size).toBe(0);
  expect(env.sessions.at(-1)?.title).toBe("Other title");
  expect(env.lines.filter(line => line.role === "error")).toEqual([]);
});

for (const failureAt of ["start", "result"]) it(`UI accepts the next prompt after a ${failureAt} persistence failure in the same process`, async () => {
  const env = await fixture();
  const save = env.store.saveChanges.bind(env.store);
  const failingSave = vi.spyOn(env.store, "saveChanges").mockImplementation(async (...args) => {
    if (args[0].attempts?.some(item => item.status === (failureAt === "start" ? "running" : "completed"))) throw new Error("disk full");
    return save(...args);
  });
  expect(await env.runTurn("Verify plan", env.source, env.config, "verify_plan")).toBe(false);
  expect(env.jobs.current.size).toBe(0);
  failingSave.mockRestore();
  expect(await env.runTurn("Continue verification", env.source, env.config, "continue_verify")).toBe(true);
  expect(env.source.attempts?.[0]?.status).toBe("failed");
  expect(env.source.attempts?.at(-1)?.status).toBe("completed");
});

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

for (const state of ["pending", "unknown"] as const) it(`restart keeps ${state} steering paused instead of draining it as a new task`, async () => {
  const env = await fixture();
  const queued = operation("Check persistence first", env.source.id, "task");
  env.source.queuedPrompts = [queued];
  env.source.steeringRecords = [{ version: 1, id: queued.id, sessionId: env.source.id, taskId: "task", turnKey: "before-restart", role: "main", text: queued.text, state, createdAt: "now" }];
  await env.store.saveChanges(env.source, false);
  const loaded = (await new PaceStore(env.store.baseDir).load(env.root, env.source.id))!;
  expect(loaded.queuedPrompts).toEqual([queued]);
  expect(await env.runTurn(queued.text, loaded, env.config, undefined, undefined, false, queued)).toBe(false);
  await expect(env.orchestrator.turn(queued.text, loaded, env.config, () => {}, undefined, false, undefined, undefined, queued)).rejects.toThrow("already recorded as steering");
  expect(env.calls).toHaveLength(0);
  expect(loaded.activeTask!.id).toBe("task");
});

it("records turn usage, cost, thread turn count, and measured context when a turn fails or is cancelled", async () => {
  const env = await fixture();
  const usage = { input_tokens: 200_000, cached_input_tokens: 180_000, cache_write_input_tokens: 0, output_tokens: 1_000, reasoning_output_tokens: 400 };
  const context = { tokens: 231_320, windowTokens: 475_000, model: "gpt-6.1-sol" };
  env.source.threadTurnCount = 3;
  env.runner.run = async (...args) => {
    await args[4]({ kind: "thread", text: "main-thread" });
    throw new CodexRunError("You’ve hit your usage limit.", usage, context, {
      threadId: "main-thread", turnId: "turn-4", route: env.config.defaultRoute, knownUsage: usage, usageComplete: true,
    });
  };
  expect(await env.runTurn("Continue", env.source, env.config)).toBe(false);
  const lastTurn = env.source.turns.at(-1)!;
  expect(lastTurn.failed).toBe(true);
  expect(lastTurn.usage).toEqual(usage);
  expect(lastTurn.estimatedCostUsd).toBeGreaterThan(0);
  expect(env.source.threadTurnCount).toBe(4);
  expect(env.source.contextByThread?.["main-thread"]).toEqual(context);
  expect(env.lines.some(line => line.role === "meta" && line.text.includes("~$"))).toBe(true);
  const restored = linesFromSession(env.source, 1, x => x).lines;
  expect(restored.some(line => line.role === "meta" && line.text.includes("~$"))).toBe(true);
});
