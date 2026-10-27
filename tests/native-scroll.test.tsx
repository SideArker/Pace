import { PassThrough, Writable } from "node:stream";
import React from "react";
import { Box, render, Static, Text } from "ink";
import { describe, expect, it } from "vitest";
import { splitTranscript, Transcript, type Line } from "../src/components/Transcript.js";
import { HeaderLogo } from "../src/components/Header.js";

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

function View({ lines, status, resetKey = 0, showHeader = true, expanded = false }: { lines: Line[]; status: string; resetKey?: number; showHeader?: boolean; expanded?: boolean }) {
  const { history, live } = splitTranscript(lines);
  return <Box flexDirection="column">
    <Static key={resetKey} items={[...(showHeader ? [{ kind: "logo" as const }] : []), ...history.map(group => ({ kind: "lines" as const, group }))]}>
      {item => item.kind === "logo" ? <HeaderLogo key="logo" width={80} /> : <Transcript key={item.group[0]?.id} lines={item.group} outputsExpanded={expanded} detailsExpanded={expanded} />}
    </Static>
    <Transcript lines={live.slice(-3)} outputsExpanded={expanded} detailsExpanded={expanded} livePreview />
    <Text>{status}</Text>
  </Box>;
}

describe("native terminal history", () => {
  it("redraws streamed text and appends only its authoritative completion to history", async () => {
    const stdout = new TerminalOutput();
    const stdin = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode: (enabled: boolean) => void };
    stdin.isTTY = true;
    stdin.setRawMode = () => {};
    const question: Line = { id: 1, role: "you", text: "Inspect feature", spaceBefore: false };
    const partial: Line = { id: 2, role: "codex", text: "Inspecting", spaceBefore: false, streaming: true };
    const instance = render(<View lines={[question, partial]} status="Working" showHeader={false} />, {
      stdin, stdout, stderr: new PassThrough(), interactive: true, patchConsole: false,
      alternateScreen: false, maxFps: 1000,
    });
    try {
      await instance.waitUntilRenderFlush();
      instance.rerender(<View lines={[question, { ...partial, text: "Inspecting files" }]} status="Working" showHeader={false} />);
      await instance.waitUntilRenderFlush();
      const final = { ...partial, text: "Inspection finished.", streaming: false };
      instance.rerender(<View lines={[question, final]} status="Ready" showHeader={false} />);
      await instance.waitUntilRenderFlush();
      instance.rerender(<View lines={[question, final]} status="Waiting" showHeader={false} />);
      await instance.waitUntilRenderFlush();
    } finally { instance.unmount(); }
    const output = stdout.writes.join("");
    expect(output.match(/Inspect feature/g)).toHaveLength(1);
    expect(output.match(/Inspection finished\./g)).toHaveLength(1);
    expect(output).toContain("Inspecting files");
    expect(output).not.toContain("\x1b[2J");
  });

  it("places a new view at top after clearing old history", async () => {
    const stdout = new TerminalOutput();
    const stdin = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode: (enabled: boolean) => void };
    stdin.isTTY = true;
    stdin.setRawMode = () => {};
    const oldLines: Line[] = Array.from({ length: 35 }, (_, id) => ({ id, role: "info", text: `old-${id}`, spaceBefore: false }));
    const instance = render(<View lines={oldLines} status="Old prompt" />, {
      stdin, stdout, stderr: new PassThrough(), interactive: true, patchConsole: false,
      alternateScreen: false, maxFps: 1000,
    });
    let afterClear = "";
    try {
      await instance.waitUntilRenderFlush();
      instance.clear();
      stdout.write("\x1b[3J\x1b[2J\x1b[H");
      instance.rerender(<View lines={[]} status="New prompt" resetKey={1} />);
      await instance.waitUntilRenderFlush();
      instance.rerender(<View lines={[{ id: 36, role: "you", text: "New request", spaceBefore: false }]} status="Working" resetKey={1} />);
      await instance.waitUntilRenderFlush();
      afterClear = stdout.writes.join("").split("\x1b[3J\x1b[2J\x1b[H")[1] ?? "";
    } finally {
      instance.unmount();
    }
    expect(afterClear).toContain("New prompt");
    expect(afterClear).not.toContain("old-0");
    expect(afterClear).toContain("██████");
    expect(afterClear.indexOf("New request")).toBeGreaterThan(afterClear.indexOf("██████"));
  });

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
    expect(output.indexOf("Previous question")).toBeGreaterThan(output.indexOf("█"));
    expect(output.match(/Previous question/g)).toHaveLength(1);
    expect(output).toContain("build");
    expect(output).not.toContain("\u001b[2J");
    expect(output).not.toContain("\u001b[?1049h");
  });

  it("redraws settled activity when details are toggled", async () => {
    const stdout = new TerminalOutput();
    const stdin = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode: (enabled: boolean) => void };
    stdin.isTTY = true;
    stdin.setRawMode = () => {};
    const lines: Line[] = [
      { id: 1, role: "activity", text: "Edited file", spaceBefore: false,
        activity: { category: "files", detail: "-old\n+new", completed: true } },
    ];
    const instance = render(<View lines={lines} status="Ready" showHeader={false} />, {
      stdin, stdout, stderr: new PassThrough(), interactive: true, patchConsole: false,
      alternateScreen: false, maxFps: 1000,
    });
    try {
      await instance.waitUntilRenderFlush();
      expect(stdout.writes.join("")).not.toContain("-old");
      instance.clear();
      stdout.write("\x1b[3J\x1b[2J\x1b[H");
      instance.rerender(<View lines={lines} status="Ready" showHeader={false} resetKey={1} expanded />);
      await instance.waitUntilRenderFlush();
      expect(stdout.writes.join("").split("\x1b[3J\x1b[2J\x1b[H")[1]).toContain("-old");
      instance.clear();
      stdout.write("\x1b[3J\x1b[2J\x1b[H");
      instance.rerender(<View lines={lines} status="Ready" showHeader={false} resetKey={2} />);
      await instance.waitUntilRenderFlush();
      expect(stdout.writes.join("").split("\x1b[3J\x1b[2J\x1b[H")[2]).not.toContain("-old");
    } finally {
      instance.unmount();
    }
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
    expect(runningOutput).not.toContain("changed line 99");
    expect(runningOutput).not.toContain("changed line 0");
    expect(output).not.toContain("changed line 0");
    expect(output).not.toContain("\u001b[2J");
  });
});
