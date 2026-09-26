import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getGitBranch } from "../src/core/system/git.js";

let dir: string;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

it("detects standard branch name from .git/HEAD", async () => {
  dir = await mkdtemp(join(tmpdir(), "pace-git-test-"));
  await mkdir(join(dir, ".git"));
  await writeFile(join(dir, ".git", "HEAD"), "ref: refs/heads/feat/cyber-cli\n", "utf8");
  expect(getGitBranch(dir)).toBe("feat/cyber-cli");
});

it("detects short commit hash when HEAD is detached", async () => {
  dir = await mkdtemp(join(tmpdir(), "pace-git-test-"));
  await mkdir(join(dir, ".git"));
  await writeFile(join(dir, ".git", "HEAD"), "a2e83f0cf53411746de9ae9d59869b7b312d25c8\n", "utf8");
  expect(getGitBranch(dir)).toBe("a2e83f0");
});

it("returns undefined when not a git repository", async () => {
  dir = await mkdtemp(join(tmpdir(), "pace-git-test-"));
  expect(getGitBranch(dir)).toBeUndefined();
});
