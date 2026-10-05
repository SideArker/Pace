import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTurnRunner } from "../src/components/turn-runner.js";
import { Orchestrator } from "../src/core/orchestrator.js";
import { PromptQueue } from "../src/core/prompt-queue.js";
import { PaceStore, newSession } from "../src/core/sessions.js";
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
  expect(lines.join("\n")).toContain("Pace saved this request and will resume it");

  queue.clear(session.id);
  await runTurn(session.deferredTurn!.prompt, session, config);
  expect(calls[1]).toContain("Inspect current files and prior conversation before editing");
  expect(session.deferredTurn).toBeUndefined();
  expect((await store.latest(session.projectPath))?.deferredTurn).toBeUndefined();
});
