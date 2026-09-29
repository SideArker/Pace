import type { ModelOption, TurnSummary } from "../../shared/types.js";
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
) {
  return {
    originalRequest: prompt,
    recentConversation: turns
      .slice(-6)
      .map((turn) => ({ user: turn.prompt, assistant: turn.result })),
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
): VexRequest {
  const configuredChoices = Object.entries(prompts.workflow.choices).map(
    ([id, description]) => ({ id, description }),
  );
  const options = models.some((model) => model.model === "gpt-6-luna")
    ? configuredChoices
    : configuredChoices.filter((choice) => choice.id !== "scout");
  return {
    question: prompts.workflow.question,
    context: taskContext(prompt, turns, models, prompts),
    options,
    decisionType: "routing",
    constraints: `${prompts.workflow.constraints}\n\nPace routing rule: when the user names a concrete command and target, treat it as actionable and choose single rather than clarify.`,
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
): VexRequest {
  const options = routeChoices(models);
  return {
    question: prompts.stage.question,
    context: {
      ...taskContext(prompt, turns, availableModels, prompts),
      stageObjective: objective,
      ...(handoff ? { priorStageHandoff: handoff } : {}),
    },
    options,
    decisionType: "routing",
    constraints: prompts.stage.constraints,
  };
}
