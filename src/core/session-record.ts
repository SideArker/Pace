import { EFFORTS, isRecord } from "../shared/config.js";
import type { Session } from "../shared/types.js";
import type { Usage } from "@openai/codex-sdk";

function isUsage(value: unknown): value is Usage {
  if (!isRecord(value)) return false;
  const record = value;
  return ["input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens", "reasoning_output_tokens"].every(key => typeof record[key] === "number");
}
const nonnegative = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
function isStage(value: unknown): boolean {
  return isRecord(value) && typeof value.objective === 'string' && isRecord(value.route) &&
    (value.route.model === undefined || typeof value.route.model === 'string') &&
    (value.route.effort === undefined || EFFORTS.includes(value.route.effort as (typeof EFFORTS)[number])) &&
    nonnegative(value.durationMs) && (value.usage === undefined || isUsage(value.usage)) &&
    (value.estimatedCostUsd === undefined || nonnegative(value.estimatedCostUsd)) &&
    (value.handoff === undefined || (typeof value.handoff === 'string' && value.handoff.length <= 20_000));
}
function isRouting(value: unknown): boolean {
  return isRecord(value) && typeof value.objective === 'string' && typeof value.choice === 'string' &&
    nonnegative(value.confidence) && (value.confidence as number) <= 1 && isRecord(value.probabilities) &&
    Object.values(value.probabilities).every(probability => nonnegative(probability) && (probability as number) <= 1) &&
    Number.isInteger(value.attempts) && (value.attempts as number) >= 0;
}

export function parseSession(value: unknown, project: string): Session | undefined {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !/^[0-9a-f-]{36}$/.test(value.id) ||
    (value.title !== undefined && (typeof value.title !== "string" || value.title.length > 120)) ||
    value.projectPath !== project ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    (value.threadId !== undefined && typeof value.threadId !== "string") ||
    !Array.isArray(value.turns) ||
    !value.turns.every(
      (turn: unknown) =>
        isRecord(turn) &&
        typeof turn.prompt === "string" &&
        typeof turn.result === "string" &&
        typeof turn.at === "string" &&
        (turn.route === undefined || (isRecord(turn.route) && (turn.route.model === undefined || typeof turn.route.model === "string") && (turn.route.effort === undefined || EFFORTS.includes(turn.route.effort as (typeof EFFORTS)[number])))) &&
        (turn.routeNote === undefined || typeof turn.routeNote === "string") &&
        (turn.durationMs === undefined || (typeof turn.durationMs === "number" && Number.isFinite(turn.durationMs) && turn.durationMs >= 0)) &&
        (turn.usage === undefined || isUsage(turn.usage)) &&
        (turn.estimatedCostUsd === undefined || nonnegative(turn.estimatedCostUsd)) &&
        (turn.stages === undefined || (Array.isArray(turn.stages) && turn.stages.every(isStage))) &&
        (turn.routing === undefined || (Array.isArray(turn.routing) && turn.routing.every(isRouting))) &&
        (turn.artifacts === undefined || (Array.isArray(turn.artifacts) && turn.artifacts.every((artifact: unknown) => typeof artifact === "string" && /^\.pace\/artifacts\/[^/\\]+\.md$/.test(artifact)))) &&
        (turn.failed === undefined || typeof turn.failed === "boolean") &&
        (turn.cancelled === undefined || typeof turn.cancelled === "boolean"),
    ) ||
    !isRecord(value.route) ||
    (value.route.model !== undefined &&
      typeof value.route.model !== "string") ||
    (value.route.effort !== undefined &&
      !EFFORTS.includes(value.route.effort as (typeof EFFORTS)[number])) ||
    (value.activeSkills !== undefined && (!Array.isArray(value.activeSkills) ||
      !value.activeSkills.every((name: unknown) => typeof name === "string" && /^[a-z0-9][a-z0-9_-]*$/i.test(name)))) ||
    (value.skillOptions !== undefined && (!isRecord(value.skillOptions) ||
      !Object.entries(value.skillOptions).every(([name, option]) => /^[a-z0-9][a-z0-9_-]*$/i.test(name) && typeof option === "string" && option.length <= 80))) ||
    (value.routingMode !== "auto" && value.routingMode !== "manual")
  )
    return undefined;
  return value as Session;
}
