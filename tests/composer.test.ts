import React from "react";
import { renderToString, Text } from "ink";
import { expect, it } from "vitest";
import { Composer, commandRanges, commandToken, deleteWordBackward, deleteWordForward, inputColumns, isAltBackspaceKey, isAltDeleteKey, isNewlineKey, paceGradient, verticalCursor } from "../src/components/Composer.js";
import { ComposerFrame } from "../src/components/ComposerFrame.js";
import { newSession } from "../src/core/sessions.js";
import { normalizeNewCommand } from "../src/components/App.js";

it("treats ./new, /.new, ./clear, and /.clear as conversation commands", () => {
  expect(normalizeNewCommand("./new")).toBe("/new");
  expect(normalizeNewCommand(" ./new ")).toBe("/new");
  expect(normalizeNewCommand("./new extra")).toBe("/new extra");
  expect(normalizeNewCommand("./newfile")).toBe("./newfile");
  expect(normalizeNewCommand("/.clear")).toBe("/clear");
  expect(normalizeNewCommand(" /.clear ")).toBe("/clear");
  expect(normalizeNewCommand("./clear")).toBe("/clear");
  expect(normalizeNewCommand("/.new")).toBe("/new");
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

it("marks every slash command in multiline input", () => {
  expect(commandRanges("/usage and /models\nnext /help")).toEqual([
    { start: 0, end: 6 }, { start: 11, end: 18 }, { start: 24, end: 29 },
  ]);
  expect(commandRanges("@review and /help")).toEqual([{ start: 0, end: 7 }, { start: 12, end: 17 }]);
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
  expect(output).toContain("/help for commands");
  expect(output).toContain("type ! to run commands");
  expect(output).not.toContain("!cmd for bash");
  expect(output).toContain("Context ? · auto · Request Approval");
  expect(output).toContain("Context ?");
  expect(output.indexOf("Context ?")).toBeGreaterThan(output.indexOf("Ask Pace"));
  expect(output).toContain("newline");
  expect(output).toContain("Shift");
  const lines = output.split("\n");
  expect(lines.filter(line => line.includes("───"))).toHaveLength(2);
  expect(lines.findIndex(line => line.includes("/help shortcuts"))).toBe(lines.findIndex(line => line.includes("/help for commands")) + 1);
});

it("keeps both composer hints on one footer row in wide terminals", () => {
  const output = renderToString(React.createElement(ComposerFrame, {
    width: 140, shellMode: false, children: React.createElement(Text, null, "Input"),
  }), { columns: 140 });
  const hintLine = output.split("\n").find(line => line.includes("/help for commands"));
  expect(hintLine).toContain("/help shortcuts · Shift+Enter newline");
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
    placeholder: "Ask Pace",
    onComplete: () => {},
  }), { columns: 15 });
  expect(output.split("\n").every(line => line.length <= 15), JSON.stringify(output)).toBe(true);
  expect(output).toContain("seven");
  expect(output).toContain("one two three\n  four five six\n  seven eight");
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
