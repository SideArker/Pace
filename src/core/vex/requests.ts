import type { ModelOption, Route, Session, TurnSummary } from "../../shared/types.js";
import { PRICE_SNAPSHOT, modelRates } from "../routing/pricing.js";
import { routeChoices, type RoutingChoice } from "../routing/router.js";
import {
  DEFAULT_ROUTING_PROMPTS,
  type RoutingPrompts,
} from "../routing/routing-prompts.js";
export type VexRequest = {
  question: string;
  context: Record<string, unknown>;
  options: RoutingChoice[];
  constraints: string;
  decisionType: "routing";
};
export type RoutingState = {
  previousRoute?: Route;
  openTasks?: string[];
  hasCodexThread?: boolean;
  activeTask?: Session["activeTask"];
};
function excerpt(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const marker = "\n[Earlier text omitted for routing; full text goes to Codex.]\n";
  const available = limit - marker.length;
  const head = Math.ceil(available * 0.6);
  return `${value.slice(0, head)}${marker}${value.slice(-(available - head))}`;
}
function recentConversation(turns: TurnSummary[]) {
  return turns.slice(-10).map(turn => ({
    user: excerpt(turn.prompt, 1200),
    assistant: excerpt(turn.result, 1200),
    route: turn.route, stages: turn.stages, routing: turn.routing,
    intent: turn.intent, operation: turn.operation, questions: turn.questions, artifacts: turn.artifacts,
    role: turn.intent === "verify_plan" || turn.intent === "continue_verify" ? "verifier" : "main",
    ...(turn.failed ? { failed: true } : {}),
    ...(turn.cancelled ? { cancelled: true } : {}),
  }));
}
function compactState(state: RoutingState): RoutingState {
  return {
    ...state,
    openTasks: state.openTasks?.slice(-8).map(item => excerpt(item, 300)),
    activeTask: state.activeTask ? {
      ...state.activeTask,
      originalRequest: excerpt(state.activeTask.originalRequest, 3000),
      instructions: state.activeTask.instructions.slice(-4).map(item => excerpt(item, 800)),
      latestOutcome: state.activeTask.latestOutcome ? excerpt(state.activeTask.latestOutcome, 800) : undefined,
      failed: state.activeTask.failed,
    } : undefined,
  };
}
export function taskRelationRequest(prompt: string, turns: TurnSummary[], state: RoutingState, prompts = DEFAULT_ROUTING_PROMPTS): VexRequest {
  return {
    question: prompts.taskRelation.question,
    context: { latestRequest: excerpt(prompt, 12000), recentConversation: recentConversation(turns), conversationState: compactState(state) },
    options: Object.entries(prompts.taskRelation.choices).map(([id, description]) => ({ id, description })),
    constraints: prompts.taskRelation.constraints,
    decisionType: "routing",
  };
}
export class VexDiagnosticError extends Error {
  constructor(readonly stage: "discovery" | "startup" | "connection" | "tool validation", cause: unknown) {
    super(`${stage}: ${String(cause)}`, { cause });
  }
}
function taskContext(
  prompt: string,
  turns: TurnSummary[],
  models: ModelOption[],
  prompts: RoutingPrompts,
  state?: RoutingState,
) {
  return {
    originalRequest: excerpt(prompt, 12000),
    recentConversation: recentConversation(turns),
    ...(state ? { conversationState: compactState(state) } : {}),
    availableModels: models.map((model) => ({
      id: model.model,
      capability:
        prompts.modelCapabilities[model.model] ??
        prompts.unknownModelCapability,
      supportedEfforts: model.efforts.map((effort) => ({
        id: effort,
        capability:
          prompts.effortCapabilities[effort] ?? prompts.unknownEffortCapability,
      })),
      standardUsdPerMillionTokens: modelRates(model.model),
    })),
    priceSnapshot: {
      checkedAt: PRICE_SNAPSHOT.checkedAt,
      source: PRICE_SNAPSHOT.source,
      processing: PRICE_SNAPSHOT.processing,
      context: PRICE_SNAPSHOT.context,
    },
  };
}
export const shapeChoices: RoutingChoice[] = Object.entries(
  DEFAULT_ROUTING_PROMPTS.workflow.choices,
).map(([id, description]) => ({ id, description }));
export function shapeRequest(
  prompt: string,
  turns: TurnSummary[],
  models: ModelOption[],
  prompts = DEFAULT_ROUTING_PROMPTS,
  state?: RoutingState,
): VexRequest {
  const configuredChoices = Object.entries(prompts.workflow.choices).map(
    ([id, description]) => ({ id, description }),
  );
  const options = models.some(model => model.enabled !== false && model.efforts.length) ? configuredChoices : configuredChoices.filter(choice => !["scout", "scout_plan"].includes(choice.id));
  return {
    question: prompts.workflow.question,
    context: taskContext(prompt, turns, models, prompts, state),
    options,
    decisionType: "routing",
    constraints: `${prompts.workflow.constraints}\n\n${prompts.routingRules.workflowResolution}\n\nPlan and scout_plan stop after saving a plan in conversation artifacts. Project files remain read-only in planning mode. Only /execute may start implementation from that plan. Retired plan_execute, scout_plan_execute, and plan_verify choices are unavailable.`,
  };
}
export function stageRequest(
  prompt: string,
  turns: TurnSummary[],
  models: ModelOption[],
  objective: string,
  handoff?: string,
  availableModels = models,
  prompts = DEFAULT_ROUTING_PROMPTS,
  state?: RoutingState,
): VexRequest {
  const options = routeChoices(models);
  return {
    question: prompts.stage.question,
    context: {
      ...taskContext(prompt, turns, availableModels, prompts, state),
      stageObjective: objective,
      ...(handoff ? { priorStageHandoff: handoff } : {}),
    },
    options,
    decisionType: "routing",
    constraints: `${prompts.stage.constraints}\n\n${prompts.routingRules.stageResolution}`,
  };
}

export function controlRequest(prompt: string, session: Session, prompts = DEFAULT_ROUTING_PROMPTS): VexRequest {
  const choices = Object.entries(prompts.control.choices).filter(([id]) => id !== "adopt_side" || session.sideAnswers?.some(answer => answer.result && !answer.error && answer.taskId === session.activeTask?.id));
  return { question: prompts.control.question, decisionType: "routing", options: choices.map(([id, description]) => ({ id, description })), constraints: prompts.control.constraints,
    context: { latestRequest: excerpt(prompt, 12000), recentConversation: recentConversation(session.turns), activeTask: session.activeTask, attempts: (session.attempts ?? []).filter(item => item.taskId === session.activeTask?.id).slice(-12), sideAnswers: session.sideAnswers?.filter(item => item.taskId === session.activeTask?.id), conversationState: compactState({ previousRoute: session.route, activeTask: session.activeTask, hasCodexThread: !!session.threadId }) } };
}
export function assessmentRequest(session: Session, attemptId: string, prompts = DEFAULT_ROUTING_PROMPTS): VexRequest {
  const attempt = session.attempts?.find(item => item.id === attemptId);
  return { question: prompts.assessment.question, decisionType: "routing", options: Object.entries(prompts.assessment.choices).map(([id, description]) => ({ id, description })), constraints: prompts.assessment.constraints,
    context: { goal: session.activeTask, attempt, priorAttempts: session.attempts?.filter(item => item.taskId === attempt?.taskId && item.id !== attemptId).slice(-10), recentConversation: recentConversation(session.turns), evidence: attempt?.observations, sideAnswers: session.sideAnswers?.filter(item => item.adopted && item.taskId === attempt?.taskId) } };
}
