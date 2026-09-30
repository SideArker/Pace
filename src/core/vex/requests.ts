import type { ModelOption, Route, TurnSummary } from "../../shared/types.js";
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
};
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
    originalRequest: prompt,
    recentConversation: turns
      .slice(-10)
      .map((turn) => ({ user: turn.prompt, assistant: turn.result, ...(turn.failed ? { failed: true } : {}) })),
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
    : configuredChoices.filter((choice) => choice.id !== "scout");
  return {
    question: prompts.workflow.question,
    context: taskContext(prompt, turns, models, prompts, state),
    options,
    decisionType: "routing",
    constraints: `${prompts.workflow.constraints}\n\nPace routing rule: resolve the latest user's requested outcome using recentConversation and conversationState before comparing workflows. Treat the latest user turn as authoritative for changes of scope or permission. Use prior unfinished work as context, and do not infer task size from the length of the latest message. Clarify only when the conversation lacks an actionable referent. A concrete command and target are actionable even when the command is read-only.`,
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
    constraints: `${prompts.stage.constraints}\n\nPace routing rule: first infer the full remaining deliverable from recentConversation, conversationState, and any priorStageHandoff. A read-only handoff records preparation and remaining steps; it is not completion of an implementation request. Judge model and effort for the work this stage must still perform, not the wording or length of the latest user message. Cost breaks ties only among routes likely to complete it at the stated quality target.`,
  };
}
