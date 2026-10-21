import { createHash } from "node:crypto";
import { EFFORTS, isRecord } from "../shared/config.js";
import type { OperationIntent, QueuedOperation, Session } from "../shared/types.js";
import type { Usage } from "@openai/codex-sdk";
import { parseCheckpoint } from "./checkpoint.js";
import { validOperation } from "./operations.js";

function isUsage(value: unknown): value is Usage {
  if (!isRecord(value)) return false;
  const record = value;
  return ["input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens", "reasoning_output_tokens"].every(key => typeof record[key] === "number" && Number.isFinite(record[key]) && (record[key] as number) >= 0);
}
const nonnegative = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const integer = (value: unknown) => nonnegative(value) && Number.isInteger(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const optionalText = (value: unknown) => value === undefined || typeof value === "string";
const oneOf = (value: unknown, choices: readonly string[]) => typeof value === "string" && choices.includes(value);
const role = (value: unknown) => oneOf(value, ["main", "scout", "verifier", "aside", "status"]);
const assessment = (value: unknown) => oneOf(value, ["closed", "partial", "unknown"]);
function isIntent(value: unknown): value is OperationIntent {
  return oneOf(value, ["verify_plan", "execute_plan", "revise_plan", "continue_verify", "aside", "adopt_side"]);
}
function isRoute(value: unknown): boolean {
  return isRecord(value) && optionalText(value.model) &&
    (value.effort === undefined || EFFORTS.includes(value.effort as (typeof EFFORTS)[number]));
}
function isTask(value: unknown): boolean {
  return isRecord(value) && typeof value.id === "string" && value.id.length <= 100 &&
    typeof value.text === "string" && value.text.length <= 500 && typeof value.completed === "boolean" &&
    oneOf(value.source, ["user", "agent"]);
}
function isObservation(value: unknown): boolean {
  return isRecord(value) && oneOf(value.kind, ["activity", "tasks", "answer", "artifacts"]) && optionalText(value.text) &&
    (value.items === undefined || (Array.isArray(value.items) && value.items.every(item =>
      isRecord(item) && typeof item.text === "string" && typeof item.completed === "boolean"))) &&
    (value.paths === undefined || (Array.isArray(value.paths) && value.paths.every(path => typeof path === "string")));
}
function isAttempt(value: unknown): boolean {
  return isRecord(value) && text(value.id) && text(value.taskId) && integer(value.generation) && text(value.stage) && role(value.role) &&
    oneOf(value.status, ["pending", "running", "completed", "failed", "cancelled", "awaiting_user"]) &&
    isRoute(value.route) && typeof value.startedAt === "string" &&
    ["threadId", "turnId", "finishedAt", "result", "error", "handoff"].every(key => optionalText(value[key])) &&
    ["durationMs", "estimatedCostUsd", "knownCostUsd"].every(key => value[key] === undefined || nonnegative(value[key])) &&
    ["usage", "knownUsage"].every(key => value[key] === undefined || isUsage(value[key])) &&
    (value.usageComplete === undefined || typeof value.usageComplete === "boolean") &&
    Array.isArray(value.observations) && value.observations.every(isObservation) &&
    (value.assessment === undefined || (isRecord(value.assessment) && assessment(value.assessment.value) &&
      integer(value.assessment.evidence) && text(value.assessment.decisionId)));
}
function isControl(value: unknown): boolean {
  return isRecord(value) && text(value.id) && ["taskId", "attemptId", "stage"].every(key => optionalText(value[key])) &&
    role(value.role) && text(value.objective) && text(value.choice) && nonnegative(value.confidence) &&
    (value.confidence as number) <= 1 && isRecord(value.probabilities) &&
    Object.values(value.probabilities).every(probability => nonnegative(probability) && (probability as number) <= 1) &&
    nonnegative(value.durationMs) && typeof value.at === "string" && oneOf(value.source, ["vex", "user"]) && value.contextAction === "continue";
}
function isSide(value: unknown): boolean {
  return isRecord(value) && text(value.id) && optionalText(value.taskId) && text(value.attemptId) &&
    typeof value.question === "string" && typeof value.snapshotAt === "string" && isRoute(value.route) &&
    ["result", "error", "threadId"].every(key => optionalText(value[key])) &&
    (value.adopted === undefined || typeof value.adopted === "boolean");
}
function isWorkflow(value: unknown): boolean {
  return isRecord(value) && value.version === 1 && integer(value.generation) &&
    oneOf(value.shape, ["single", "scout", "plan", "scout_plan"]) &&
    oneOf(value.stage, ["scout", "plan", "final"]) &&
    (value.mainRoute === undefined || isRoute(value.mainRoute)) && optionalText(value.mainThreadId) && optionalText(value.scoutHandoff) &&
    oneOf(value.source, ["vex", "user"]) && (value.needsAssessment === undefined || typeof value.needsAssessment === "boolean");
}
function isDeferred(value: unknown): boolean {
  return isRecord(value) && typeof value.prompt === "string" && !!value.prompt.trim() &&
    typeof value.retryAt === "string" && Number.isFinite(Date.parse(value.retryAt)) && integer(value.attempt) && (value.attempt as number) >= 1 &&
    (value.reason === undefined || oneOf(value.reason, ["usage", "network", "capacity"])) &&
    (value.intent === undefined || isIntent(value.intent)) && optionalText(value.displayPrompt) &&
    (value.operation === undefined || validOperation(value.operation));
}
function validNewFields(value: Record<string, unknown>): boolean {
  const records = (field: string, validate: (item: unknown) => boolean) => value[field] === undefined ||
    (Array.isArray(value[field]) && value[field].every(validate) &&
      new Set((value[field] as Record<string, unknown>[]).map(item => item.id)).size === value[field].length);
  return (value.revision === undefined || integer(value.revision)) &&
    (value.deferredTurn === undefined || isDeferred(value.deferredTurn)) && records("attempts", isAttempt) &&
    records("controlDecisions", isControl) && records("sideAnswers", isSide) &&
    (value.activeTask === undefined || (isRecord(value.activeTask) && optionalText(value.activeTask.id) &&
      (value.activeTask.workflow === undefined || isWorkflow(value.activeTask.workflow)) &&
      (value.activeTask.assessment === undefined || assessment(value.activeTask.assessment)))) &&
    (value.verifier === undefined || (isRecord(value.verifier) && isRoute(value.verifier.route) && optionalText(value.verifier.threadId) &&
      (value.verifier.threadTurnCount === undefined || integer(value.verifier.threadTurnCount)) &&
      (value.verifier.context === undefined || isContextMeasurement(value.verifier.context)) &&
      (value.verifier.tasks === undefined || (Array.isArray(value.verifier.tasks) && value.verifier.tasks.length <= 100 && value.verifier.tasks.every(isTask))))) &&
    (value.executionSource === undefined || (isRecord(value.executionSource) && text(value.executionSource.sessionId) &&
      optionalText(value.executionSource.taskId) && optionalText(value.executionSource.artifact) && typeof value.executionSource.plan === "string")) &&
    (value.queuedPrompts === undefined || (Array.isArray(value.queuedPrompts) &&
      value.queuedPrompts.every(item => typeof item === "string" || validOperation(item))));
}
/** Legacy text entries acquire deterministic IDs, preserving identity across repeated reads. */
function queuedOperations(value: unknown, sessionId: string): QueuedOperation[] {
  return Array.isArray(value) ? value.map((item, index) => {
    if (typeof item !== "string") return structuredClone(item as QueuedOperation);
    const digest = createHash("sha256").update(JSON.stringify([sessionId, index, item])).digest("hex");
    const id = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
    return { id, text: item, sessionId, role: "main" };
  }) : [];
}

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
  if (!isRecord(value) || !["single", "scout", "plan", "scout_plan", "plan_execute", "scout_plan_execute", "plan_verify"].includes(String(value.shape)) || !isRecord(value.routes)) return false;
  const routes = value.routes;
  const required = value.shape === "single" || value.shape === "plan" ? ["final"]
    : value.shape === "scout" || value.shape === "scout_plan" ? ["scout", "final"]
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

function isTurn(turn: unknown): boolean {
  return isRecord(turn) &&
        (turn.fileEdits === undefined || turn.fileEdits === "none" || (typeof turn.fileEdits === "string" && /^[0-9a-f-]{36}$/.test(turn.fileEdits))) &&
        typeof turn.prompt === "string" &&
        (turn.displayPrompt === undefined || typeof turn.displayPrompt === "string") &&
        (turn.intent === undefined || isIntent(turn.intent)) &&
        (turn.operation === undefined || validOperation(turn.operation)) &&
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
        (turn.artifacts === undefined || (Array.isArray(turn.artifacts) && turn.artifacts.every((artifact: unknown) => typeof artifact === "string" && /^(?:\.pace\/)?artifacts\/[^/\\]+\.md$/.test(artifact)))) &&
        (turn.failed === undefined || typeof turn.failed === "boolean") &&
        (turn.cancelled === undefined || typeof turn.cancelled === "boolean");
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
    !validNewFields(value) ||
    (value.threadId !== undefined && typeof value.threadId !== "string") ||
    (value.threadTurnCount !== undefined && (!Number.isInteger(value.threadTurnCount) || (value.threadTurnCount as number) < 0)) ||
    (value.contextByThread !== undefined && (!isRecord(value.contextByThread) ||
      !Object.entries(value.contextByThread).every(([id, reading]) => !!id && isContextMeasurement(reading)))) ||
    (value.compactions !== undefined && (!Array.isArray(value.compactions) || !value.compactions.every(isCompaction))) ||
    (value.checkpoint !== undefined && !isCheckpoint(value.checkpoint)) ||
    (value.checkpointGenerations !== undefined && (!Array.isArray(value.checkpointGenerations) ||
      !value.checkpointGenerations.every(isCheckpointGeneration))) ||
    !Array.isArray(value.turns) ||
    !value.turns.every(isTurn) ||
    (value.undoneTurns !== undefined && (!Array.isArray(value.undoneTurns) || value.undoneTurns.length > 20 || !value.undoneTurns.every(isTurn))) ||
    !isRecord(value.route) ||
    (value.route.model !== undefined &&
      typeof value.route.model !== "string") ||
    (value.route.effort !== undefined &&
      !EFFORTS.includes(value.route.effort as (typeof EFFORTS)[number])) ||
    (value.planRoute !== undefined && (!isRecord(value.planRoute) ||
      (value.planRoute.model !== undefined && typeof value.planRoute.model !== "string") ||
      (value.planRoute.effort !== undefined && !EFFORTS.includes(value.planRoute.effort as (typeof EFFORTS)[number])))) ||
    (value.verifierThreadId !== undefined && (typeof value.verifierThreadId !== "string" || value.verifierThreadId.length > 200)) ||
    (value.activeSkills !== undefined && (!Array.isArray(value.activeSkills) ||
      !value.activeSkills.every((name: unknown) => typeof name === "string" && /^[a-z0-9][a-z0-9_-]*$/i.test(name)))) ||
    (value.autoLaunchSkills !== undefined && (!Array.isArray(value.autoLaunchSkills) || value.autoLaunchSkills.length > 32 ||
      !value.autoLaunchSkills.every((name: unknown) => typeof name === "string" && /^[a-z0-9][a-z0-9_-]*$/i.test(name)))) ||
    (value.autoLaunchThreadId !== undefined && (typeof value.autoLaunchThreadId !== "string" || !value.autoLaunchThreadId || value.autoLaunchThreadId.length > 200)) ||
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
      !Number.isInteger(value.deferredTurn.attempt) || (value.deferredTurn.attempt as number) < 1 ||
      (value.deferredTurn.reason !== undefined && !["usage", "network", "capacity"].includes(String(value.deferredTurn.reason))) ||
      (value.deferredTurn.intent !== undefined && !isIntent(value.deferredTurn.intent)) ||
      (value.deferredTurn.displayPrompt !== undefined && typeof value.deferredTurn.displayPrompt !== "string"))) ||
    (value.kind !== undefined && value.kind !== "normal" && value.kind !== "planning") ||
    (value.plan !== undefined && (typeof value.plan !== "string" || value.plan.length > 50000)) ||
    (value.planArtifact !== undefined && (typeof value.planArtifact !== "string" || !/^(?:\.pace\/)?artifacts\/[^/\\]+\.pace-plan\.md$/.test(value.planArtifact))) ||
    (value.pendingPlanArtifact !== undefined && (typeof value.pendingPlanArtifact !== "string" || !/^artifacts\/[^/\\]+\.pace-plan\.md$/.test(value.pendingPlanArtifact))) ||
    (value.routingMode !== "auto" && value.routingMode !== "manual")
    || (value.manualWorkflow !== undefined && !isManualWorkflow(value.manualWorkflow))
  )
    return undefined;
  return { ...value, ...(value.queuedPrompts === undefined ? {} : { queuedPrompts: queuedOperations(value.queuedPrompts, value.id) }) } as Session;
}

export function parseSessionSummary(value: unknown, project: string): Session | undefined {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !/^[0-9a-f-]{36}$/.test(value.id) ||
    (value.title !== undefined && (typeof value.title !== "string" || value.title.length > 120)) ||
    value.projectPath !== project ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string" || !validNewFields(value)
  ) {
    return undefined;
  }

  const firstTurnPrompt = Array.isArray(value.turns) && isRecord(value.turns[0]) && typeof value.turns[0].prompt === "string"
    ? value.turns[0].prompt
    : undefined;

  const route = isRecord(value.route)
    ? {
        model: typeof value.route.model === "string" ? value.route.model : undefined,
        effort: EFFORTS.includes(value.route.effort as (typeof EFFORTS)[number])
          ? (value.route.effort as (typeof EFFORTS)[number])
          : undefined,
      }
    : {};

  const deferredTurn = isRecord(value.deferredTurn) &&
    typeof value.deferredTurn.prompt === "string" &&
    typeof value.deferredTurn.retryAt === "string" &&
    typeof value.deferredTurn.attempt === "number"
      ? {
          prompt: value.deferredTurn.prompt,
          retryAt: value.deferredTurn.retryAt,
          attempt: value.deferredTurn.attempt,
          ...(value.deferredTurn.reason === "usage" || value.deferredTurn.reason === "network" || value.deferredTurn.reason === "capacity" ? { reason: value.deferredTurn.reason as "usage" | "network" | "capacity" } : {}),
          ...(isIntent(value.deferredTurn.intent) ? { intent: value.deferredTurn.intent } : {}),
          ...(typeof value.deferredTurn.displayPrompt === "string" ? { displayPrompt: value.deferredTurn.displayPrompt } : {}),
          ...(validOperation(value.deferredTurn.operation) ? { operation: structuredClone(value.deferredTurn.operation) } : {}),
        }
      : undefined;

  return {
    id: value.id,
    kind: value.kind === "planning" ? "planning" : "normal",
    title: typeof value.title === "string" ? value.title : undefined,
    projectPath: project,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    routingMode: value.routingMode === "manual" ? "manual" : "auto",
    route,
    ...(isRecord(value.planRoute) ? { planRoute: {
      model: typeof value.planRoute.model === "string" ? value.planRoute.model : undefined,
      effort: EFFORTS.includes(value.planRoute.effort as (typeof EFFORTS)[number]) ? value.planRoute.effort as (typeof EFFORTS)[number] : undefined,
    } } : {}),
    ...(typeof value.verifierThreadId === "string" ? { verifierThreadId: value.verifierThreadId } : {}),
    deferredTurn,
    queuedPrompts: queuedOperations(value.queuedPrompts, value.id),
    ...Object.fromEntries(["revision", "attempts", "controlDecisions", "sideAnswers", "activeTask", "verifier", "executionSource"]
      .filter(key => value[key] !== undefined).map(key => [key, structuredClone(value[key])])),
    turns: firstTurnPrompt ? [{ prompt: firstTurnPrompt, result: "", at: value.createdAt }] : [],
  };
}
