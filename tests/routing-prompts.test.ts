import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_ROUTING_PROMPTS, loadRoutingPrompts, parseRoutingPrompts, routingPromptFile } from "../src/core/routing/routing-prompts.js";
import { shapeRequest, stageRequest, type VexRequest } from "../src/core/vex/client.js";
import { Orchestrator } from "../src/core/orchestrator.js";
import { PaceStore, newSession } from "../src/core/sessions.js";
import { decision } from "./routing-fixture.js";
import type { Config } from "../src/shared/types.js";

import * as pricing from "../src/core/routing/pricing.js";
let dir: string | undefined;
afterEach(async () => { vi.restoreAllMocks(); if (dir) await rm(dir, { recursive: true, force: true }); dir = undefined; });

it("creates an editable routing file and applies changes to Vex requests", async () => {
  dir = await mkdtemp(join(tmpdir(), "pace-routing-prompts-"));
  const initial = loadRoutingPrompts(dir);
  expect(initial).toEqual(DEFAULT_ROUTING_PROMPTS);
  expect(initial.control.choices).not.toHaveProperty("aside");
  const path = join(dir, routingPromptFile);
  const edited = JSON.parse(await readFile(path, "utf8"));
  edited.workflow.question = "Choose my workflow";
  edited.workflow.choices.single = "Use one agent";
  edited.stage.constraints = "Choose the least costly route";
  edited.routingRules.workflowResolution = "Custom conversation rule";
  edited.execution.existingThreadInstruction = "Custom thread instruction";
  edited.modelCapabilities["gpt-6-sol"] = "Custom Sol description";
  await writeFile(path, JSON.stringify(edited));
  const prompts = loadRoutingPrompts(dir);
  const models: Config["models"] = [{ model: "gpt-6-sol", efforts: ["high"] }];
  const shape = shapeRequest("work", [], models, prompts);
  const stage = stageRequest("work", [], models, "complete", undefined, models, prompts);
  expect(shape.question).toBe("Choose my workflow");
  expect(shape.options[0]?.description).toBe("Use one agent");
  expect(stage.constraints).toContain("Choose the least costly route");
  expect(stage.constraints).toContain("full remaining deliverable");
  expect(shape.constraints).toContain("Custom conversation rule");
  expect(prompts.execution.existingThreadInstruction).toBe("Custom thread instruction");
  expect((stage.context.availableModels as { capability: string }[])[0]?.capability).toBe("Custom Sol description");
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual(edited);
});

it("keeps edited files unchanged and fills missing active settings in memory", async () => {
  dir = await mkdtemp(join(tmpdir(), "pace-routing-prompts-"));
  const path = join(dir, routingPromptFile);
  const edited = structuredClone(DEFAULT_ROUTING_PROMPTS);
  edited.workflow.question = "My custom routing question";
  const content = JSON.stringify(edited);
  await writeFile(path, content);
  expect(loadRoutingPrompts(dir).workflow.question).toBe("My custom routing question");
  expect(await readFile(path, "utf8")).toBe(content);
  expect(edited).not.toHaveProperty("taskRelation");
  expect(edited.objectives).not.toHaveProperty("afterPlanHandoff");
  expect(edited.handoff).not.toHaveProperty("planObjective");
  expect(edited.handoff).not.toHaveProperty("planExecutionInstruction");
  const missing = JSON.parse(content);
  delete missing.workflow.choices.plan;
  delete missing.control;
  delete missing.execution.coverageInstruction;
  missing.stage = { question: "My stage question" };
  await writeFile(path, JSON.stringify(missing));
  const completed = loadRoutingPrompts(dir);
  expect(completed.workflow.choices.plan).toBe(DEFAULT_ROUTING_PROMPTS.workflow.choices.plan);
  expect(completed.workflow.question).toBe(edited.workflow.question);
  expect(completed.control).toEqual(DEFAULT_ROUTING_PROMPTS.control);
  expect(completed.execution.coverageInstruction).toBe(DEFAULT_ROUTING_PROMPTS.execution.coverageInstruction);
  expect(completed.stage).toEqual({ question: "My stage question", constraints: DEFAULT_ROUTING_PROMPTS.stage.constraints });
  expect(await readFile(path, "utf8")).toBe(JSON.stringify(missing));
  const retired = JSON.parse(content);
  retired.workflow.choices.plan_execute = "Retired choice";
  await writeFile(path, JSON.stringify(retired));
  expect(loadRoutingPrompts(dir).workflow.choices).toEqual(edited.workflow.choices);
  expect(() => parseRoutingPrompts(retired)).toThrow("unknown choice");
  retired.workflow.choices.typo = "Unknown active choice";
  await writeFile(path, JSON.stringify(retired));
  expect(() => loadRoutingPrompts(dir!)).toThrow("unknown choice");
});

it("keeps sparse profiles isolated from the shipped defaults", async () => {
  dir = await mkdtemp(join(tmpdir(), "pace-routing-prompts-"));
  const path = join(dir, routingPromptFile);
  await writeFile(path, JSON.stringify({ version: 1, stage: { question: "My question" }, modelCapabilities: { custom: "Custom model" } }));
  const completed = loadRoutingPrompts(dir);
  expect(completed.modelCapabilities).toEqual({ custom: "Custom model" });
  completed.effortCapabilities.low = "Changed by caller";
  expect(loadRoutingPrompts(dir).effortCapabilities.low).toBe(DEFAULT_ROUTING_PROMPTS.effortCapabilities.low);
  for (const invalid of [null, { version: 2 }, { version: 1, stage: null }, { version: 1, control: { choices: null } }]) {
    await writeFile(path, JSON.stringify(invalid));
    expect(() => loadRoutingPrompts(dir!)).toThrow();
  }
  await writeFile(path, "{broken");
  expect(() => loadRoutingPrompts(dir!)).toThrow("Cannot load");
});

it("removes the retired automatic aside choice from existing customized prompt files", async () => {
  dir = await mkdtemp(join(tmpdir(), "pace-routing-prompts-"));
  const path = join(dir, routingPromptFile);
  const customized = structuredClone(DEFAULT_ROUTING_PROMPTS);
  (customized.control.choices as Record<string, string>).aside = "Old automatic aside option";
  await writeFile(path, JSON.stringify(customized));

  const prompts = loadRoutingPrompts(dir);

  expect(prompts.control.choices).not.toHaveProperty("aside");
  expect(JSON.parse(await readFile(path, "utf8")).control.choices).toHaveProperty("aside");
});

it("rejects malformed routing text with the field name", async () => {
  dir = await mkdtemp(join(tmpdir(), "pace-routing-prompts-"));
  const invalid = structuredClone(DEFAULT_ROUTING_PROMPTS);
  invalid.workflow.choices.scout = "";
  await writeFile(join(dir, routingPromptFile), JSON.stringify(invalid));
  expect(() => loadRoutingPrompts(dir!)).toThrow("workflow.choices.scout");
});

it("loads legacy task-relation prompts without overwriting user edits", async () => {
  dir = await mkdtemp(join(tmpdir(), "pace-routing-prompts-"));
  const legacy = JSON.parse(JSON.stringify(DEFAULT_ROUTING_PROMPTS));
  delete legacy.control;
  delete legacy.assessment;
  delete legacy.side;
  delete legacy.execution.coverageInstruction;
  legacy.taskRelation = { question: "Old question", constraints: "Old constraints", choices: { continue: "Continue", replace: "Replace", aside: "Aside" } };
  legacy.workflow.question = "My custom legacy question";
  legacy.execution.savedTaskInstruction = "My saved task instruction";
  delete legacy.workflow.choices.plan;
  delete legacy.workflow.choices.scout_plan;
  legacy.workflow.choices.plan_execute = "Old plan workflow";
  legacy.workflow.choices.scout_plan_execute = "Old scout workflow";
  legacy.workflow.choices.plan_verify = "Old verification workflow";
  const path = join(dir, routingPromptFile);
  const content = JSON.stringify(legacy);
  await writeFile(path, content);
  const prompts = loadRoutingPrompts(dir);
  expect(prompts.workflow.question).toBe("My custom legacy question");
  expect(prompts.execution.savedTaskInstruction).toBe("My saved task instruction");
  expect(prompts.execution.coverageInstruction).toBe(DEFAULT_ROUTING_PROMPTS.execution.coverageInstruction);
  expect(prompts.control).toEqual(DEFAULT_ROUTING_PROMPTS.control);
  expect(prompts.assessment).toEqual(DEFAULT_ROUTING_PROMPTS.assessment);
  expect(prompts.side).toEqual(DEFAULT_ROUTING_PROMPTS.side);
  expect(prompts.workflow.choices).toEqual(DEFAULT_ROUTING_PROMPTS.workflow.choices);
  expect(await readFile(path, "utf8")).toBe(content);
  legacy.stage.question = "";
  await writeFile(path, JSON.stringify(legacy));
  expect(() => loadRoutingPrompts(dir!)).toThrow("stage.question");
});

it("passes customized routing and handoff instructions through a turn", async () => {
  dir = await mkdtemp(join(tmpdir(), "pace-routing-prompts-"));
  vi.spyOn(pricing, "refreshVersionManifest").mockResolvedValue(pricing.currentVersionManifest());
  const prompts = structuredClone(DEFAULT_ROUTING_PROMPTS);
  prompts.workflow.question = "Custom workflow question";
  prompts.objectives.scout = "Custom scout stage";
  prompts.handoff.scoutObjective = "Custom scout objective.";
  prompts.handoff.originalRequestLabel = "Original task:";
  prompts.handoff.reportInstruction = "Custom report instruction:";
  await writeFile(join(dir, routingPromptFile), JSON.stringify(prompts));
  const requests: VexRequest[] = [];
  const seen: string[] = [];
  const vex = { choose: async (request: VexRequest) => {
    requests.push(request);
    return decision(request, request.options[0]?.id === "single" ? "scout" : "0:low");
  } };
  const runner = { run: async (prompt: string, _project: string, _route: unknown, _thread: unknown, _progress: unknown, _signal: unknown, mode: string) => {
    seen.push(prompt);
    return { result: mode === "side"
      ? JSON.stringify({ summary: "Found files", findings: [], nextSteps: [], checks: [], risks: [] })
      : "done", completed: true };
  } };
  const config: Config = { routingMode: "auto", defaultRoute: { model: "gpt-6-luna", effort: "low" }, models: [{ model: "gpt-6-luna", efforts: ["low"] }] };
  await new Orchestrator(new PaceStore(dir), runner, vex).turn("work", newSession(dir, "auto"), config, () => {});
  expect(requests[0]?.question).toBe("Custom workflow question");
  expect(requests[1]?.context.stageObjective).toBe("Custom scout stage");
  expect(seen[0]).toContain("Custom scout objective.");
  expect(seen[0]).toContain("Original task:");
  expect(seen[1]).toContain("Custom report instruction:");
});

it("fingerprints parsed effective profiles independently of object key order and distinguishes schema from profile versions", async () => {
  const { routingPromptProfile } = await import("../src/core/routing/routing-prompts.js");
  const original = routingPromptProfile(DEFAULT_ROUTING_PROMPTS);
  function reverse(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(reverse);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reverse(item)]));
    return value;
  }
  expect(routingPromptProfile(parseRoutingPrompts(reverse(DEFAULT_ROUTING_PROMPTS)))).toEqual(original);
  const changed = structuredClone(DEFAULT_ROUTING_PROMPTS);
  changed.stage.question += " Custom override";
  expect(routingPromptProfile(changed).fingerprint).not.toBe(original.fingerprint);
  changed.profile = { id: "custom", version: "2.3" };
  expect(routingPromptProfile(changed)).toMatchObject({ schemaVersion: 1, profileId: "custom", profileVersion: "2.3" });
  dir = await mkdtemp(join(tmpdir(), "pace-profile-"));
  await writeFile(join(dir, routingPromptFile), JSON.stringify({ version: 1 }));
  expect(routingPromptProfile(loadRoutingPrompts(dir))).toEqual(original);
});
