import { randomUUID } from "node:crypto";
import { awaitRouting } from "../orchestrator-helpers.js";
import { validateDecision, type RoutingDecision } from "../routing/router.js";
import { TransitionSaveError } from "../task-execution.js";
import type { VexRouter } from "./client.js";
import type { VexRequest } from "./requests.js";

/** Persistence failures and cancellation must never become another provider call. */
export async function chooseDecision<T>({ vex, request, accept, signal, checkAborted }: {
  vex: Pick<VexRouter, "choose">;
  request: VexRequest;
  accept: (decision: RoutingDecision, requests: number) => Promise<T>;
  signal?: AbortSignal;
  checkAborted?: () => void;
}): Promise<{ ok: true; value: T } | { ok: false; failure: unknown }> {
  let failure: unknown;
  for (let requests = 1; requests <= 2; requests++) {
    checkAborted?.();
    try {
      const decision = validateDecision(await awaitRouting(vex.choose(request), signal), request.options);
      checkAborted?.();
      return { ok: true, value: await accept(decision, requests) };
    } catch (error) {
      if (error instanceof TransitionSaveError) throw error;
      checkAborted?.();
      if (signal?.aborted) throw error;
      failure = error;
    }
  }
  return { ok: false, failure };
}

export function decisionAudit(started: number, requests: number, decision?: RoutingDecision, failure?: unknown) {
  return {
    id: randomUUID(), source: "vex" as const, contextAction: "continue" as const,
    choice: decision?.choice ?? "unavailable", confidence: decision?.confidence ?? 0,
    probabilities: decision?.probabilities ?? {}, requests,
    durationMs: Math.round(performance.now() - started),
    ...(!decision ? { failed: true, error: String(failure) } : {}),
  };
}
