import { expect, it } from "vitest";
import { isNewlineKey } from "../src/components/Composer.js";

it("recognizes modified Enter and Ctrl+J as newline input", () => {
  const key = { return: true, shift: false, ctrl: false, meta: false };
  expect(isNewlineKey("", key)).toBe(false);
  expect(isNewlineKey("", { ...key, shift: true })).toBe(true);
  expect(isNewlineKey("", { ...key, ctrl: true })).toBe(true);
  expect(isNewlineKey("", { ...key, meta: true })).toBe(true);
  expect(isNewlineKey("j", { ...key, return: false, ctrl: true })).toBe(true);
  expect(isNewlineKey("\n", { ...key, return: false })).toBe(true);
  expect(isNewlineKey("j", { ...key, return: false })).toBe(false);
});
