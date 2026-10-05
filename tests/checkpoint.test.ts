import { expect, it } from "vitest";
import { CHECKPOINT_MAX_CHARS, checkpointDue, checkpointHandoff, createCheckpointIfDue, parseCheckpoint } from "../src/core/checkpoint.js";
import { newSession, undoConversationTurn } from "../src/core/sessions.js";
import type { CheckpointNote } from "../src/shared/types.js";
import type { CodexRunner } from "../src/integrations/codex.js";

const note: CheckpointNote = {
  complete: true,
  goal: "Finish parser change", constraints: ["Keep copy on parse"],
  findings: [{ file: "src/parser.ts:12", detail: "Parser returns a clone" }],
  changes: [{ file: "src/parser.ts", detail: "Added the new branch" }],
  checks: [{ command: "npm test", outcome: "Passed" }],
  unfinished: ["Add error case"], questions: [], risks: ["No integration check yet"],
};

it("validates the complete handoff and includes recent exchanges", () => {
  const parsed = parseCheckpoint(JSON.stringify(note));
  const prompt = checkpointHandoff(parsed, [{ user: "earlier", assistant: "result" }], "Finish it");
  expect(prompt).toContain("copy on parse");
  expect(prompt).toContain("earlier");
  expect(prompt).toContain("Finish it");
});

it("rejects missing sections and oversize notes instead of truncating them", () => {
  expect(() => parseCheckpoint(JSON.stringify({ ...note, constraints: undefined }))).toThrow("structured fields");
  expect(() => parseCheckpoint(JSON.stringify({ ...note, complete: false }))).toThrow("structured fields");
  expect(() => parseCheckpoint(JSON.stringify({ ...note, goal: "x".repeat(CHECKPOINT_MAX_CHARS) }))).toThrow("exceeds");
});

it("requests a checkpoint before retention and invalidates it after undo", () => {
  const session = newSession(process.cwd(), "manual");
  session.threadId = "thread-1";
  session.turns = Array.from({ length: 16 }, (_, index) => ({ prompt: `p${index}`, result: `r${index}`, at: `2026-01-${String(index + 1).padStart(2, "0")}` }));
  expect(checkpointDue(session)).toBe(true);
  session.checkpoint = { createdAt: "2026-02-01", sourceTurnAt: session.turns.at(-1)!.at,
    threadId: "thread-1", route: {}, note, durationMs: 100 };
  expect(checkpointDue(session)).toBe(false);
  session.turns.push(...Array.from({ length: 4 }, (_, index) => ({ prompt: `later${index}`, result: "done", at: `2026-02-0${index + 2}` })));
  expect(checkpointDue(session)).toBe(true);
  undoConversationTurn(session);
  expect(session.checkpoint).toBeUndefined();
});

it("checkpoints early when measured context reaches 75 percent", () => {
  const session = newSession(process.cwd(), "manual");
  session.threadId = "thread-1";
  session.route = { model: "gpt-6-sol", effort: "high" };
  session.threadTurnCount = 3;
  session.turns = [{ prompt: "work", result: "done", at: "turn-1" }];
  session.contextByThread = { "thread-1": { tokens: 74_000, windowTokens: 100_000, model: "gpt-6-sol" } };
  expect(checkpointDue(session)).toBe(false);
  session.contextByThread["thread-1"]!.tokens = 75_000;
  expect(checkpointDue(session)).toBe(true);
});

it("creates a checkpoint in the current thread and records both validation attempts", async () => {
  const session = newSession(process.cwd(), "manual");
  session.threadId = "thread-1";
  session.route = { model: "gpt-6-sol", effort: "medium" };
  session.turns = Array.from({ length: 16 }, (_, index) => ({ prompt: `p${index}`, result: `r${index}`, at: `turn-${index}` }));
  let calls = 0;
  const usage = { input_tokens: 100, cached_input_tokens: 25, cache_write_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 0 };
  const runner: CodexRunner = { async run(_prompt, _project, _route, threadId, _progress, _signal, mode) {
    calls++;
    expect(threadId).toBe("thread-1");
    expect(mode).toBe("main");
    return { threadId, result: calls === 1 ? "{}" : JSON.stringify(note), completed: true, usage,
      context: { tokens: 120, windowTokens: 1000, model: "gpt-6-sol" } };
  } };
  const checkpoint = await createCheckpointIfDue(session, runner, () => {});
  expect(checkpoint?.sourceTurnAt).toBe("turn-15");
  expect(checkpoint?.note.constraints).toContain("Keep copy on parse");
  expect(checkpoint?.usage?.input_tokens).toBe(200);
  expect(checkpoint?.estimatedCostUsd).toBeGreaterThan(0);
  expect(session.checkpointGenerations?.map(item => item.outcome)).toEqual(["invalid", "valid"]);
  expect(session.contextByThread?.["thread-1"]?.tokens).toBe(120);
  expect(checkpointDue(session)).toBe(false);
});

it("waits four turns after a failed generation before retrying", () => {
  const session = newSession(process.cwd(), "manual");
  session.threadId = "thread-1";
  session.turns = Array.from({ length: 16 }, (_, index) => ({ prompt: `p${index}`, result: `r${index}`, at: `turn-${index}` }));
  session.checkpointGenerations = [{ at: "now", sourceTurnAt: "turn-15", threadId: "thread-1",
    route: {}, durationMs: 100, outcome: "invalid" }];
  expect(checkpointDue(session)).toBe(false);
  session.turns.push(...Array.from({ length: 4 }, (_, index) => ({ prompt: `next-${index}`, result: "r", at: `next-${index}` })));
  expect(checkpointDue(session)).toBe(true);
});
