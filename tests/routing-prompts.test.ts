import { afterEach, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_ROUTING_PROMPTS, loadRoutingPrompts, routingPromptFile } from "../src/core/routing/routing-prompts.js";
import { shapeRequest, stageRequest, taskRelationRequest, type VexRequest } from "../src/core/vex/client.js";
import { Orchestrator } from "../src/core/orchestrator.js";
import { PaceStore, newSession } from "../src/core/sessions.js";
import { decision } from "./routing-fixture.js";
import type { Config } from "../src/shared/types.js";

let dir: string | undefined;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = undefined; });

it("creates an editable routing file and applies changes to Vex requests", async () => {
  dir = await mkdtemp(join(tmpdir(), "pace-routing-prompts-"));
  const initial = loadRoutingPrompts(dir);
  expect(initial).toEqual(DEFAULT_ROUTING_PROMPTS);
  const path = join(dir, routingPromptFile);
  const edited = JSON.parse(await readFile(path, "utf8"));
  edited.workflow.question = "Choose my workflow";
  edited.workflow.choices.single = "Use one agent";
  edited.stage.constraints = "Choose the least costly route";
  edited.taskRelation.question = "Continue this task?";
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
  expect(taskRelationRequest("work", [], {}, prompts).question).toBe("Continue this task?");
  expect(prompts.execution.existingThreadInstruction).toBe("Custom thread instruction");
  expect((stage.context.availableModels as { capability: string }[])[0]?.capability).toBe("Custom Sol description");
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual(edited);
});

it("refreshes the untouched older default while preserving edited prompt files", async () => {
  dir = await mkdtemp(join(tmpdir(), "pace-routing-prompts-"));
  const legacy = await readFile(new URL("./fixtures/routing-prompts-v1.json", import.meta.url), "utf8");
  const path = join(dir, routingPromptFile);
  await writeFile(path, legacy);
  expect(loadRoutingPrompts(dir)).toEqual(DEFAULT_ROUTING_PROMPTS);
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual(DEFAULT_ROUTING_PROMPTS);
  const edited = structuredClone(DEFAULT_ROUTING_PROMPTS);
  edited.workflow.question = "My custom routing question";
  await writeFile(path, JSON.stringify(edited));
  expect(loadRoutingPrompts(dir).workflow.question).toBe("My custom routing question");
  const legacyEdited = JSON.parse(JSON.stringify(edited));
  delete legacyEdited.workflow.choices.scout_plan_execute;
  delete legacyEdited.taskRelation;
  delete legacyEdited.routingRules;
  delete legacyEdited.execution;
  delete legacyEdited.objectives.afterPlanHandoff;
  delete legacyEdited.handoff.planExecutionInstruction;
  await writeFile(path, JSON.stringify(legacyEdited));
  expect(loadRoutingPrompts(dir).workflow.choices.scout_plan_execute).toBe(DEFAULT_ROUTING_PROMPTS.workflow.choices.scout_plan_execute);
  expect(loadRoutingPrompts(dir).taskRelation.question).toBe(DEFAULT_ROUTING_PROMPTS.taskRelation.question);
  expect(loadRoutingPrompts(dir).execution.usageRetryInstruction).toBe(DEFAULT_ROUTING_PROMPTS.execution.usageRetryInstruction);
  expect(loadRoutingPrompts(dir).objectives.afterPlanHandoff).toBe(DEFAULT_ROUTING_PROMPTS.objectives.afterPlanHandoff);
});

it("rejects malformed routing text with the field name", async () => {
  dir = await mkdtemp(join(tmpdir(), "pace-routing-prompts-"));
  const invalid = structuredClone(DEFAULT_ROUTING_PROMPTS);
  invalid.workflow.choices.scout = "";
  await writeFile(join(dir, routingPromptFile), JSON.stringify(invalid));
  expect(() => loadRoutingPrompts(dir!)).toThrow("workflow.choices.scout");
});

it("passes customized routing and handoff instructions through a turn", async () => {
  dir = await mkdtemp(join(tmpdir(), "pace-routing-prompts-"));
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
