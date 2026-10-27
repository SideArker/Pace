import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { baselineBuildPaths, benchmarkProvenance, fingerprintSources } from "../src/entrypoints/benchmark-provenance.js";

const command = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pace-provenance-")); roots.push(root);
  for (const path of ["src/core", "dist/core", "benchmark/results", "benchmark/reports", "skills"]) await mkdir(join(root, path), { recursive: true });
  for (const path of ["src/core/orchestrator-routing.ts", "src/core/orchestrator-helpers.ts", "dist/core/orchestrator.js", "benchmark/driver.ts", "skills/SKILL.md", "package.json", "package-lock.json", "routing-prompts.default.json", "versions.json"]) await writeFile(join(root, path), path);
  return root;
}

it("hashes production dependencies, new source files and inputs, but excludes run outputs", async () => {
  const root = await fixture();
  let before = await fingerprintSources(root);
  for (const path of ["src/core/orchestrator-routing.ts", "src/core/orchestrator-helpers.ts", "src/core/new-helper.ts", "routing-prompts.default.json", "package-lock.json"]) {
    await writeFile(join(root, path), "changed");
    const after = await fingerprintSources(root);
    expect(after.sourceSha256).not.toBe(before.sourceSha256);
    before = after;
  }
  await writeFile(join(root, "benchmark/results/run.json"), "new run");
  await writeFile(join(root, "benchmark/reports/report.md"), "new report");
  expect(await fingerprintSources(root)).toEqual(before);
  const forward = await fingerprintSources(root, ["src", "benchmark"]);
  expect(await fingerprintSources(root, ["benchmark", "src", "src"])).toEqual(forward);
  await rm(join(root, "src/core/new-helper.ts"));
  expect((await fingerprintSources(root)).sourceSha256).not.toBe(before.sourceSha256);
});

it("includes path boundaries rather than hashing concatenated file contents", async () => {
  const root = await fixture();
  await writeFile(join(root, "a"), "ab"); await writeFile(join(root, "b"), "c");
  const before = await fingerprintSources(root, ["a", "b"]);
  await writeFile(join(root, "a"), "a"); await writeFile(join(root, "b"), "bc");
  expect((await fingerprintSources(root, ["a", "b"])).sourceSha256).not.toBe(before.sourceSha256);
});

it("identifies the specified baseline checkout and the loaded build independently", async () => {
  const root = await fixture();
  await command("git", ["init", "-q"], { cwd: root });
  await command("git", ["add", "."], { cwd: root });
  await command("git", ["-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-qm", "Fixture"], { cwd: root });
  const before = await benchmarkProvenance(root, baselineBuildPaths);
  expect(before.commit).toBe((await command("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim());
  expect(before.dirty).toBe(false);
  expect(before.sourceHashes).toHaveProperty("dist/core/orchestrator.js");
  await writeFile(join(root, "dist/core/orchestrator.js"), "different build");
  const dirty = await benchmarkProvenance(root, baselineBuildPaths);
  expect(dirty.commit).toBe(before.commit);
  expect(dirty.dirty).toBe(true);
  expect(dirty.sourceSha256).not.toBe(before.sourceSha256);
  await command("git", ["add", "."], { cwd: root });
  await command("git", ["-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-qm", "Changed build"], { cwd: root });
  expect((await benchmarkProvenance(root, baselineBuildPaths)).commit).not.toBe(before.commit);
});

it("covers the real controller, context, persistence, transport, drivers and prompt assets", async () => {
  const { sourceHashes } = await fingerprintSources();
  for (const path of ["src/benchmark/service.ts", "src/benchmark/drivers/fresh-completion.ts", "src/benchmark/frozen.ts", "src/components/BenchmarkManager.tsx", "src/core/orchestrator-routing.ts", "src/core/orchestrator-helpers.ts", "src/core/vex/context.ts", "src/core/task-execution.ts", "src/core/sessions-revisions.ts", "src/integrations/app-server-process.ts", "src/integrations/app-server-config.ts", "src/entrypoints/benchmark-provenance.ts", "benchmark/suites/fresh-completion.json", "routing-prompts.default.json", "skills/pace-planning/SKILL.md", "versions.json", "package-lock.json"]) {
    expect(sourceHashes[path], path).toMatch(/^[a-f0-9]{64}$/);
  }
});
