import React from "react";
import { PassThrough, Writable } from "node:stream";
import type { ReadStream, WriteStream } from "node:tty";
import { render } from "ink";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QuestionPanel } from "../src/components/QuestionPanel.js";
import type { UserAnswers, UserQuestion } from "../src/integrations/codex-types.js";

class TerminalOutput extends Writable {
  isTTY = true;
  columns = 80;
  rows = 24;
  writes: string[] = [];
  override _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void) {
    this.writes.push(chunk.toString());
    done();
  }
}

const questions: UserQuestion[] = [{
  id: "scope", header: "Scope", question: "Which scope?", isOther: true, isSecret: false,
  options: [{ label: "Small", description: "One package" }, { label: "All", description: "Every package" }],
}];
const instances: Array<ReturnType<typeof render>> = [];
afterEach(() => { for (const instance of instances.splice(0)) instance.unmount(); });

async function panel(items: UserQuestion[] = questions, isActive = true) {
  const onSubmit = vi.fn<(answers: UserAnswers) => void>();
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean; setRawMode: (value: boolean) => void; ref: () => void; unref: () => void;
  };
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};
  const output = new TerminalOutput();
  const instance = render(<QuestionPanel questions={items} onSubmit={onSubmit} isActive={isActive} />, {
    stdin: stdin as unknown as ReadStream,
    stdout: output as unknown as WriteStream,
    stderr: new PassThrough() as unknown as WriteStream,
    patchConsole: false, alternateScreen: false, maxFps: 1000,
  });
  instances.push(instance);
  await instance.waitUntilRenderFlush();
  return {
    onSubmit, instance,
    async send(value: string) {
      output.writes.length = 0;
      stdin.write(value);
      await new Promise(resolve => setTimeout(resolve, 10));
      await instance.waitUntilRenderFlush();
    },
    frame: () => output.writes.join(""),
  };
}

describe("agent question keyboard interaction", () => {
  it("submits the first choice by default", async () => {
    const ui = await panel();
    await ui.send("\r");
    expect(ui.onSubmit).toHaveBeenCalledWith({ scope: { answers: ["Small"] } });
  });

  it("moves to the second choice with Down", async () => {
    const ui = await panel();
    await ui.send("\x1b[B");
    expect(ui.frame()).toContain("❯ All");
    await ui.send("\r");
    expect(ui.onSubmit).toHaveBeenCalledWith({ scope: { answers: ["All"] } });
  });

  it("wraps upward from the first choice to Other", async () => {
    const ui = await panel();
    await ui.send("\x1b[A");
    expect(ui.frame()).toContain("❯ Other:");
    await ui.send("\r");
    expect(ui.onSubmit).not.toHaveBeenCalled();
  });

  it("cycles through choices and Other with Tab", async () => {
    const ui = await panel();
    await ui.send("\t");
    expect(ui.frame()).toContain("❯ All");
    await ui.send("\t");
    expect(ui.frame()).toContain("❯ Other:");
    await ui.send("\t");
    expect(ui.frame()).toContain("❯ Small");
  });

  it("typing selects Other and trims its answer on submit", async () => {
    const ui = await panel();
    await ui.send("  Only docs  ");
    expect(ui.frame()).toContain("❯ Other:   Only docs  ▌");
    await ui.send("\r");
    expect(ui.onSubmit).toHaveBeenCalledWith({ scope: { answers: ["Only docs"] } });
  });

  it("Backspace edits a free text answer", async () => {
    const ui = await panel([{ ...questions[0]!, options: [] }]);
    await ui.send("yesx");
    await ui.send("\x7f");
    expect(ui.frame()).toContain("Answer: yes▌");
    await ui.send("\r");
    expect(ui.onSubmit).toHaveBeenCalledWith({ scope: { answers: ["yes"] } });
  });

  it("does not submit blank free text", async () => {
    const ui = await panel([{ ...questions[0]!, options: [] }]);
    await ui.send("   ");
    await ui.send("\r");
    expect(ui.onSubmit).not.toHaveBeenCalled();
  });

  it("hides a secret answer while retaining the submitted value", async () => {
    const ui = await panel([{ ...questions[0]!, options: [], isSecret: true }]);
    await ui.send("secret");
    expect(ui.frame()).toContain("••••••▌");
    expect(ui.frame()).not.toContain("secret");
    await ui.send("\r");
    expect(ui.onSubmit).toHaveBeenCalledWith({ scope: { answers: ["secret"] } });
  });

  it("ignores keyboard input while another UI element is active", async () => {
    const ui = await panel(questions, false);
    await ui.send("\r");
    expect(ui.onSubmit).not.toHaveBeenCalled();
  });

  it("does not submit on Escape or Shift+Tab", async () => {
    const ui = await panel();
    await ui.send("\x1b");
    await ui.send("\x1b[Z");
    expect(ui.onSubmit).not.toHaveBeenCalled();
  });

  it("resets the selection for a following free text question", async () => {
    const ui = await panel([
      questions[0]!,
      { id: "note", header: "Note", question: "Any note?", options: [], isOther: false, isSecret: false },
    ]);
    await ui.send("\x1b[B");
    await ui.send("\r");
    expect(ui.frame()).toContain("Agent question 2/2 · Note");
    expect(ui.frame()).toContain("❯ Answer:");
    await ui.send("Next");
    await ui.send("\r");
    expect(ui.onSubmit).toHaveBeenCalledWith({
      scope: { answers: ["All"] }, note: { answers: ["Next"] },
    });
  });
});
