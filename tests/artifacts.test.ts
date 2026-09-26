import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifactDirectory, artifactPrompt, artifactSnapshot, changedArtifacts } from "../src/core/system/artifacts.js";
import { PaceStore, newSession } from "../src/core/sessions.js";
import { Orchestrator } from "../src/core/orchestrator.js";
import type { Config } from "../src/types.js";
import { singleVex } from './routing-fixture.js';

let root: string | undefined;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = undefined; });

it("instructs Codex on persistent Markdown artifacts only for artifact requests", () => {
  expect(artifactPrompt("Hello")).toBe("Hello");
  expect(artifactPrompt("Create an artifact for planning")).toContain(".pace/artifacts/");
  expect(artifactPrompt("Create an artifact for planning")).toContain("User request:\nCreate an artifact for planning");
});

it("records a Markdown artifact created during a coding turn and finds it later", async () => {
  root = await mkdtemp(join(tmpdir(), "pace-artifact-"));
  const project = join(root, "project");
  const store = new PaceStore(join(root, "store"));
  const config: Config = { routingMode: "auto", models: [{ model: "gpt-6-sol", efforts: ["medium"] }], defaultRoute: { model: "gpt-6-sol", effort: "medium" } };
  const runner = { async run() {
    await mkdir(artifactDirectory(project), { recursive: true });
    await writeFile(join(artifactDirectory(project), "plan.md"), "# Plan\n");
    return { result: "Saved the plan", completed: true };
  } };
  const orchestrator = new Orchestrator(store, runner, singleVex('0:medium'));
  const outcome = await orchestrator.turn("Create an artifact", newSession(project, "auto"), config, () => {});
  expect(outcome.artifacts).toEqual([".pace/artifacts/plan.md"]);
  expect((await store.latest(project))?.turns[0]?.artifacts).toEqual(outcome.artifacts);
  expect([...await artifactSnapshot(project)].map(([name]) => name)).toEqual(["plan.md"]);
  expect(changedArtifacts(await artifactSnapshot(project), await artifactSnapshot(project))).toEqual([]);
});
