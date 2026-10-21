import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSession, parseSessionSummary } from "../src/core/session-record.js";
import { newSession, PaceStore } from "../src/core/sessions.js";
import { validOperation } from "../src/core/operations.js";
import type { OperationIntent, Session, StageAttempt } from "../src/shared/types.js";

let root: string;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });
function sample(): Session {
  const session = newSession("/example/project", "auto");
  session.revision = 4;
  session.activeTask = { id: "task", originalRequest: "Finish implementation", instructions: ["Keep public API"], latestOutcome: "Tests remain", assessment: "partial", workflow: {
    version: 1, generation: 1, shape: "scout_plan", stage: "plan", mainRoute: { model: "gpt-6-sol", effort: "high" }, mainThreadId: "main-thread", scoutHandoff: "Verified findings", source: "vex", needsAssessment: false,
  } };
  const usage = { input_tokens: 100, cached_input_tokens: 50, cache_write_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 10 };
  session.attempts = [{ id: "attempt", taskId: "task", generation: 1, stage: "plan", role: "main", status: "completed", route: { model: "gpt-6-sol", effort: "high" }, threadId: "main-thread", turnId: "turn", startedAt: "start", finishedAt: "finish", durationMs: 500, result: "Draft", usage, knownUsage: usage, usageComplete: true, estimatedCostUsd: 0.001, knownCostUsd: 0.001, observations: [{ kind: "activity", text: "Read files" }, { kind: "tasks", items: [{ text: "Verify", completed: false }] }, { kind: "answer", text: "Draft" }, { kind: "artifacts", paths: ["artifacts/plan.md"] }], assessment: { value: "partial", evidence: 4, decisionId: "decision" } }];
  session.controlDecisions = [{ id: "decision", taskId: "task", attemptId: "attempt", stage: "plan", role: "main", objective: "completion", choice: "partial", confidence: 0.8, probabilities: { partial: 0.8, closed: 0.2 }, durationMs: 20, at: "now", source: "vex", contextAction: "continue" }];
  session.sideAnswers = [{ id: "side", taskId: "task", attemptId: "side-attempt", question: "Explain", snapshotAt: "now", result: "Answer", route: { model: "gpt-6-luna", effort: "medium" }, threadId: "side-thread", adopted: true }];
  session.verifier = { route: { model: "gpt-6-sol", effort: "medium" }, threadId: "verifier-thread", threadTurnCount: 2, context: { tokens: 500, windowTokens: 1000, model: "gpt-6-sol" }, tasks: [{ id: "v", text: "Review plan", completed: false, source: "agent" }] };
  session.executionSource = { sessionId: randomUUID(), taskId: "source-task", artifact: "artifacts/source.pace-plan.md", plan: "Full source plan" };
  session.queuedPrompts = [{ id: randomUUID(), text: "Use finding", intent: "adopt_side", sessionId: session.id, taskId: "task", role: "main", sourceSideId: "side" }];
  session.deferredTurn = { prompt: "Use finding", retryAt: "2026-10-22T12:00:00Z", attempt: 1, reason: "network", intent: "adopt_side", displayPrompt: "Forward finding" };
  session.deferredTurn.operation = structuredClone(session.queuedPrompts[0] as import("../src/shared/types.js").QueuedOperation);
  session.turns = [{ prompt: "Explain", result: "Answer", at: "now", intent: "aside", operation: structuredClone(session.deferredTurn.operation) }];
  return session;
}

it("round-trips workflow, all attempts, assessment evidence, role and source metadata", async () => {
  root = await mkdtemp(join(tmpdir(), "pace-workflow-session-"));
  const store = new PaceStore(root); const session = sample(); delete session.revision;
  await store.save(session);
  const loaded = await new PaceStore(root).load(session.projectPath, session.id);
  expect(loaded).toEqual(session);
  const summary = (await store.listSummaries(session.projectPath))[0]!;
  for (const key of ["revision", "activeTask", "attempts", "controlDecisions", "sideAnswers", "verifier", "executionSource", "queuedPrompts", "deferredTurn"] as const)
    expect(summary[key]).toEqual(session[key]);
});

it("normalizes legacy queue strings without interpreting command-looking text", () => {
  const legacy = newSession("/example/project", "manual");
  legacy.queuedPrompts = ["/verify", "/execute", "Use side answer", "/verify"];
  const first = parseSession(legacy, legacy.projectPath)!;
  const second = parseSessionSummary(legacy, legacy.projectPath)!;
  expect(first.queuedPrompts).toEqual(second.queuedPrompts);
  expect(first.queuedPrompts!.every(validOperation)).toBe(true);
  expect(first.queuedPrompts!.map(item => typeof item === "string" ? item : item.text)).toEqual(legacy.queuedPrompts);
  expect(new Set(first.queuedPrompts!.map(item => typeof item === "string" ? item : item.id)).size).toBe(4);
  for (const item of first.queuedPrompts!) expect(item).toMatchObject({ sessionId: legacy.id, role: "main" });
  for (const item of first.queuedPrompts!) expect(item).not.toHaveProperty("intent");
  expect(first.activeTask).toBeUndefined(); expect(first.attempts).toBeUndefined();
  expect(legacy.queuedPrompts[0]).toBe("/verify");
});

it("keeps queue operation identity, intent and recipient across restart and rewritten storage", async () => {
  root = await mkdtemp(join(tmpdir(), "pace-queue-migration-"));
  const store = new PaceStore(root); const session = newSession("/example/project", "manual");
  session.queuedPrompts = ["legacy", { id: randomUUID(), text: "Verify", sessionId: session.id, taskId: "task", role: "verifier", intent: "verify_plan", sourceSideId: "side" }];
  await store.save(session);
  const first = (await new PaceStore(root).load(session.projectPath, session.id))!;
  const second = (await new PaceStore(root).load(session.projectPath, session.id))!;
  expect(first.queuedPrompts).toEqual(second.queuedPrompts);
  await store.saveChanges(first);
  expect((await new PaceStore(root).load(session.projectPath, session.id))!.queuedPrompts).toEqual(first.queuedPrompts);
});

for (const intent of ["verify_plan", "execute_plan", "revise_plan", "continue_verify", "aside", "adopt_side"] satisfies OperationIntent[])
  it(`retains ${intent} in turns and deferred operations`, () => {
    const session = sample(); session.turns[0]!.intent = intent; session.deferredTurn!.intent = intent;
    expect(parseSession(session, session.projectPath)?.turns[0]!.intent).toBe(intent);
    expect(parseSessionSummary(session, session.projectPath)?.deferredTurn!.intent).toBe(intent);
  });

for (const status of ["pending", "running", "completed", "failed", "cancelled", "awaiting_user"] satisfies StageAttempt["status"][])
  it(`preserves ${status} attempts without guessing outcome or usage`, () => {
    const session = sample(); const attempt = session.attempts![0]!;
    attempt.status = status; delete attempt.usage; delete attempt.estimatedCostUsd; attempt.usageComplete = false;
    const loaded = parseSession(session, session.projectPath)!;
    expect(loaded.attempts![0]).toEqual(attempt);
    expect(loaded.attempts![0]!.estimatedCostUsd).toBeUndefined();
  });

const corruptions: [string, (session: Session) => void][] = [
  ["revision", session => { session.revision = -1; }],
  ["fractional revision", session => { session.revision = 1.5; }],
  ["workflow version", session => { (session.activeTask!.workflow as unknown as { version: number }).version = 2; }],
  ["workflow shape", session => { Object.assign(session.activeTask!.workflow!, { shape: "unknown" }); }],
  ["workflow route", session => { Object.assign(session.activeTask!.workflow!.mainRoute!, { effort: "invalid" }); }],
  ["assessment", session => { Object.assign(session.activeTask!, { assessment: "complete" }); }],
  ["attempt role", session => { Object.assign(session.attempts![0]!, { role: "planner" }); }],
  ["attempt status", session => { Object.assign(session.attempts![0]!, { status: "unknown" }); }],
  ["attempt usage", session => { session.attempts![0]!.usage!.input_tokens = -1; }],
  ["attempt cost", session => { session.attempts![0]!.knownCostUsd = Number.NaN; }],
  ["attempt observation", session => { Object.assign(session.attempts![0]!.observations[0]!, { kind: "unknown" }); }],
  ["attempt evidence", session => { session.attempts![0]!.assessment!.evidence = -1; }],
  ["assessment decision reference", session => { session.attempts![0]!.assessment!.decisionId = ""; }],
  ["duplicate attempts", session => { session.attempts!.push(structuredClone(session.attempts![0]!)); }],
  ["control probability", session => { session.controlDecisions![0]!.probabilities.closed = 1.1; }],
  ["control context", session => { Object.assign(session.controlDecisions![0]!, { contextAction: "fresh" }); }],
  ["side attempt reference", session => { session.sideAnswers![0]!.attemptId = ""; }],
  ["side route", session => { Object.assign(session.sideAnswers![0]!.route, { effort: "invalid" }); }],
  ["verifier context", session => { session.verifier!.context!.windowTokens = 0; }],
  ["verifier task", session => { Object.assign(session.verifier!.tasks![0]!, { completed: "yes" }); }],
  ["execution plan", session => { Object.assign(session.executionSource!, { plan: 3 }); }],
  ["queue role", session => { Object.assign(session.queuedPrompts![0]!, { role: "unknown" }); }],
  ["queue intent", session => { Object.assign(session.queuedPrompts![0]!, { intent: "unknown" }); }],
  ["deferred intent", session => { Object.assign(session.deferredTurn!, { intent: "unknown" }); }],
  ["deferred operation", session => { Object.assign(session.deferredTurn!.operation!, { role: "unknown" }); }],
];
for (const [name, corrupt] of corruptions) it(`rejects malformed ${name} in full and summary reads`, () => {
  const session = sample(); corrupt(session);
  expect(parseSession(session, session.projectPath)).toBeUndefined();
  expect(parseSessionSummary(session, session.projectPath)).toBeUndefined();
});

it("keeps legacy task caps and rejects new invalid intent without silently discarding it", () => {
  const session = newSession("/example/project", "auto");
  session.activeTask = { originalRequest: "x".repeat(8000), instructions: [] };
  expect(parseSession(session, session.projectPath)).toBeDefined();
  session.activeTask.originalRequest += "x";
  expect(parseSession(session, session.projectPath)).toBeUndefined();
  delete session.activeTask;
  session.turns = [{ prompt: "Work", result: "Result", at: "now", intent: "unknown" as OperationIntent }];
  expect(parseSession(session, session.projectPath)).toBeUndefined();
});

it("rejects malformed visible turn operation metadata", () => {
  const session = sample(); Object.assign(session.turns[0]!.operation!, { intent: "unknown" });
  expect(parseSession(session, session.projectPath)).toBeUndefined();
});
