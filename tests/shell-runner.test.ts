import { expect, it } from "vitest";
import { oneOffShellCommand } from "../src/components/shell-runner.js";

it("accepts one-off Bash commands with or without a space", () => {
  expect(oneOffShellCommand("!pwd")).toBe("pwd");
  expect(oneOffShellCommand("! pwd")).toBe("pwd");
  expect(oneOffShellCommand("!")).toBeUndefined();
  expect(oneOffShellCommand("plain prompt")).toBeUndefined();
});
