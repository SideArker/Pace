import React from "react";
import { PassThrough, Writable } from "node:stream";
import { render, renderToString, Text } from "ink";
import { expect, it, vi } from "vitest";
import { Composer, commandRanges, commandToken, deleteDraftRange, deleteWordBackward, deleteWordForward, displayPastedBlocks, inputColumns, insertDraftText, insertPastedBlock, isAltBackspaceKey, isAltDeleteKey, isNewlineKey, markdownDraftRanges, paceGradient, skipPastedBlock, verticalCursor, visibleInputRows } from "../src/components/Composer.js";
import { ComposerFrame } from "../src/components/ComposerFrame.js";
import { newSession } from "../src/core/sessions.js";
import { commands, isRegisteredCommand, normalizeNewCommand } from "../src/components/App.js";

it("keeps ./clear as ordinary input while recognizing the supported command aliases", () => {
  expect(normalizeNewCommand("./new")).toBe("/new");
  expect(normalizeNewCommand(" ./new ")).toBe("/new");
  expect(normalizeNewCommand("./new extra")).toBe("/new extra");
  expect(normalizeNewCommand("./newfile")).toBe("./newfile");
  expect(normalizeNewCommand("./resume")).toBe("./resume");
  expect(normalizeNewCommand("/.resume")).toBe("/.resume");
  expect(normalizeNewCommand("/.clear")).toBe("/clear");
  expect(normalizeNewCommand(" /.clear ")).toBe("/clear");
  expect(normalizeNewCommand("./clear")).toBe("./clear");
  expect(normalizeNewCommand("./clear now")).toBe("./clear now");
  expect(normalizeNewCommand("/.new")).toBe("/new");
  expect(normalizeNewCommand("./approval")).toBe("/approval");
  expect(commands.filter(command => command.includes("clear"))).toEqual(["/clear"]);
  expect(commands).not.toContain("/resume");
  expect(commands).not.toContain("/usage");
  expect(isRegisteredCommand("/resume")).toBe(false);
  expect(isRegisteredCommand("/usage")).toBe(false);
});

it("shows pasted text directly below ten lines and a marker from ten lines", () => {
  for (const count of [1, 2, 9, 10, 11]) {
    const text = Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n");
    const pasted = insertPastedBlock("", 0, text, []);
    const shown = displayPastedBlocks(pasted.value, pasted.cursor, pasted.blocks);
    expect(shown.value).toBe(count < 10 ? text : `[Pasted ${count} lines]`);
    expect(shown.cursor).toBe(shown.value.length);
    expect(shown.markers).toHaveLength(count < 10 ? 0 : 1);
  }
});

it("deletes words forward and backward with word boundary awareness", () => {
  expect(deleteWordForward("hello world", 0)).toEqual({ value: " world", cursor: 0 });
  expect(deleteWordForward("hello world", 5)).toEqual({ value: "hello", cursor: 5 });
  expect(deleteWordForward("hello ./world", 5)).toEqual({ value: "helloworld", cursor: 5 });
  expect(deleteWordForward("hello", 5)).toEqual({ value: "hello", cursor: 5 });

  expect(deleteWordBackward("hello world", 11)).toEqual({ value: "hello ", cursor: 6 });
  expect(deleteWordBackward("hello world  ", 13)).toEqual({ value: "hello ", cursor: 6 });
  expect(deleteWordBackward("hello", 5)).toEqual({ value: "", cursor: 0 });
  expect(deleteWordBackward("hello", 0)).toEqual({ value: "hello", cursor: 0 });
});

it("recognizes Alt+Delete and Alt+Backspace combinations across formats", () => {
  expect(isAltDeleteKey("", { delete: true, meta: true, ctrl: false })).toBe(true);
  expect(isAltDeleteKey("", { delete: true, meta: false, ctrl: true })).toBe(true);
  expect(isAltDeleteKey("\x1b[3;3~", { delete: false, meta: false, ctrl: false })).toBe(true);
  expect(isAltDeleteKey("d", { delete: false, meta: true, ctrl: false })).toBe(true);
  expect(isAltDeleteKey("", { delete: true, meta: false, ctrl: false })).toBe(false);

  expect(isAltBackspaceKey("", { backspace: true, meta: true, ctrl: false })).toBe(true);
  expect(isAltBackspaceKey("\x1b\x7f", { backspace: false, meta: false, ctrl: false })).toBe(true);
  expect(isAltBackspaceKey("w", { backspace: false, meta: false, ctrl: true })).toBe(true);
  expect(isAltBackspaceKey("", { backspace: true, meta: false, ctrl: false })).toBe(false);
});

it("toggles ON-LAUNCH with Alt+A while plain a remains editable", async () => {
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
  const onChange = vi.fn();
  const onAutoLaunchToggle = vi.fn();
  function Harness() {
    const [value, setValue] = React.useState("");
    return React.createElement(Composer, {
      value, onChange: next => { onChange(next); setValue(next); }, onSubmit: () => {}, history: [], disabled: false, shellMode: false,
      placeholder: "Ask Pace", onComplete: () => {}, onAutoLaunchToggle, width: 80,
    });
  }
  const instance = render(React.createElement(Harness), { stdin, stdout: new Output(), stderr: new PassThrough(), interactive: true, patchConsole: false, alternateScreen: false });
  try {
    await instance.waitUntilRenderFlush();
    stdin.write("/");
    await instance.waitUntilRenderFlush();
    stdin.write("\x1ba");
    await instance.waitUntilRenderFlush();
    expect(onAutoLaunchToggle).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledTimes(1);
    stdin.write("a");
    await instance.waitUntilRenderFlush();
    expect(onChange).toHaveBeenCalledWith("/a");
  } finally { instance.unmount(); }
});

it("maps the PACE gradient across terminal columns", () => {
  expect(paceGradient(0, 80)).toBe("#59E6A7");
  expect(paceGradient(79, 80)).toBe("#38BDF8");
  expect(paceGradient(0, 20)).toBe("#59E6A7");
  expect(paceGradient(19, 20)).toBe("#38BDF8");
  expect(paceGradient(39.5, 80)).toBe("#3CD9A0");
});

it("tracks input position across wraps and newlines", () => {
  expect(inputColumns("abcde\nx", 8, false)).toEqual([3, 4, 5, 6, 3, 4, 3, 4]);
  expect(inputColumns("a", 20, true)).toEqual([10, 11]);
});

it("keeps long input bounded around the cursor", () => {
  const value = "abcdefghijklmnopqrst";
  expect(visibleInputRows(value, value.length, 5, 2)).toEqual([{ start: 10, end: 15 }, { start: 15, end: 20 }]);
  expect(visibleInputRows(value, 0, 5, 2)).toEqual([{ start: 0, end: 5 }, { start: 5, end: 10 }]);
  expect(visibleInputRows("first\nsecond", 5, 20, 2)).toEqual([{ start: 0, end: 5 }, { start: 6, end: 12 }]);
  expect(visibleInputRows("abcdefghij", 5, 5, 2)).toEqual([{ start: 0, end: 5 }, { start: 5, end: 10 }]);
  const long = "x".repeat(200);
  const fullScreenRows = visibleInputRows(long, long.length, 10, 17);
  expect(fullScreenRows).toHaveLength(17);
  expect(fullScreenRows[0]).toEqual({ start: 30, end: 40 });
  expect(fullScreenRows.at(-1)).toEqual({ start: 190, end: 200 });
});

it("shows a large paste as one block and removes it with one backspace", () => {
  const text = Array.from({ length: 10 }, (_, index) => `line${index}`).join("\n");
  const pasted = insertPastedBlock("before ", 7, text, []);
  expect(displayPastedBlocks(pasted.value, pasted.cursor, pasted.blocks)).toMatchObject({
    value: "before [Pasted 10 lines]", cursor: "before [Pasted 10 lines]".length,
  });
  expect(deleteDraftRange(pasted.value, pasted.cursor - 1, pasted.cursor, pasted.blocks)).toEqual({
    value: "before ", cursor: 7, blocks: [],
  });
  expect(skipPastedBlock(pasted.cursor - 1, "left", pasted.blocks)).toBe(7);
  const extended = insertDraftText(pasted.value, pasted.cursor, "!", pasted.blocks);
  expect(displayPastedBlocks(extended.value, extended.cursor, extended.blocks).value).toBe("before [Pasted 10 lines]!");
});

it("submits full pasted text while showing its marker", async () => {
  class Output extends Writable {
    isTTY = true;
    columns = 80;
    rows = 24;
    writes: string[] = [];
    override _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void) {
      this.writes.push(chunk.toString());
      done();
    }
  }
  const stdout = new Output();
  const stdin = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode: (enabled: boolean) => void; ref: () => void; unref: () => void };
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};
  let submitted = "";
  let currentDraft = "";
  const Harness = () => {
    const [draft, setDraft] = React.useState("");
    currentDraft = draft;
    return React.createElement(Composer, {
      value: draft, onChange: setDraft, onSubmit: text => { submitted = text; setDraft(""); },
      history: [], disabled: false, shellMode: false, placeholder: "Ask Pace", onComplete: () => {}, width: 78,
    });
  };
  const instance = render(React.createElement(Harness), {
    stdin, stdout, stderr: new PassThrough(), interactive: true, patchConsole: false, alternateScreen: false,
  });
  try {
    await instance.waitUntilRenderFlush();
    const largePaste = Array.from({ length: 10 }, (_, index) => `line${index}`).join("\n");
    stdin.write(`\x1b[200~${largePaste}\x1b[201~`);
    await new Promise(resolve => setTimeout(resolve, 10));
    await instance.waitUntilRenderFlush();
    expect(stdout.writes.join("")).toContain("[Pasted 10 lines]");
    expect(stdout.writes.join("")).not.toContain("line0");
    stdin.write("\r");
    await new Promise(resolve => setTimeout(resolve, 10));
    await instance.waitUntilRenderFlush();
    expect(submitted).toBe(largePaste);
    stdin.write(`\x1b[200~${largePaste}\x1b[201~`);
    await new Promise(resolve => setTimeout(resolve, 10));
    await instance.waitUntilRenderFlush();
    stdin.write("\x7f");
    await new Promise(resolve => setTimeout(resolve, 10));
    await instance.waitUntilRenderFlush();
    expect(currentDraft).toBe("");
  } finally { instance.unmount(); }
});

it("keeps the full context footer visible beside hints at medium widths", () => {
  for (const width of [112, 120, 140]) {
    const output = renderToString(React.createElement(ComposerFrame, {
      width, shellMode: false, approvalMode: "full-access", children: React.createElement(Text, null, "Input"),
    }), { columns: width });
    expect(output).toContain("type ! to run commands");
    expect(output).toContain("○ Context ? · auto · Full Access");
    expect(output.split("\n").every(line => line.length <= width)).toBe(true);
  }
});

it("recognizes modified Enter and Ctrl+J as newline input", () => {
  const key = { return: true, shift: false, ctrl: false, meta: false };
  expect(isNewlineKey("", key)).toBe(false);
  expect(isNewlineKey("", { ...key, shift: true })).toBe(true);
  expect(isNewlineKey("", { ...key, ctrl: true })).toBe(true);
  expect(isNewlineKey("", { ...key, meta: true })).toBe(true);
  expect(isNewlineKey("j", { ...key, return: false, ctrl: true })).toBe(true);
  expect(isNewlineKey("\n", { ...key, return: false })).toBe(true);
  expect(isNewlineKey("j", { ...key, return: false })).toBe(false);
  expect(isNewlineKey("[27;2;13~", { ...key, return: false })).toBe(true);
});

it("accepts three consecutive newline keys before submitting one draft", async () => {
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
  let currentDraft = "";
  let submitted = "";
  const Harness = () => {
    const [draft, setDraft] = React.useState("");
    currentDraft = draft;
    return React.createElement(Composer, {
      value: draft, onChange: setDraft, onSubmit: text => { submitted = text; setDraft(""); },
      history: [], disabled: false, shellMode: false, placeholder: "Ask Pace", onComplete: () => {}, width: 80,
    });
  };
  const instance = render(React.createElement(Harness), {
    stdin, stdout: new Output(), stderr: new PassThrough(), interactive: true, patchConsole: false, alternateScreen: false,
  });
  try {
    await instance.waitUntilRenderFlush();
    stdin.write("first");
    await instance.waitUntilRenderFlush();
    for (let index = 0; index < 3; index++) {
      stdin.write("\x0a");
      await instance.waitUntilRenderFlush();
      expect(currentDraft).toBe(`first${"\n".repeat(index + 1)}`);
    }
    for (let index = 0; index < 2; index++) {
      stdin.write("\x1b[13;2u");
      await instance.waitUntilRenderFlush();
      expect(currentDraft).toBe(`first${"\n".repeat(index + 4)}`);
    }
    stdin.write("last");
    await instance.waitUntilRenderFlush();
    stdin.write("\r");
    await instance.waitUntilRenderFlush();
    expect(submitted).toBe("first\n\n\n\n\nlast");
  } finally { instance.unmount(); }
});

it("preserves visible height for empty lines in multiline input", () => {
  const rendered = renderToString(React.createElement(Composer, {
    value: "first\n\nlast",
    onChange: () => {},
    onSubmit: () => {},
    history: [],
    disabled: false,
    shellMode: false,
    placeholder: "Ask Pace",
    onComplete: () => {},
    width: 80,
  }));
  const lines = rendered.split("\n");
  expect(lines.length).toBeGreaterThanOrEqual(3);
  expect(rendered).toContain("first");
  expect(rendered).toContain("last");
});

it("finds command tokens after text and newlines", () => {
  expect(commandToken("/mo")).toEqual({ start: 0, prefix: "/mo" });
  expect(commandToken("@rig")).toEqual({ start: 0, prefix: "@rig" });
  expect(commandToken("explain this /mo")).toEqual({ start: 13, prefix: "/mo" });
  expect(commandToken("first line\n/mo")).toEqual({ start: 11, prefix: "/mo" });
  expect(commandToken("first line\nmore /mo")).toEqual({ start: 16, prefix: "/mo" });
  expect(commandToken("review @rig")).toEqual({ start: 7, prefix: "@rig" });
  expect(commandToken("plain text")).toBeUndefined();
  expect(commandToken("/models option")).toBeUndefined();
});

it("styles completed inline Markdown while preserving editable source", () => {
  const value = "**bold** *italic* `code` ~~old~~";
  expect(markdownDraftRanges(value)).toEqual([
    { start: 2, end: 6, style: "bold" },
    { start: 10, end: 16, style: "italic" },
    { start: 19, end: 23, style: "code" },
    { start: 27, end: 30, style: "strike" },
  ]);
  const output = renderToString(React.createElement(Composer, {
    value, onChange: () => {}, onSubmit: () => {}, history: [], disabled: false, shellMode: false,
    placeholder: "Ask Pace", onComplete: () => {}, width: 80,
  }), { columns: 80 });
  expect(output).toContain(value);
  expect(markdownDraftRanges("**unfinished")).toEqual([]);
});

it("renders Markdown emphasis in the live editor without removing its syntax", async () => {
  const chalk = (await import("chalk")).default;
  const previousLevel = chalk.level;
  chalk.level = 3;
  class Output extends Writable {
    isTTY = true;
    columns = 80;
    rows = 24;
    writes: string[] = [];
    override _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void) {
      this.writes.push(chunk.toString());
      done();
    }
  }
  const stdin = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode: (enabled: boolean) => void; ref: () => void; unref: () => void };
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};
  const stdout = new Output();
  const instance = render(React.createElement(Composer, {
    value: "say **bold** and *italic*", onChange: () => {}, onSubmit: () => {}, history: [], disabled: false,
    shellMode: false, placeholder: "Ask Pace", onComplete: () => {}, width: 80,
  }), { stdin, stdout, stderr: new PassThrough(), interactive: true, patchConsole: false, alternateScreen: false });
  try {
    await instance.waitUntilRenderFlush();
    const output = stdout.writes.join("");
    const plain = output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
    expect(plain).toContain("**bold**");
    expect(plain).toContain("*italic*");
    expect(output).toMatch(/\x1b\[1m(?:\x1b\[[0-9;]*m)*bold/);
    expect(output).toMatch(/\x1b\[3m(?:\x1b\[[0-9;]*m)*italic/);
  } finally { instance.unmount(); chalk.level = previousLevel; }
});

it("marks only registered commands in multiline input", () => {
  const registered = ["/usage", "/models", "/help", "@review"];
  expect(commandRanges("/usage and /models\nnext /help", registered)).toEqual([
    { start: 0, end: 6 }, { start: 11, end: 18 }, { start: 24, end: 29 },
  ]);
  expect(commandRanges("@review and /help", registered)).toEqual([{ start: 0, end: 7 }, { start: 12, end: 17 }]);
  expect(commandRanges("/unknown and /usr/bin/python", registered)).toEqual([]);
  expect(isRegisteredCommand("/clear")).toBe(true);
  expect(isRegisteredCommand("/retry")).toBe(true);
  expect(isRegisteredCommand("/help")).toBe(true);
  expect(isRegisteredCommand("/caveman full", ["/caveman"])).toBe(true);
  expect(isRegisteredCommand("/unknown and /clear")).toBe(false);
});

it("frames input with command help and compact routing mode below it", () => {
  const composer = React.createElement(Composer, {
    value: "", onChange: () => {}, onSubmit: () => {}, history: [], disabled: false,
    shellMode: false, placeholder: "Ask Pace", onComplete: () => {},
  });
  const output = renderToString(React.createElement(ComposerFrame, {
    width: 80, shellMode: false, children: composer,
  }), { columns: 80 });
  expect(output).not.toContain("Auto routing");
  expect(output).not.toContain("/help for commands");
  expect(output).toContain("type ! to run commands");
  expect(output).not.toContain("!cmd for bash");
  expect(output).toContain("Context ? · auto · Request Approval");
  expect(output).toContain("Context ?");
  expect(output.indexOf("Context ?")).toBeGreaterThan(output.indexOf("Ask Pace"));
  expect(output).toContain("newline");
  expect(output).toContain("Shift");
  const lines = output.split("\n");
  expect(lines.filter(line => line.includes("───"))).toHaveLength(2);
  expect(output.indexOf("type / for commands")).toBeLessThan(output.indexOf("type ! to run commands"));
});

it("keeps both composer hints on one footer row in wide terminals", () => {
  const output = renderToString(React.createElement(ComposerFrame, {
    width: 140, shellMode: false, children: React.createElement(Text, null, "Input"),
  }), { columns: 140 });
  const hintLine = output.split("\n").find(line => line.includes("type / for commands"));
  expect(hintLine).toContain("type ! to run commands");
});

it("keeps context visible below input in narrow terminals", () => {
  const session = newSession(process.cwd(), "manual");
  session.route = { model: "gpt-6-sol", effort: "high" };
  const output = renderToString(React.createElement(ComposerFrame, {
    width: 30, session, shellMode: false, children: React.createElement(Text, null, "Input"),
  }), { columns: 30 });
  expect(output).toContain("Context ? · manual");
  expect(output).toContain("Approval: Request Approval");
  expect(output).toContain("Context ?");
  expect(output.indexOf("Context ?")).toBeGreaterThan(output.indexOf("Input"));
  expect(output.split("\n").every(line => line.length <= 30)).toBe(true);
});

it("moves within multiline drafts before using history", () => {
  const draft = "long line\nshort\nlast line";
  expect(verticalCursor(draft, 22, "up")).toBe(15);
  expect(verticalCursor(draft, 15, "up")).toBe(5);
  expect(verticalCursor(draft, 5, "up")).toBeUndefined();
  expect(verticalCursor(draft, 5, "down")).toBe(15);
  expect(verticalCursor(draft, 22, "down")).toBeUndefined();
});

it("wraps long drafts inside narrow terminals", () => {
  const output = renderToString(React.createElement(Composer, {
    value: "one two three four five six seven eight",
    onChange: () => {},
    onSubmit: () => {},
    history: [],
    disabled: false,
    shellMode: false,
    width: 15,
    placeholder: "Ask Pace",
    onComplete: () => {},
  }), { columns: 15 });
  expect(output.split("\n").every(line => line.length <= 15), JSON.stringify(output)).toBe(true);
  expect(output.split("\n").length).toBeLessThanOrEqual(4);
  expect(output).toContain("one two");
});

it("bounds long unbroken input to composer width and height", () => {
  const output = renderToString(React.createElement(Composer, {
    value: "s".repeat(100), onChange: () => {}, onSubmit: () => {}, history: [],
    disabled: false, shellMode: false, width: 15, maxRows: 2,
    placeholder: "Ask Pace", onComplete: () => {},
  }), { columns: 15 });
  expect(output.split("\n")).toHaveLength(2);
  expect(output.split("\n").every(line => line.length <= 15)).toBe(true);
});

it("keeps multiline shell input within a narrow terminal", () => {
  const output = renderToString(React.createElement(Composer, {
    value: "first command\nsecond command",
    onChange: () => {},
    onSubmit: () => {},
    history: [],
    disabled: false,
    shellMode: true,
    placeholder: "Bash command",
    onComplete: () => {},
  }), { columns: 15 });
  expect(output.split("\n").every(line => line.length <= 15), JSON.stringify(output)).toBe(true);
  expect(output).toContain("second");
});

it("renders without duplicate React keys when value has leading or multiple spaces", () => {
  const errorLogs: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    errorLogs.push(args.join(" "));
  };
  try {
    renderToString(React.createElement(Composer, {
      value: "  two spaces  and  more",
      onChange: () => {},
      onSubmit: () => {},
      history: [],
      disabled: false,
      shellMode: false,
      placeholder: "Ask Pace",
      onComplete: () => {},
    }));
    expect(errorLogs.some(msg => msg.includes("Encountered two children with the same key"))).toBe(false);
  } finally {
    console.error = originalError;
  }
});
