import { expect, it } from "vitest";
import { CHECKPOINT_MAX_CHARS, checkpointHandoff, parseCheckpoint } from "../src/core/checkpoint.js";

const note = {
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
