import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord } from "../../shared/config.js";

const defaultPath = fileURLToPath(
  new URL("../../../routing-prompts.default.json", import.meta.url),
);
export const routingPromptFile = "routing-prompts.json";
const choiceIds = ["single", "scout", "plan", "scout_plan", "clarify"] as const;
const retiredChoiceIds = ["plan_execute", "scout_plan_execute", "plan_verify"] as const;

export type RoutingPrompts = {
  version: 1;
  workflow: {
    question: string;
    constraints: string;
    choices: Record<(typeof choiceIds)[number], string>;
  };
  stage: { question: string; constraints: string };
  taskRelation: {
    question: string;
    constraints: string;
    choices: Record<"continue" | "replace" | "aside", string>;
  };
  routingRules: { workflowResolution: string; stageResolution: string };
  objectives: {
    scout: string;
    plan: string;
    single: string;
    afterHandoff: string;
    afterPlanHandoff: string;
  };
  modelCapabilities: Record<string, string>;
  effortCapabilities: Record<string, string>;
  unknownModelCapability: string;
  unknownEffortCapability: string;
  execution: {
    savedTaskInstruction: string;
    existingThreadInstruction: string;
    usageRetryInstruction: string;
  };
  handoff: {
    scoutObjective: string;
    planObjective: string;
    planExecutionInstruction: string;
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

export function parseRoutingPrompts(value: unknown): RoutingPrompts {
  if (!isRecord(value) || value.version !== 1)
    throw new Error("routing-prompts.json: version must be 1");
  const { workflow, stage, objectives, handoff } = value;
  const shipped = JSON.parse(defaultText) as RoutingPrompts;
  const taskRelation = value.taskRelation ?? shipped.taskRelation;
  const routingRules = value.routingRules ?? shipped.routingRules;
  const execution = value.execution ?? shipped.execution;
  if (
    !isRecord(workflow) ||
    !isRecord(stage) ||
    !isRecord(objectives) ||
    !isRecord(handoff) ||
    !isRecord(taskRelation) ||
    !isRecord(routingRules) ||
    !isRecord(execution)
  )
    throw new Error(
      "routing-prompts.json: workflow, stage, objectives, handoff, taskRelation, routingRules, and execution must be objects",
    );
  const choices = stringMap(workflow.choices, "workflow.choices");
  const relationChoices = stringMap(taskRelation.choices, "taskRelation.choices");
  for (const id of ["continue", "replace", "aside"] as const) nonempty(relationChoices[id], `taskRelation.choices.${id}`);
  if (Object.keys(relationChoices).length !== 3)
    throw new Error("routing-prompts.json: taskRelation.choices contains an unknown choice");
  for (const id of ["single", "scout", "clarify"] as const) nonempty(choices[id], `workflow.choices.${id}`);
  if (choices.plan !== undefined) nonempty(choices.plan, "workflow.choices.plan");
  if (choices.scout_plan !== undefined) nonempty(choices.scout_plan, "workflow.choices.scout_plan");
  if (Object.keys(choices).some(id => ![...choiceIds, ...retiredChoiceIds].includes(id as (typeof choiceIds)[number])))
    throw new Error(
      "routing-prompts.json: workflow.choices contains an unknown choice",
    );
  return {
    version: 1,
    workflow: {
      question: nonempty(workflow.question, "workflow.question"),
      constraints: nonempty(workflow.constraints, "workflow.constraints"),
      choices: Object.fromEntries(
        choiceIds.map((id) => [id, choices[id] ?? shipped.workflow.choices[id]]),
      ) as RoutingPrompts["workflow"]["choices"],
    },
    stage: {
      question: nonempty(stage.question, "stage.question"),
      constraints: nonempty(stage.constraints, "stage.constraints"),
    },
    taskRelation: {
      question: nonempty(taskRelation.question, "taskRelation.question"),
      constraints: nonempty(taskRelation.constraints, "taskRelation.constraints"),
      choices: relationChoices as RoutingPrompts["taskRelation"]["choices"],
    },
    routingRules: {
      workflowResolution: nonempty(routingRules.workflowResolution, "routingRules.workflowResolution"),
      stageResolution: nonempty(routingRules.stageResolution, "routingRules.stageResolution"),
    },
    objectives: {
      scout: nonempty(objectives.scout, "objectives.scout"),
      plan: nonempty(objectives.plan, "objectives.plan"),
      single: nonempty(objectives.single, "objectives.single"),
      afterHandoff: nonempty(
        objectives.afterHandoff,
        "objectives.afterHandoff",
      ),
      afterPlanHandoff: nonempty(
        objectives.afterPlanHandoff ?? shipped.objectives.afterPlanHandoff,
        "objectives.afterPlanHandoff",
      ),
    },
    modelCapabilities: stringMap(value.modelCapabilities, "modelCapabilities"),
    effortCapabilities: stringMap(
      value.effortCapabilities,
      "effortCapabilities",
    ),
    unknownModelCapability: nonempty(
      value.unknownModelCapability,
      "unknownModelCapability",
    ),
    unknownEffortCapability: nonempty(
      value.unknownEffortCapability,
      "unknownEffortCapability",
    ),
    execution: {
      savedTaskInstruction: nonempty(execution.savedTaskInstruction, "execution.savedTaskInstruction"),
      existingThreadInstruction: nonempty(execution.existingThreadInstruction, "execution.existingThreadInstruction"),
      usageRetryInstruction: nonempty(execution.usageRetryInstruction, "execution.usageRetryInstruction"),
    },
    handoff: {
      scoutObjective: nonempty(
        handoff.scoutObjective,
        "handoff.scoutObjective",
      ),
      planObjective: nonempty(handoff.planObjective, "handoff.planObjective"),
      planExecutionInstruction: nonempty(
        handoff.planExecutionInstruction ?? shipped.handoff.planExecutionInstruction,
        "handoff.planExecutionInstruction",
      ),
      instructions: nonempty(handoff.instructions, "handoff.instructions"),
      recentConversationLabel: nonempty(
        handoff.recentConversationLabel,
        "handoff.recentConversationLabel",
      ),
      originalRequestLabel: nonempty(
        handoff.originalRequestLabel,
        "handoff.originalRequestLabel",
      ),
      reportInstruction: nonempty(
        handoff.reportInstruction,
        "handoff.reportInstruction",
      ),
    },
  };
}

const defaultText = readFileSync(defaultPath, "utf8");
// The first shipped editable default. Refresh only this exact file, never user edits.
const legacyDefaultSha256 = new Set([
  "8d5313f5f956f5a0408b9d9b0cf133ee5d5db9b7ee7c75826763f329e26dee36",
  "b7598bd321ec4aec3ffb4826e9ff665a342a3c67d0bfe4ecf31cd2567782fc21",
  "d4ab14ad9720473b296e2456111b859c226eae99f1a3dd580d57c319dc8441d9",
  "32e9fecdb9404f8b4a756c0a62b46b7a3655297a331981385ba335e9b58b383a",
  "1be219548f02b21b7103bc26f7ca6f604e244dc33144243a46bf6e2619b56538",
]);
export const DEFAULT_ROUTING_PROMPTS = parseRoutingPrompts(
  JSON.parse(defaultText),
);

export function completionObjective(shape: string, prompts: RoutingPrompts): string {
  if (shape === "single") return prompts.objectives.single;
  if (shape === "plan" || shape === "scout_plan") return prompts.objectives.plan;
  return prompts.objectives.afterHandoff;
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
    let content = readFileSync(path, "utf8");
    if (legacyDefaultSha256.has(createHash("sha256").update(content.replace(/\r\n/g, "\n")).digest("hex"))) {
      writeFileSync(path, defaultText, "utf8");
      content = defaultText;
    }
    return parseRoutingPrompts(JSON.parse(content));
  } catch (error) {
    throw new Error(`Cannot load ${path}: ${String(error)}`);
  }
}
