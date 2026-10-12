import type { ModelOption, Route, Session, TurnSummary } from "../shared/types.js";
import type { CodexRunner, Progress } from "../integrations/codex.js";
import type { RoutingDecision } from "./routing/router.js";
import { stageRequest, type RoutingState, type VexRequest } from "./vex/client.js";
import type { RoutingPrompts } from "./routing/routing-prompts.js";
import type { StageRecord } from "./orchestrator.js";
import { chosenRoute } from "./routing/router.js";
import { costForUsage } from "./routing/pricing.js";
import { handoffPrompt, structuredHandoff } from "./orchestrator-helpers.js";
export async function runPlanningStage({
  request, routingTurns, enabled, prompts, routingState, choose, runner, session,
  signal, onProgress, stages, priorHandoff,
  routeOverride,
}: {
  request: string;
  routingTurns: TurnSummary[];
  enabled: ModelOption[];
  prompts: RoutingPrompts;
  routingState?: RoutingState;
  choose: (request: VexRequest, objective: string) => Promise<RoutingDecision>;
  runner: CodexRunner;
  session: Pick<Session, "projectPath">;
  signal?: AbortSignal;
  onProgress: (progress: Progress) => void;
  stages: StageRecord[];
  priorHandoff?: string;
  routeOverride?: Route | "vex";
}): Promise<string> {
  let handoff = "";
  const objective = prompts.objectives.scout;
  const stageModels = enabled.filter((model) => model.model === "gpt-6-luna");
  const available = routeOverride && routeOverride !== "vex" && routeOverride.model && !routeOverride.effort
    ? stageModels.filter(model => model.model === routeOverride.model) : stageModels;
  if (!available.length)
    throw new Error("Vex chose a Luna scout, but Luna is not enabled");
  const sideRoute = routeOverride && routeOverride !== "vex" && routeOverride.effort ? routeOverride : chosenRoute(
    (
      await choose(
        stageRequest(
          request,
          routingTurns,
          available,
          objective,
          priorHandoff,
          enabled,
          prompts,
          routingState,
        ),
        objective,
      )
    ).choice,
    available,
  );
  signal?.throwIfAborted();
  onProgress({ kind: "route", route: sideRoute });
  if (!routeOverride || routeOverride === "vex" || !routeOverride.effort) {
    onProgress({
      kind: "system",
      text: `Vex routed to ${sideRoute.model ?? "Codex default"} at ${sideRoute.effort ?? "default"} reasoning`,
    });
  }
  onProgress({
    kind: "status",
    text: `${objective}: ${sideRoute.model} · ${sideRoute.effort}`,
  });
  const basePrompt = handoffPrompt(request, routingTurns, prompts, priorHandoff);
  let previousResult: string | undefined;
  let handoffError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const correction = previousResult
      ? `\n\nYour previous report was rejected (${String(handoffError)}). Rewrite it as exactly one JSON object following the required handoff schema. Previous report:\n${previousResult.slice(0, 10_000)}`
      : "";
    const stageStart = performance.now();
    const side = await runner.run(
      `${basePrompt}${correction}`,
      session.projectPath,
      sideRoute,
      undefined,
      (progress) => {
        if (progress.kind === "activity" || progress.kind === "usage") onProgress(progress);
      },
      signal,
      "side",
    );
    signal?.throwIfAborted();
    const sideStage: StageRecord = {
      objective,
      route: sideRoute,
      durationMs: Math.round(performance.now() - stageStart),
      usage: side.usage,
      estimatedCostUsd: costForUsage(sideRoute, side.usage),
    };
    stages.push(sideStage);
    try {
      handoff = structuredHandoff(side.result);
      sideStage.handoff = handoff;
      break;
    } catch (error) {
      previousResult = side.result;
      handoffError = error;
      if (attempt === 1) throw error;
      onProgress({
        kind: "status",
        text: "Correcting the read-only report format...",
      });
    }
  }
  return handoff;
}
