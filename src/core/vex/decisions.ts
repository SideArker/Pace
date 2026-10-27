import { randomUUID } from "node:crypto";
import { awaitRouting } from "../orchestrator-helpers.js";
import { validateDecision, type RoutingDecision } from "../routing/router.js";
import { DEFAULT_ROUTING_PROMPTS, routingPromptProfile, type RoutingPrompts } from "../routing/routing-prompts.js";
import { TransitionSaveError } from "../task-execution.js";
import type { DecisionAttempt, PromptProfile, VexProjection } from "../../shared/types.js";
import type { VexRouter } from "./client.js";
import type { VexRequest } from "./requests.js";
import { projectVexRequest, VexPayloadBudgetError } from "./context.js";

export type DecisionDetails = {
  requestAttempts: DecisionAttempt[]; promptProfile: PromptProfile;
  projection?: VexProjection; usage: "unknown"; costUsd: "unknown";
};
/** Persistence failures and cancellation must never become another provider call. */
export async function chooseDecision<T>({ vex, request, accept, signal, checkAborted, prompts = DEFAULT_ROUTING_PROMPTS }: {
  vex: Pick<VexRouter, "choose">;
  request: VexRequest;
  accept: (decision: RoutingDecision, requests: number, details: DecisionDetails) => Promise<T>;
  signal?: AbortSignal;
  checkAborted?: () => void;
  prompts?: RoutingPrompts;
}): Promise<{ ok: true; value: T } | { ok: false; failure: unknown; details: DecisionDetails }> {
  const details: DecisionDetails = { requestAttempts: [], promptProfile: routingPromptProfile(prompts), usage: "unknown", costUsd: "unknown" };
  let projected: VexRequest;
  try {
    const result = projectVexRequest(request);
    projected = result.request; details.projection = result.projection;
  } catch (failure) {
    if (failure instanceof VexPayloadBudgetError) details.projection = failure.projection;
    return { ok: false, failure, details };
  }
  let failure: unknown;
  for (let requests = 1; requests <= 2; requests++) {
    checkAborted?.();
    const started = performance.now();
    let decision: RoutingDecision;
    try {
      decision = validateDecision(await awaitRouting(vex.choose(projected), signal), request.options);
      checkAborted?.();
      details.requestAttempts.push({ attempt: requests, retry: requests > 1, durationMs: Math.round(performance.now() - started), status: "success" });
    } catch (error) {
      details.requestAttempts.push({ attempt: requests, retry: requests > 1, durationMs: Math.round(performance.now() - started), status: signal?.aborted ? "cancelled" : "error", error: String(error) });
      checkAborted?.();
      if (signal?.aborted || error instanceof TransitionSaveError) throw error;
      failure = error;
      continue;
    }
    // Save/accept is deliberately outside the retry block.
    return { ok: true, value: await accept(decision, requests, details) };
  }
  return { ok: false, failure, details };
}

export function decisionAudit(started: number, requests: number, decision?: RoutingDecision, failure?: unknown, details?: DecisionDetails) {
  return {
    id: randomUUID(), source: "vex" as const, contextAction: "continue" as const,
    choice: decision?.choice ?? "unavailable", confidence: decision?.confidence ?? 0,
    probabilities: decision?.probabilities ?? {}, requests,
    durationMs: Math.round(performance.now() - started),
    ...(details ?? { promptProfile: "unknown" as const, usage: "unknown" as const, costUsd: "unknown" as const }),
    ...(!decision ? { failed: true, error: String(failure) } : {}),
  };
}
