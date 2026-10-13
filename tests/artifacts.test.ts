import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifactDirectory, artifactPath, artifactPrompt, artifactSnapshot, changedArtifacts } from "../src/core/system/artifacts.js";
import { PaceStore, newSession } from "../src/core/sessions.js";
import { Orchestrator } from "../src/core/orchestrator.js";
import type { VexRequest } from "../src/core/vex/client.js";
import type { Config } from "../src/shared/types.js";
import { decision, singleVex } from './routing-fixture.js';

let root: string | undefined;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = undefined; });

it("instructs Codex on persistent Markdown artifacts only for artifact requests", () => {
  expect(artifactPrompt("Hello")).toBe("Hello");
  expect(artifactPrompt("Create an artifact for planning", "/conversation/artifacts")).toContain("/conversation/artifacts");
  expect(artifactPrompt("Create an artifact for planning", "/conversation/artifacts")).toContain("User request:\nCreate an artifact for planning");
});

it("records a Markdown artifact created during a coding turn and finds it later", async () => {
  root = await mkdtemp(join(tmpdir(), "pace-artifact-"));
  const project = join(root, "project");
  const store = new PaceStore(join(root, "store"));
  const session = newSession(project, "auto");
  const directory = artifactDirectory(store, session);
  const config: Config = { routingMode: "auto", models: [{ model: "gpt-6-sol", efforts: ["medium"] }], defaultRoute: { model: "gpt-6-sol", effort: "medium" } };
  const runner = { async run(_prompt: string, _project: string, _route: unknown, _thread: unknown, _progress: unknown, _signal: unknown, _mode: unknown, trustedFolders: string[], _approval: unknown, artifactRoot: string) {
    expect(artifactRoot).toBe(directory);
    expect(trustedFolders).toContain(directory);
    await writeFile(join(directory, "plan.md"), "# Plan\n");
    return { result: "Saved the plan", completed: true };
  } };
  const orchestrator = new Orchestrator(store, runner, singleVex('0:medium'));
  const outcome = await orchestrator.turn("Create an artifact", session, config, () => {});
  expect(outcome.artifacts).toEqual(["artifacts/plan.md"]);
  expect((await store.latest(project))?.turns[0]?.artifacts).toEqual(outcome.artifacts);
  expect([...await artifactSnapshot(directory)].map(([name]) => name)).toEqual(["plan.md"]);
  expect(changedArtifacts(await artifactSnapshot(directory), await artifactSnapshot(directory))).toEqual([]);
  expect(artifactPath(store, session, outcome.artifacts[0]!)).toBe(join(directory, "plan.md"));
});

it("uses one editable plan file while questions remain in chat", async () => {
  root = await mkdtemp(join(tmpdir(), "pace-plan-artifact-"));
  const project = join(root, "project");
  await mkdir(project);
  const store = new PaceStore(join(root, "store"));
  const config: Config = { routingMode: "auto", models: [{ model: "gpt-6-sol", efforts: ["medium"] }], defaultRoute: { model: "gpt-6-sol", effort: "medium" } };
  const fullPlan = "# Improve plans\n\n## Task description\n\nMake plans clearer.\n\n## Implementation steps\n\n1. Save plan.\n\n## Verification\n\n- Read the file.\n";
  const revisedPlan = fullPlan.replace("Make plans clearer.", "Make plans clearer and shorter.");
  const calls: { mode?: string; path?: string; prompt: string }[] = [];
  const runner = { async run(runPrompt: string, _project: string, _route: unknown, _thread: unknown, _progress: unknown, _signal: unknown, receivedMode?: string, trustedFolders?: string[], _approval?: unknown, artifactRoot?: string) {
    const path = runPrompt.match(/The saved plan path is (\/[^\n]+?\.pace-plan\.md)/)?.[1];
    calls.push({ mode: receivedMode, path, prompt: runPrompt });
    expect(receivedMode).toBe("planning");
    expect(trustedFolders).toContain(artifactRoot);
    expect(path).toBeTruthy();
    if (calls.length === 1) await writeFile(path!, fullPlan);
    if (calls.length === 3) await writeFile(path!, revisedPlan);
    return { result: calls.length === 2 ? "The verification section lists the check." : "Updated the plan summary.", completed: true };
  } };
  const session = newSession(project, "auto", "planning");
  const vex = { choose: async (request: VexRequest) => decision(request, request.options.some(option => option.id === "continue") ? "continue" : request.options.some(option => option.id === "plan") ? "plan" : "0:medium") };
  const orchestrator = new Orchestrator(store, runner, vex);
  const first = await orchestrator.turn("Improve plans", session, config, () => {});
  expect(first.session.plan).toBe(fullPlan);
  expect(first.result).toContain(".pace-plan.md");
  expect(first.result).not.toContain("## Implementation steps");
  expect(first.artifacts).toEqual([first.session.planArtifact]);
  const initialPath = first.session.planArtifact;
  const question = await orchestrator.turn("What check does the plan list?", session, config, () => {});
  expect(question.result).toBe("The verification section lists the check.");
  expect(question.artifacts).toEqual([]);
  expect(session.plan).toBe(fullPlan);
  const revision = await orchestrator.turn("Revise the plan to make it shorter", session, config, () => {});
  expect(revision.result).toContain("Updated the plan summary.");
  expect(revision.result).toContain(calls[0]!.path!);
  expect(session.planArtifact).toBe(initialPath);
  expect(session.plan).toBe(revisedPlan);
  expect(revision.artifacts).toEqual([initialPath]);
  expect(calls.map(call => call.path)).toEqual([calls[0]!.path, calls[0]!.path, calls[0]!.path]);
  expect(await readFile(artifactPath(store, session, session.planArtifact!), "utf8")).toBe(revisedPlan);
  const unchanged = await orchestrator.turn("Revise the plan again", session, config, () => {});
  expect(unchanged.result).toContain("The plan file was not changed");
  expect(unchanged.artifacts).toEqual([]);
  expect(session.plan).toBe(revisedPlan);
  expect((await store.latest(project))?.planArtifact).toBe(initialPath);
});

it("continues to resolve old project artifact references without moving files", async () => {
  root = await mkdtemp(join(tmpdir(), "pace-old-artifact-"));
  const store = new PaceStore(join(root, "store"));
  const session = newSession(join(root, "project"), "auto");
  session.planArtifact = ".pace/artifacts/old.pace-plan.md";
  session.turns.push({ prompt: "Old plan", result: "Saved", at: "2026-01-01", artifacts: [session.planArtifact] });
  await store.save(session);
  expect((await store.latest(session.projectPath))?.planArtifact).toBe(session.planArtifact);
  expect(artifactPath(store, session, session.planArtifact)).toBe(join(session.projectPath, session.planArtifact));
});
