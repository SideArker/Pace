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
const choiceIds = ["single", "scout", "plan_execute", "clarify"] as const;

export type RoutingPrompts = {
  version: 1;
  workflow: {
    question: string;
    constraints: string;
    choices: Record<(typeof choiceIds)[number], string>;
  };
  stage: { question: string; constraints: string };
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
  handoff: {
    scoutObjective: string;
    planObjective: string;
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
  if (
    !isRecord(workflow) ||
    !isRecord(stage) ||
    !isRecord(objectives) ||
    !isRecord(handoff)
  )
    throw new Error(
      "routing-prompts.json: workflow, stage, objectives, and handoff must be objects",
    );
  const choices = stringMap(workflow.choices, "workflow.choices");
  for (const id of choiceIds) nonempty(choices[id], `workflow.choices.${id}`);
  if (Object.keys(choices).length !== choiceIds.length)
    throw new Error(
      "routing-prompts.json: workflow.choices must contain exactly single, scout, plan_execute, clarify",
    );
  return {
    version: 1,
    workflow: {
      question: nonempty(workflow.question, "workflow.question"),
      constraints: nonempty(workflow.constraints, "workflow.constraints"),
      choices: Object.fromEntries(
        choiceIds.map((id) => [id, choices[id]]),
      ) as RoutingPrompts["workflow"]["choices"],
    },
    stage: {
      question: nonempty(stage.question, "stage.question"),
      constraints: nonempty(stage.constraints, "stage.constraints"),
    },
    objectives: {
      scout: nonempty(objectives.scout, "objectives.scout"),
      plan: nonempty(objectives.plan, "objectives.plan"),
      single: nonempty(objectives.single, "objectives.single"),
      afterHandoff: nonempty(
        objectives.afterHandoff,
        "objectives.afterHandoff",
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
    handoff: {
      scoutObjective: nonempty(
        handoff.scoutObjective,
        "handoff.scoutObjective",
      ),
      planObjective: nonempty(handoff.planObjective, "handoff.planObjective"),
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
const legacyDefaultSha256 = "d4ab14ad9720473b296e2456111b859c226eae99f1a3dd580d57c319dc8441d9";
export const DEFAULT_ROUTING_PROMPTS = parseRoutingPrompts(
  JSON.parse(defaultText),
);

export function completionObjective(shape: string, prompts: RoutingPrompts): string {
  if (shape === "single") return prompts.objectives.single;
  if (shape === "plan_execute")
    return `${prompts.objectives.afterHandoff}. The previous stage produced a read-only plan; this stage must implement the requested change and verify it.`;
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
    if (createHash("sha256").update(content.replace(/\r\n/g, "\n")).digest("hex") === legacyDefaultSha256) {
      writeFileSync(path, defaultText, "utf8");
      content = defaultText;
    }
    return parseRoutingPrompts(JSON.parse(content));
  } catch (error) {
    throw new Error(`Cannot load ${path}: ${String(error)}`);
  }
}
