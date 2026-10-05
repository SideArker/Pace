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
  return value.length <= limit ? value : `${value.slice(0, limit - 800)}\n[Earlier text omitted for routing; full text goes to Codex.]\n${value.slice(-700)}`;
}
function recentConversation(turns: TurnSummary[]) {
  return turns.slice(-10).map(turn => ({
    user: excerpt(turn.prompt, 1200),
    assistant: excerpt(turn.result, 1200),
    ...(turn.failed ? { failed: true } : {}),
  }));
}
export function taskRelationRequest(prompt: string, turns: TurnSummary[], state: RoutingState, prompts = DEFAULT_ROUTING_PROMPTS): VexRequest {
  return {
    question: prompts.taskRelation.question,
    context: { latestRequest: excerpt(prompt, 12000), recentConversation: recentConversation(turns), conversationState: state },
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
    ...(state ? { conversationState: state } : {}),
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
  const options = models.some((model) => model.model === "gpt-6-luna")
    ? configuredChoices
    : configuredChoices.filter((choice) => choice.id !== "scout" && choice.id !== "scout_plan_execute");
  return {
    question: prompts.workflow.question,
    context: taskContext(prompt, turns, models, prompts, state),
    options,
    decisionType: "routing",
    constraints: `${prompts.workflow.constraints}\n\n${prompts.routingRules.workflowResolution}`,
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
