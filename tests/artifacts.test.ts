import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifactDirectory, artifactPrompt, artifactSnapshot, changedArtifacts } from "../src/core/system/artifacts.js";
import { PaceStore, newSession } from "../src/core/sessions.js";
import { Orchestrator } from "../src/core/orchestrator.js";
import type { Config } from "../src/shared/types.js";
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

it("persists a read-only planning result while keeping full text for execution", async () => {
  root = await mkdtemp(join(tmpdir(), "pace-plan-artifact-"));
  const project = join(root, "project");
  await mkdir(project);
  const store = new PaceStore(join(root, "store"));
  const config: Config = { routingMode: "auto", models: [{ model: "gpt-6-sol", efforts: ["medium"] }], defaultRoute: { model: "gpt-6-sol", effort: "medium" } };
  const fullPlan = "# Improve plans\n\n## User Review\n\n> [!USER REVIEW]\n> Make plans easier to read.\n\n## Steps\n\n1. Save plan.\n";
  let mode: string | undefined;
  const runner = { async run(_prompt: string, _project: string, _route: unknown, _thread: unknown, _progress: unknown, _signal: unknown, receivedMode?: string) {
    mode = receivedMode;
    return { result: fullPlan, completed: true };
  } };
  const session = newSession(project, "auto", "planning");
  const outcome = await new Orchestrator(store, runner, singleVex("0:medium")).turn("Improve plans", session, config, () => {});
  expect(mode).toBe("side");
  expect(outcome.session.plan).toBe(fullPlan);
  expect(outcome.result).toContain(".pace-plan.md");
  expect(outcome.result).not.toContain("## Steps");
  expect(outcome.artifacts).toEqual([outcome.session.planArtifact]);
  expect(await readFile(join(project, outcome.session.planArtifact!), "utf8")).toBe(fullPlan);
  expect((await store.latest(project))?.planArtifact).toBe(outcome.session.planArtifact);
});
