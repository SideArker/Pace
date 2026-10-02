import React from "react";
import { PassThrough, Writable } from "node:stream";
import { render, renderToString } from "ink";
import { expect, it } from "vitest";
import { QuestionPanel } from "../src/components/QuestionPanel.js";

it("shows an agent question with choices and an editable answer", () => {
  const output = renderToString(<QuestionPanel questions={[{
    id: "scope", header: "Scope", question: "Which files should I edit?",
    options: [{ label: "All files", description: "Include generated files" }],
    isOther: true, isSecret: false,
  }]} onSubmit={() => {}} />, { columns: 48 });
  expect(output).toContain("Agent question 1/1 · Scope");
  expect(output).toContain("Which files should I edit?");
  expect(output).toContain("All files");
  expect(output).toContain("Other:");
  expect(output).toContain("Esc twice cancel");
});

it("shows a free text answer field in a narrow terminal", () => {
  const output = renderToString(<QuestionPanel questions={[{
    id: "note", header: "Note", question: "What should I know?",
    options: [], isOther: false, isSecret: true,
  }]} onSubmit={() => {}} />, { columns: 30 });
  expect(output).toContain("What should I know?");
  expect(output).toContain("Answer:");
});

it("sends selected and typed answers for consecutive questions", async () => {
  class Output extends Writable {
    isTTY = true;
    columns = 80;
    rows = 24;
    override _write(_chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void) { done(); }
  }
  const stdin = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode: (enabled: boolean) => void; ref: () => void; unref: () => void };
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};
  let result: unknown;
  const instance = render(<QuestionPanel questions={[
    { id: "scope", header: "Scope", question: "Which scope?", options: [{ label: "All", description: "" }], isOther: true, isSecret: false },
    { id: "note", header: "Note", question: "Any note?", options: [], isOther: false, isSecret: false },
  ]} onSubmit={answers => { result = answers; }} />, {
    stdin, stdout: new Output(), stderr: new PassThrough(), interactive: true, patchConsole: false, alternateScreen: false,
  });
  try {
    await instance.waitUntilRenderFlush();
    stdin.write("\r");
    await new Promise(resolve => setTimeout(resolve, 10));
    await instance.waitUntilRenderFlush();
    stdin.write("Please keep tests");
    await new Promise(resolve => setTimeout(resolve, 10));
    await instance.waitUntilRenderFlush();
    stdin.write("\r");
    await new Promise(resolve => setTimeout(resolve, 10));
    await instance.waitUntilRenderFlush();
  } finally { instance.unmount(); }
  expect(result).toEqual({ scope: { answers: ["All"] }, note: { answers: ["Please keep tests"] } });
});
