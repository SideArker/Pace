import { expect, it } from "vitest";
import { isDebugBuild, isNpmInstalledBuild } from "../src/core/build-mode.js";
import { commands } from "../src/components/app/commands.js";

it("exposes feedback commands for this checkout build", () => {
  expect(isDebugBuild).toBe(true);
  expect(commands).toContain("/feedback");
  expect(commands).toContain("/benchmark");
});

it("detects npm-installed Pace packages on Unix and Windows paths", () => {
  expect(isNpmInstalledBuild("/usr/lib/node_modules/@sidearker/pace/dist/core/build-mode.js")).toBe(true);
  expect(isNpmInstalledBuild("C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@sidearker\\pace\\dist\\core\\build-mode.js")).toBe(true);
});

it("treats checkout builds and unrelated dependencies as debug builds", () => {
  expect(isNpmInstalledBuild("/home/me/Projects/Pace/dist/core/build-mode.js")).toBe(false);
  expect(isNpmInstalledBuild("/home/me/Projects/Pace/node_modules/vitest/index.js")).toBe(false);
});
