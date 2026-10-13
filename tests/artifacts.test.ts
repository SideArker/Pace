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
  expect(first.result).toBe("Updated the plan summary.");
  expect(first.session.turns.at(-1)?.systemMessages).toContain(`Plan saved: ${calls[0]!.path}`);
  expect(first.artifacts).toEqual([first.session.planArtifact]);
  const initialPath = first.session.planArtifact;
  const question = await orchestrator.turn("What check does the plan list?", session, config, () => {});
  expect(question.result).toBe("The verification section lists the check.");
  expect(question.artifacts).toEqual([]);
  expect(session.plan).toBe(fullPlan);
  const revision = await orchestrator.turn("Revise the plan to make it shorter", session, config, () => {});
  expect(revision.result).toBe("Updated the plan summary.");
  expect(revision.session.turns.at(-1)?.systemMessages).toContain(`Plan saved: ${calls[0]!.path}`);
  expect(session.planArtifact).toBe(initialPath);
  expect(session.plan).toBe(revisedPlan);
  expect(revision.artifacts).toEqual([initialPath]);
  expect(calls.map(call => call.path)).toEqual([calls[0]!.path, calls[0]!.path, calls[0]!.path]);
  expect(await readFile(artifactPath(store, session, session.planArtifact!), "utf8")).toBe(revisedPlan);
  const unchanged = await orchestrator.turn("Revise the plan again", session, config, () => {});
  expect(unchanged.result).toBe("Updated the plan summary.");
  expect(unchanged.session.turns.at(-1)?.systemMessages).not.toContain(`Plan saved: ${calls[0]!.path}`);
  expect(unchanged.artifacts).toEqual([]);
  expect(session.plan).toBe(revisedPlan);
  expect((await store.latest(project))?.planArtifact).toBe(initialPath);
});

it("keeps an unsaved plan path through questions and a session reload without hiding replies", async () => {
  root = await mkdtemp(join(tmpdir(), "pace-pending-plan-"));
  const project = join(root, "project");
  await mkdir(project);
  const store = new PaceStore(join(root, "store"));
  const config: Config = { routingMode: "auto", models: [{ model: "gpt-6-sol", efforts: ["medium"] }], defaultRoute: { model: "gpt-6-sol", effort: "medium" } };
  const paths: string[] = [];
  const runner = { async run(runPrompt: string) {
    const path = runPrompt.match(/The saved plan path is (\/[^\n]+?\.pace-plan\.md)/)?.[1];
    expect(path).toBeTruthy();
    paths.push(path!);
    if (paths.length === 3) await writeFile(path!, "# Saved plan\n");
    return { result: ["I have not saved a plan yet.", "I meant that no plan exists yet.", "I wrote the plan."][paths.length - 1]!, completed: true };
  } };
  const vex = { choose: async (request: VexRequest) => decision(request, request.options.some(option => option.id === "continue") ? "continue" : request.options.some(option => option.id === "plan") ? "plan" : "0:medium") };
  let session = newSession(project, "auto", "planning");
  const orchestrator = new Orchestrator(store, runner, vex);
  const first = await orchestrator.turn("Plan this if useful", session, config, () => {});
  expect(first.result).toBe("I have not saved a plan yet.");
  expect(session.planArtifact).toBeUndefined();
  expect(session.pendingPlanArtifact).toBeTruthy();
  const pendingPath = session.pendingPlanArtifact;
  session = (await store.load(project, session.id))!;
  const question = await orchestrator.turn("What do you mean by not saved?", session, config, () => {});
  expect(question.result).toBe("I meant that no plan exists yet.");
  expect(question.artifacts).toEqual([]);
  const saved = await orchestrator.turn("Write the plan", session, config, () => {});
  expect(saved.result).toBe("I wrote the plan.");
  expect(paths).toEqual([paths[0], paths[0], paths[0]]);
  expect(session.planArtifact).toBe(pendingPath);
  expect(session.pendingPlanArtifact).toBeUndefined();
  expect(await readFile(paths[0]!, "utf8")).toBe("# Saved plan\n");
});

it("does not copy the old plan into an unwritten separate plan during a question", async () => {
  root = await mkdtemp(join(tmpdir(), "pace-separate-plan-"));
  const project = join(root, "project");
  await mkdir(project);
  const store = new PaceStore(join(root, "store"));
  const session = newSession(project, "auto", "planning");
  const config: Config = { routingMode: "auto", models: [{ model: "gpt-6-sol", efforts: ["medium"] }], defaultRoute: { model: "gpt-6-sol", effort: "medium" } };
  session.plan = "# Original\n";
  session.planArtifact = "artifacts/original.pace-plan.md";
  const originalPath = artifactPath(store, session, session.planArtifact);
  await mkdir(artifactDirectory(store, session), { recursive: true });
  await writeFile(originalPath, session.plan);
  const paths: string[] = [];
  const runner = { async run(runPrompt: string) {
    const path = runPrompt.match(/The saved plan path is (\/[^\n]+?\.pace-plan\.md)/)?.[1]!;
    paths.push(path);
    if (paths.length === 3) await writeFile(path, "# Separate\n");
    return { result: ["I have not written it.", "The original plan is still saved.", "I wrote the new plan."][paths.length - 1]!, completed: true };
  } };
  const vex = { choose: async (request: VexRequest) => decision(request, request.options.some(option => option.id === "continue") ? "continue" : request.options.some(option => option.id === "plan") ? "plan" : "0:medium") };
  const orchestrator = new Orchestrator(store, runner, vex);
  await orchestrator.turn("Create a separate plan", session, config, () => {});
  const pendingPath = session.pendingPlanArtifact;
  expect(pendingPath).toBeTruthy();
  expect(session.planArtifact).toBe("artifacts/original.pace-plan.md");
  const question = await orchestrator.turn("What does the original plan say?", session, config, () => {});
  expect(question.result).toBe("The original plan is still saved.");
  await expect(readFile(paths[0]!, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  const saved = await orchestrator.turn("Write the new plan", session, config, () => {});
  expect(saved.result).toBe("I wrote the new plan.");
  expect(paths).toEqual([paths[0], paths[0], paths[0]]);
  expect(session.planArtifact).toBe(pendingPath);
  expect(await readFile(originalPath, "utf8")).toBe("# Original\n");
  expect(await readFile(paths[0]!, "utf8")).toBe("# Separate\n");
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
