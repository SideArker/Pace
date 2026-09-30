import { PassThrough, Writable } from "node:stream";
import React from "react";
import { Box, render, Static, Text } from "ink";
import { describe, expect, it } from "vitest";
import { splitTranscript, Transcript, type Line } from "../src/components/Transcript.js";

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

function View({ lines, status }: { lines: Line[]; status: string }) {
  const { history, live } = splitTranscript(lines);
  return <Box flexDirection="column">
    <Static items={history}>{group => <Transcript key={group[0]?.id} lines={group} outputsExpanded detailsExpanded />}</Static>
    <Transcript lines={live.slice(-3)} outputsExpanded={false} detailsExpanded={false} livePreview />
    <Text>{status}</Text>
  </Box>;
}

describe("native terminal history", () => {
  it("appends settled activity without clearing or repainting earlier history", async () => {
    const stdout = new TerminalOutput();
    const stdin = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode: (enabled: boolean) => void };
    stdin.isTTY = true;
    stdin.setRawMode = () => {};
    const lines: Line[] = [
      { id: 1, role: "you", text: "Previous question", spaceBefore: false },
      { id: 2, role: "activity", text: "Running: build", spaceBefore: false, sourceId: "build", activity: { category: "command", completed: false } },
    ];
    const instance = render(<View lines={lines} status="Working" />, {
      stdin, stdout, stderr: new PassThrough(), interactive: true, patchConsole: false,
      alternateScreen: false, maxFps: 1000,
    });
    try {
      await instance.waitUntilRenderFlush();
      instance.rerender(<View lines={[lines[0]!, { ...lines[1]!, text: "Running: build (50%)" }]} status="Working" />);
      await instance.waitUntilRenderFlush();
      instance.rerender(<View lines={[lines[0]!, { ...lines[1]!, text: "Ran: build", activity: { category: "command", completed: true } }]} status="Ready" />);
      await instance.waitUntilRenderFlush();
    } finally {
      instance.unmount();
    }

    const output = stdout.writes.join("");
    expect(output.match(/Previous question/g)).toHaveLength(1);
    expect(output).toContain("</> build");
    expect(output).not.toContain("\u001b[2J");
    expect(output).not.toContain("\u001b[?1049h");
  });

  it("keeps a large running file edit inside the live redraw area", async () => {
    const stdout = new TerminalOutput();
    const stdin = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode: (enabled: boolean) => void };
    stdin.isTTY = true;
    stdin.setRawMode = () => {};
    const detail = Array.from({ length: 100 }, (_, index) => `+changed line ${index}`).join("\n");
    const lines: Line[] = [
      { id: 1, role: "you", text: "Review this edit", spaceBefore: false },
      { id: 2, role: "activity", text: "Editing files", spaceBefore: false, activity: { category: "files", detail, completed: false } },
    ];
    const instance = render(<View lines={lines} status="Working" />, {
      stdin, stdout, stderr: new PassThrough(), interactive: true, patchConsole: false,
      alternateScreen: false, maxFps: 1000,
    });
    let runningOutput = "";
    try {
      await instance.waitUntilRenderFlush();
      instance.rerender(<View lines={[lines[0]!, { ...lines[1]!, text: "Edited files" }]} status="Working" />);
      await instance.waitUntilRenderFlush();
      runningOutput = stdout.writes.join("");
      instance.rerender(<View lines={[lines[0]!, { ...lines[1]!, text: "Edited files", activity: { category: "files", detail, completed: true } }]} status="Ready" />);
      await instance.waitUntilRenderFlush();
    } finally {
      instance.unmount();
    }

    const output = stdout.writes.join("");
    expect(runningOutput).toContain("changed line 99");
    expect(runningOutput).not.toContain("changed line 0");
    expect(output).toContain("changed line 0");
    expect(output).not.toContain("\u001b[2J");
  });
});
