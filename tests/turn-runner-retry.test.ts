import { afterEach, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTurnRunner } from "../src/components/turn-runner.js";
import { Orchestrator } from "../src/core/orchestrator.js";
import { PromptQueue } from "../src/core/prompt-queue.js";
import { PaceStore, newSession, retryableTurn } from "../src/core/sessions.js";
import type { CodexRunner } from "../src/integrations/codex.js";
import type { Config } from "../src/shared/types.js";

let dir: string;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

it("saves a usage-limited request, holds queued prompts, and resumes safely", async () => {
  dir = await mkdtemp(join(tmpdir(), "pace-retry-"));
  const session = newSession("/example/project", "manual");
  session.title = "CSV export";
  session.route = { model: "gpt-6-sol", effort: "high" };
  const config: Config = { routingMode: "manual", defaultRoute: session.route, models: [{ model: "gpt-6-sol", efforts: ["high"] }] };
  const queue = new PromptQueue();
  queue.add(session.id, "Follow-up request");
  const calls: string[] = [];
  const runner: CodexRunner = { async run(prompt) {
    calls.push(prompt);
    if (calls.length === 1) throw new Error("You've hit your usage limit. Try again at 8:21 PM.");
    return { threadId: "thread-1", result: "Finished", completed: true };
  } };
  const store = new PaceStore(dir);
  const lines: string[] = [];
  const runTurn = createTurnRunner({
    turnSequence: { current: 0 }, activeSessionId: { current: session.id }, jobs: { current: new Map() },
    promptQueue: { current: queue }, titleAborts: { current: new Map() }, pendingApprovals: { current: new Map() },
    pendingQuestions: { current: new Map() }, unreadCompletions: { current: new Set() }, runner,
    orchestrator: new Orchestrator(store, runner), store, rememberSession: () => {}, onTurnStart: () => {},
    setRunningIds: () => {}, addFor: (_id, _role, text) => lines.push(text), activityFor: () => {},
    recordThoughtUsage: () => {}, resetThoughtUsage: () => {}, getTurnActivities: () => [], setStatusFor: () => {},
    showApproval: () => {}, showQuestion: () => {}, dismissQuestion: () => {}, setSession: () => {},
    setVexState: () => {}, refreshUsage: () => {}, setQueueVersion: () => {}, setProcesses: () => {},
    setLiveUsage: () => {}, getConfig: () => config, readLimits: async () => { throw new Error("Usage service unavailable"); },
  });

  await runTurn("Implement CSV export", session, config);
  expect(session.deferredTurn?.prompt).toBe("Implement CSV export");
  expect((await store.latest(session.projectPath))?.deferredTurn).toEqual(session.deferredTurn);
  expect(queue.list(session.id)).toEqual(["Follow-up request"]);
  expect(lines.join("\n")).toContain("Pace saved this request and will retry");

  queue.clear(session.id);
  await runTurn(session.deferredTurn!.prompt, session, config);
  expect(calls[1]).toContain("Inspect current files and prior conversation before editing");
  expect(session.deferredTurn).toBeUndefined();
  expect((await store.latest(session.projectPath))?.deferredTurn).toBeUndefined();
});

it("retries a failed turn after reload without losing its thread, history, or file changes", async () => {
  dir = await mkdtemp(join(tmpdir(), "pace-retry-"));
  const session = newSession(dir, "manual");
  session.title = "Feature";
  session.route = { model: "gpt-6-sol", effort: "high" };
  session.threadId = "thread-1";
  session.turns.push({ prompt: "Earlier request", result: "Earlier result", at: new Date().toISOString() });
  const config: Config = { routingMode: "manual", defaultRoute: session.route, models: [{ model: "gpt-6-sol", efforts: ["high"] }] };
  const calls: { prompt: string; threadId: string | undefined }[] = [];
  const queue = new PromptQueue();
  queue.add(session.id, "Queued follow-up");
  const file = join(dir, "feature.txt");
  const runner: CodexRunner = { async run(prompt, _project, _route, threadId) {
    calls.push({ prompt, threadId });
    if (calls.length === 1) {
      await writeFile(file, "partial work");
      throw new Error("model at capacity");
    }
    if (calls.length === 2) throw new Error("internet connection down");
    return { threadId: "thread-1", result: "Finished remaining work", completed: true };
  } };
  const store = new PaceStore(dir);
  const lines: string[] = [];
  const makeTurnRunner = () => createTurnRunner({
    turnSequence: { current: 0 }, activeSessionId: { current: session.id }, jobs: { current: new Map() },
    promptQueue: { current: queue }, titleAborts: { current: new Map() }, pendingApprovals: { current: new Map() },
    pendingQuestions: { current: new Map() }, unreadCompletions: { current: new Set() }, runner,
    orchestrator: new Orchestrator(store, runner), store, rememberSession: () => {}, onTurnStart: () => {},
    setRunningIds: () => {}, addFor: (_id, _role, text) => lines.push(text), activityFor: () => {},
    recordThoughtUsage: () => {}, resetThoughtUsage: () => {}, getTurnActivities: () => [], setStatusFor: () => {},
    showApproval: () => {}, showQuestion: () => {}, dismissQuestion: () => {}, setSession: () => {},
    setVexState: () => {}, refreshUsage: () => {}, setQueueVersion: () => {}, setProcesses: () => {},
    setLiveUsage: () => {}, getConfig: () => config,
  });

  await makeTurnRunner()("Finish feature", session, config);
  expect(queue.list(session.id)).toEqual(["Queued follow-up"]);
  expect(session.deferredTurn?.reason).toBe("capacity");
  expect(lines.join("\n")).toContain("Model capacity reached");
  queue.clear(session.id);
  expect(retryableTurn(session)?.prompt).toBe("Finish feature");
  const reloaded = (await store.load(dir, session.id))!;
  expect(reloaded.threadId).toBe("thread-1");
  expect(reloaded.turns[0]?.result).toBe("Earlier result");
  expect(retryableTurn(reloaded)?.prompt).toBe("Finish feature");
  expect(reloaded.deferredTurn?.reason).toBe("capacity");

  await makeTurnRunner()(retryableTurn(reloaded)!.prompt, reloaded, config);
  expect(retryableTurn(reloaded)?.prompt).toBe("Finish feature");
  expect(reloaded.deferredTurn?.reason).toBe("network");
  expect(reloaded.turns).toHaveLength(2);
  await makeTurnRunner()(retryableTurn(reloaded)!.prompt, reloaded, config);
  expect(calls.map(call => call.threadId)).toEqual(["thread-1", "thread-1", "thread-1"]);
  expect(calls[1]?.prompt).toContain("Inspect current files and prior conversation before editing");
  expect(calls[2]?.prompt).toContain("Inspect current files and prior conversation before editing");
  expect(await readFile(file, "utf8")).toBe("partial work");
  expect(reloaded.turns.map(turn => turn.result)).toEqual([
    "Earlier result", "Error: internet connection down", "Finished remaining work",
  ]);
  expect(retryableTurn(reloaded)).toBeUndefined();
  expect(reloaded.deferredTurn).toBeUndefined();
  expect(retryableTurn((await store.load(dir, session.id))!)).toBeUndefined();
});

it("restores completed conversation when a connection fails before a thread starts", async () => {
  dir = await mkdtemp(join(tmpdir(), "pace-retry-"));
  const session = newSession(dir, "manual");
  session.route = { model: "gpt-6-sol", effort: "high" };
  session.turns.push({ prompt: "Earlier request", result: "Earlier result", at: new Date().toISOString() });
  const config: Config = { routingMode: "manual", defaultRoute: session.route, models: [{ model: "gpt-6-sol", efforts: ["high"] }] };
  const calls: string[] = [];
  const runner: CodexRunner = { async run(prompt, _project, _route, threadId) {
    expect(threadId).toBeUndefined();
    calls.push(prompt);
    if (calls.length === 1) throw new Error("internet connection down");
    return { threadId: "new-thread", result: "Done", completed: true };
  } };
  const store = new PaceStore(dir);
  const orchestrator = new Orchestrator(store, runner);
  await expect(orchestrator.turn("Continue feature", session, config, () => {})).rejects.toThrow("internet connection down");
  const reloaded = (await store.load(dir, session.id))!;
  await orchestrator.turn(retryableTurn(reloaded)!.prompt, reloaded, config, () => {});
  expect(calls[1]).toContain('"user":"Earlier request","assistant":"Earlier result"');
  expect(calls[1]).toContain("Inspect current files and prior conversation before editing");
  expect(calls[1]).not.toContain("internet connection down");
  expect(reloaded.threadId).toBe("new-thread");
});
