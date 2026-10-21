import { isRecord } from "../shared/config.js";
import type { RoutingSuite } from "./routing-types.js";
export type { RoutingCase, RoutingSuite } from "./routing-types.js";

const SHAPES = ["single", "scout", "plan", "scout_plan", "clarify", "aside"];
export function parseRoutingSuite(value: unknown): RoutingSuite {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !Array.isArray(value.cases) ||
    !value.cases.length
  )
    throw new Error("Routing suite needs version 1 and nonempty cases");
  const ids = new Set<string>();
  for (const item of value.cases) {
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      !/^[a-z0-9_-]+$/.test(item.id) ||
      ids.has(item.id) ||
      typeof item.category !== "string" ||
      !item.category ||
      typeof item.prompt !== "string" ||
      !item.prompt.trim() ||
      !SHAPES.includes(String(item.preferred)) ||
      !Array.isArray(item.acceptable) ||
      !item.acceptable.length ||
      !item.acceptable.every(
        (shape: unknown) => typeof shape === "string" && SHAPES.includes(shape),
      ) ||
      !item.acceptable.includes(item.preferred) ||
      typeof item.reason !== "string" ||
      !item.reason.trim()
    )
      throw new Error(
        `Invalid routing case ${isRecord(item) ? String(item.id) : ""}`,
      );
    if (
      item.conversation !== undefined &&
      (!Array.isArray(item.conversation) ||
        !item.conversation.every(
          (turn) =>
            isRecord(turn) &&
            typeof turn.user === "string" &&
            typeof turn.assistant === "string",
        ))
    )
      throw new Error(`Invalid conversation for ${item.id}`);
    if (
      item.handoff !== undefined &&
      (!isRecord(item.handoff) ||
        typeof item.handoff.summary !== "string" ||
        !Array.isArray(item.handoff.findings) ||
        !item.handoff.findings.every(
          (finding) =>
            isRecord(finding) &&
            typeof finding.path === "string" &&
            typeof finding.finding === "string" &&
            typeof finding.relevance === "string" &&
            (finding.line === undefined ||
              (typeof finding.line === "number" &&
                Number.isInteger(finding.line) &&
                finding.line > 0)),
        ) ||
        !["nextSteps", "checks", "risks"].every(
          (key) =>
            Array.isArray((item.handoff as Record<string, unknown>)[key]) &&
            ((item.handoff as Record<string, unknown>)[key] as unknown[]).every(
              (value) => typeof value === "string",
            ),
        ))
    )
      throw new Error(`Invalid handoff for ${item.id}`);
    if (item.expectedAction !== undefined && !["continue", "aside", "reroute", "replan", "replace", "clarify", "adopt_side"].includes(String(item.expectedAction))) throw new Error(`Invalid action for ${item.id}`);
    if (item.task !== undefined && (!isRecord(item.task) || typeof item.task.originalRequest !== "string" || !Array.isArray(item.task.instructions) || !item.task.instructions.every(entry => typeof entry === "string"))) throw new Error(`Invalid task for ${item.id}`);
    ids.add(item.id);
  }
  return value as RoutingSuite;
}
