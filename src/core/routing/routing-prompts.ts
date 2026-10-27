import { createHash } from "node:crypto";
import type { PromptProfile } from "../../shared/types.js";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord } from "../../shared/config.js";

const defaultPath = fileURLToPath(
  new URL("../../../routing-prompts.default.json", import.meta.url),
);
export const routingPromptFile = "routing-prompts.json";
const choiceIds = ["single", "scout", "plan", "scout_plan", "clarify"] as const;

export type RoutingPrompts = {
  version: 1;
  profile?: { id: string; version: string };
  control: { question: string; constraints: string; choices: Record<"continue" | "aside" | "reroute" | "replan" | "replace" | "clarify" | "adopt_side", string> };
  assessment: { question: string; constraints: string; choices: Record<"closed" | "partial" | "unknown", string> };
  side: { objective: string; instruction: string };
  workflow: {
    question: string;
    constraints: string;
    choices: Record<(typeof choiceIds)[number], string>;
  };
  stage: { question: string; constraints: string };
  routingRules: { workflowResolution: string; stageResolution: string };
  objectives: {
    scout: string;
    plan: string;
    single: string;
    afterHandoff: string;
  };
  modelCapabilities: Record<string, string>;
  effortCapabilities: Record<string, string>;
  unknownModelCapability: string;
  unknownEffortCapability: string;
  execution: {
    coverageInstruction: string;
    savedTaskInstruction: string;
    existingThreadInstruction: string;
    usageRetryInstruction: string;
  };
  handoff: {
    scoutObjective: string;
    instructions: string;
    recentConversationLabel: string;
    originalRequestLabel: string;
    reportInstruction: string;
  };
};

function nonempty(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`routing-prompts.json: ${name} must be a nonempty string`);
  return value;
}

function stringMap(value: unknown, name: string): Record<string, string> {
  if (!isRecord(value))
    throw new Error(`routing-prompts.json: ${name} must be an object`);
  for (const [key, entry] of Object.entries(value))
    nonempty(entry, `${name}.${key}`);
  return value as Record<string, string>;
}

function parseSection<K extends string>(value: unknown, ids: readonly K[], name: string): { question: string; constraints: string; choices: Record<K, string> } {
  if (!isRecord(value)) throw new Error(`routing-prompts.json: ${name} must be an object`);
  const choices = stringMap(value.choices, `${name}.choices`);
  if (Object.keys(choices).some(id => !ids.includes(id as K))) throw new Error(`routing-prompts.json: ${name}.choices contains an unknown choice`);
  return {
    question: nonempty(value.question, `${name}.question`),
    constraints: nonempty(value.constraints, `${name}.constraints`),
    choices: Object.fromEntries(ids.map(id => [id, nonempty(choices[id], `${name}.choices.${id}`)])) as Record<K, string>,
  };
}

export function parseRoutingPrompts(value: unknown): RoutingPrompts {
  if (!isRecord(value) || value.version !== 1)
    throw new Error("routing-prompts.json: version must be 1");
  const { stage, objectives, handoff, routingRules, execution, side } = value;
  if (!isRecord(stage) || !isRecord(objectives) || !isRecord(handoff) || !isRecord(routingRules) || !isRecord(execution) || !isRecord(side))
    throw new Error("routing-prompts.json: stage, objectives, handoff, routingRules, execution, and side must be objects");
  if (value.profile !== undefined && !isRecord(value.profile)) throw new Error("routing-prompts.json: profile must be an object");
  return {
    version: 1,
    profile: value.profile === undefined ? { id: "pace-task-workflows", version: "2026-10-22" } : {
      id: nonempty(value.profile.id, "profile.id"), version: nonempty(value.profile.version, "profile.version"),
    },
    control: parseSection(value.control, ["continue", "aside", "reroute", "replan", "replace", "clarify", "adopt_side"], "control"),
    assessment: parseSection(value.assessment, ["closed", "partial", "unknown"], "assessment"),
    side: {
      objective: nonempty(side.objective, "side.objective"),
      instruction: nonempty(side.instruction, "side.instruction"),
    },
    workflow: parseSection(value.workflow, choiceIds, "workflow"),
    stage: {
      question: nonempty(stage.question, "stage.question"),
      constraints: nonempty(stage.constraints, "stage.constraints"),
    },
    routingRules: {
      workflowResolution: nonempty(routingRules.workflowResolution, "routingRules.workflowResolution"),
      stageResolution: nonempty(routingRules.stageResolution, "routingRules.stageResolution"),
    },
    objectives: {
      scout: nonempty(objectives.scout, "objectives.scout"),
      plan: nonempty(objectives.plan, "objectives.plan"),
      single: nonempty(objectives.single, "objectives.single"),
      afterHandoff: nonempty(objectives.afterHandoff, "objectives.afterHandoff"),
    },
    modelCapabilities: stringMap(value.modelCapabilities, "modelCapabilities"),
    effortCapabilities: stringMap(value.effortCapabilities, "effortCapabilities"),
    unknownModelCapability: nonempty(value.unknownModelCapability, "unknownModelCapability"),
    unknownEffortCapability: nonempty(value.unknownEffortCapability, "unknownEffortCapability"),
    execution: {
      coverageInstruction: nonempty(execution.coverageInstruction, "execution.coverageInstruction"),
      savedTaskInstruction: nonempty(execution.savedTaskInstruction, "execution.savedTaskInstruction"),
      existingThreadInstruction: nonempty(execution.existingThreadInstruction, "execution.existingThreadInstruction"),
      usageRetryInstruction: nonempty(execution.usageRetryInstruction, "execution.usageRetryInstruction"),
    },
    handoff: {
      scoutObjective: nonempty(handoff.scoutObjective, "handoff.scoutObjective"),
      instructions: nonempty(handoff.instructions, "handoff.instructions"),
      recentConversationLabel: nonempty(handoff.recentConversationLabel, "handoff.recentConversationLabel"),
      originalRequestLabel: nonempty(handoff.originalRequestLabel, "handoff.originalRequestLabel"),
      reportInstruction: nonempty(handoff.reportInstruction, "handoff.reportInstruction"),
    },
  };
}

const defaultText = readFileSync(defaultPath, "utf8");
export const DEFAULT_ROUTING_PROMPTS = parseRoutingPrompts(
  JSON.parse(defaultText),
);

export function completionObjective(shape: string, prompts: RoutingPrompts): string {
  if (shape === "single") return prompts.objectives.single;
  if (shape === "plan" || shape === "scout_plan") return prompts.objectives.plan;
  return prompts.objectives.afterHandoff;
}

/** Fill absent active settings in memory; explicit invalid edits still fail validation. */
function withPromptDefaults(value: unknown): unknown {
  if (!isRecord(value) || value.version !== 1) return value;
  const defaults = structuredClone(DEFAULT_ROUTING_PROMPTS);
  const completed: Record<string, unknown> = { ...defaults, ...value };
  for (const key of ["control", "assessment", "side", "workflow", "stage", "routingRules", "objectives", "execution", "handoff"] as const) {
    const configured = value[key];
    if (!isRecord(configured)) continue;
    const sectionDefaults = defaults[key];
    const section: Record<string, unknown> = { ...sectionDefaults, ...configured };
    if ("choices" in sectionDefaults && isRecord(configured.choices))
      section.choices = { ...sectionDefaults.choices, ...configured.choices };
    completed[key] = section;
  }
  if (isRecord(completed.workflow) && isRecord(completed.workflow.choices)) {
    // Retired options carry no active meaning; never expose or map them to actions.
    for (const id of ["plan_execute", "scout_plan_execute", "plan_verify"]) delete completed.workflow.choices[id];
  }
  return completed;
}

export function loadRoutingPrompts(
  baseDir = join(homedir(), ".pace"),
): RoutingPrompts {
  const path = join(baseDir, routingPromptFile);
  try {
    mkdirSync(baseDir, { recursive: true });
    writeFileSync(path, defaultText, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  try {
    return parseRoutingPrompts(withPromptDefaults(JSON.parse(readFileSync(path, "utf8"))));
  } catch (error) {
    throw new Error(`Cannot load ${path}: ${String(error)}`);
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (isRecord(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
/** Hash the parsed effective config, including user overrides, independently of key order. */
export function routingPromptProfile(prompts: RoutingPrompts): PromptProfile {
  const parsed = parseRoutingPrompts(prompts);
  return { schemaVersion: parsed.version, profileId: parsed.profile!.id, profileVersion: parsed.profile!.version,
    fingerprint: createHash("sha256").update(JSON.stringify(canonical(parsed))).digest("hex") };
}
