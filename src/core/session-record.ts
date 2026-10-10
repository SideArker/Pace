import { EFFORTS, isRecord } from "../shared/config.js";
import type { Session } from "../shared/types.js";
import type { Usage } from "@openai/codex-sdk";
import { parseCheckpoint } from "./checkpoint.js";

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
    (value.choiceLabel === undefined || (typeof value.choiceLabel === 'string' && value.choiceLabel.length <= 500)) &&
    nonnegative(value.confidence) && (value.confidence as number) <= 1 && isRecord(value.probabilities) &&
    Object.values(value.probabilities).every(probability => nonnegative(probability) && (probability as number) <= 1) &&
    Number.isInteger(value.attempts) && (value.attempts as number) >= 0;
}
function isContextMeasurement(value: unknown): boolean {
  return isRecord(value) && nonnegative(value.tokens) &&
    nonnegative(value.windowTokens) && (value.windowTokens as number) > 0 &&
    (value.model === undefined || typeof value.model === "string");
}
function isManualWorkflow(value: unknown): boolean {
  if (!isRecord(value) || !["single", "scout", "plan_execute", "scout_plan_execute", "plan_verify"].includes(String(value.shape)) || !isRecord(value.routes)) return false;
  const routes = value.routes;
  const required = value.shape === "single" ? ["final"] : value.shape === "scout" ? ["scout", "final"]
    : value.shape === "scout_plan_execute" ? ["scout", "plan", "final"] : ["plan", "final"];
  if (Object.keys(routes).length !== required.length || required.some(stage => routes[stage] === undefined)) return false;
  return Object.entries(routes).every(([stage, route]) =>
    required.includes(stage) &&
    (route === "vex" || (isRecord(route) && typeof route.model === "string" &&
      (route.effort === undefined || EFFORTS.includes(route.effort as (typeof EFFORTS)[number])))));
}
function isCompaction(value: unknown): boolean {
  return isRecord(value) && typeof value.at === "string" &&
    typeof value.threadId === "string" && isRecord(value.route) &&
    (value.route.model === undefined || typeof value.route.model === "string") &&
    (value.route.effort === undefined || EFFORTS.includes(value.route.effort as (typeof EFFORTS)[number])) &&
    nonnegative(value.durationMs) &&
    ["completed", "failed", "cancelled"].includes(String(value.outcome)) &&
    (value.usage === undefined || isUsage(value.usage)) &&
    (value.estimatedCostUsd === undefined || nonnegative(value.estimatedCostUsd)) &&
    (value.error === undefined || typeof value.error === "string");
}
function isCheckpoint(value: unknown): boolean {
  if (!isRecord(value) || typeof value.createdAt !== "string" || typeof value.sourceTurnAt !== "string" ||
    typeof value.threadId !== "string" || !isRecord(value.route) ||
    (value.route.model !== undefined && typeof value.route.model !== "string") ||
    (value.route.effort !== undefined && !EFFORTS.includes(value.route.effort as (typeof EFFORTS)[number])) ||
    !isRecord(value.note) || !nonnegative(value.durationMs) || (value.usage !== undefined && !isUsage(value.usage)) ||
    (value.estimatedCostUsd !== undefined && !nonnegative(value.estimatedCostUsd))) return false;
  try { parseCheckpoint(JSON.stringify(value.note)); return true; } catch { return false; }
}
function isCheckpointGeneration(value: unknown): boolean {
  return isRecord(value) && typeof value.at === "string" && typeof value.sourceTurnAt === "string" &&
    typeof value.threadId === "string" && isRecord(value.route) &&
    (value.route.model === undefined || typeof value.route.model === "string") &&
    (value.route.effort === undefined || EFFORTS.includes(value.route.effort as (typeof EFFORTS)[number])) &&
    nonnegative(value.durationMs) && ["valid", "invalid", "failed", "cancelled"].includes(String(value.outcome)) &&
    (value.usage === undefined || isUsage(value.usage)) &&
    (value.estimatedCostUsd === undefined || nonnegative(value.estimatedCostUsd)) &&
    (value.error === undefined || typeof value.error === "string");
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
    (value.threadTurnCount !== undefined && (!Number.isInteger(value.threadTurnCount) || (value.threadTurnCount as number) < 0)) ||
    (value.contextByThread !== undefined && (!isRecord(value.contextByThread) ||
      !Object.entries(value.contextByThread).every(([id, reading]) => !!id && isContextMeasurement(reading)))) ||
    (value.compactions !== undefined && (!Array.isArray(value.compactions) || !value.compactions.every(isCompaction))) ||
    (value.checkpoint !== undefined && !isCheckpoint(value.checkpoint)) ||
    (value.checkpointGenerations !== undefined && (!Array.isArray(value.checkpointGenerations) ||
      !value.checkpointGenerations.every(isCheckpointGeneration))) ||
    !Array.isArray(value.turns) ||
    !value.turns.every(
      (turn: unknown) =>
        isRecord(turn) &&
        typeof turn.prompt === "string" &&
        typeof turn.result === "string" &&
        typeof turn.at === "string" &&
        (turn.route === undefined || (isRecord(turn.route) && (turn.route.model === undefined || typeof turn.route.model === "string") && (turn.route.effort === undefined || EFFORTS.includes(turn.route.effort as (typeof EFFORTS)[number])))) &&
        (turn.routeNote === undefined || typeof turn.routeNote === "string") &&
        (turn.activities === undefined || (Array.isArray(turn.activities) && turn.activities.length <= 200 && turn.activities.every((activity: unknown) =>
          isRecord(activity) && ["thinking", "command", "files", "tool", "search", "plan"].includes(String(activity.category)) &&
          typeof activity.text === "string" && activity.text.length <= 2000 &&
          (activity.detail === undefined || (typeof activity.detail === "string" && activity.detail.length <= 12000)) &&
          (activity.outcome === undefined || activity.outcome === "success" || activity.outcome === "failure") &&
          (activity.durationMs === undefined || nonnegative(activity.durationMs)) &&
          (activity.tokens === undefined || nonnegative(activity.tokens))))) &&
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
    (value.tasks !== undefined && (!Array.isArray(value.tasks) || value.tasks.length > 100 ||
      !value.tasks.every((task: unknown) => isRecord(task) && typeof task.id === "string" && task.id.length <= 100 &&
        typeof task.text === "string" && task.text.length <= 500 && typeof task.completed === "boolean" &&
        (task.source === "user" || task.source === "agent")))) ||
    (value.activeTask !== undefined && (!isRecord(value.activeTask) ||
      typeof value.activeTask.originalRequest !== "string" || value.activeTask.originalRequest.length > 8000 ||
      !Array.isArray(value.activeTask.instructions) || value.activeTask.instructions.length > 12 ||
      !value.activeTask.instructions.every((item: unknown) => typeof item === "string" && item.length <= 4000) ||
      (value.activeTask.latestOutcome !== undefined &&
        (typeof value.activeTask.latestOutcome !== "string" || value.activeTask.latestOutcome.length > 2000)) ||
      (value.activeTask.failed !== undefined && typeof value.activeTask.failed !== "boolean"))) ||
    (value.deferredTurn !== undefined && (!isRecord(value.deferredTurn) ||
      typeof value.deferredTurn.prompt !== "string" || !value.deferredTurn.prompt.trim() ||
      typeof value.deferredTurn.retryAt !== "string" || !Number.isFinite(Date.parse(value.deferredTurn.retryAt)) ||
      !Number.isInteger(value.deferredTurn.attempt) || (value.deferredTurn.attempt as number) < 1)) ||
    (value.routingMode !== "auto" && value.routingMode !== "manual")
    || (value.manualWorkflow !== undefined && !isManualWorkflow(value.manualWorkflow))
  )
    return undefined;
  return value as Session;
}
