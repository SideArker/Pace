import { expect, it } from "vitest";
import { CHECKPOINT_MAX_CHARS, checkpointDue, checkpointHandoff, parseCheckpoint } from "../src/core/checkpoint.js";
import { newSession, undoConversationTurn } from "../src/core/sessions.js";
import type { CheckpointNote } from "../src/shared/types.js";

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
