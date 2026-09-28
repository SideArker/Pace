import React from "react";
import { renderToString } from "ink";
import { expect, it } from "vitest";
import { Composer, commandToken, inputColumns, isNewlineKey, paceGradient } from "../src/components/Composer.js";

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
  expect(commandToken("explain this /mo")).toEqual({ start: 13, prefix: "/mo" });
  expect(commandToken("first line\n/mo")).toEqual({ start: 11, prefix: "/mo" });
  expect(commandToken("first line\nmore /mo")).toEqual({ start: 16, prefix: "/mo" });
  expect(commandToken("plain text")).toBeUndefined();
  expect(commandToken("/models option")).toBeUndefined();
});

it("shows the newline hint before typing", () => {
  const output = renderToString(React.createElement(Composer, {
    value: "", onChange: () => {}, onSubmit: () => {}, history: [], disabled: false,
    shellMode: false, placeholder: "Ask Pace", onComplete: () => {},
  }), { columns: 80 });
  expect(output).toContain("newline");
  expect(output).toContain("Shift");
});
