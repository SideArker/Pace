import { redactTrace, type PromptTrace } from "./prompt-trace.js";
import { projectVexRequest } from "./vex/context.js";
import type { Session } from "../shared/types.js";
import type { Progress } from "../integrations/codex-types.js";
import type { VexRequest, VexRouter } from "./vex/client.js";
import type { RoutingDecision } from "./routing/router.js";
import type { RoutingPrompts } from "./routing/routing-prompts.js";
import type { RoutingRecord } from "./orchestrator.js";
import { chooseDecision, decisionAudit } from "./vex/decisions.js";

export class VexUnavailableError extends Error {
  constructor(
    cause: unknown,
    readonly source: "connection" | "decision",
  ) {
    super(`Vex routing failed: ${String(cause)}`);
  }
}
export function createTurnRouting({
  vex, session, prompts, verifierTurn, routing, save, onProgress, signal, trace,
}: {
  vex: Pick<VexRouter, "choose">;
  session: Session;
  prompts: RoutingPrompts;
  verifierTurn: boolean;
  routing: RoutingRecord[];
  save: () => Promise<void>;
  onProgress: (progress: Progress) => void;
  signal?: AbortSignal;
  trace?: PromptTrace;
}) {
  const choose = async (
    request: VexRequest,
    objective: string,
  ): Promise<RoutingDecision> => {
    const entry: PromptTrace["vex"][number] = { objective, request: redactTrace(request) };
    try { entry.request = redactTrace(projectVexRequest(request).request); } catch { /* The decision validator records projection failures. */ }
    trace?.vex.push(entry);
    const decisionStarted = performance.now();
    const result = await chooseDecision({
      vex, request, signal, prompts, checkAborted: () => signal?.throwIfAborted(),
      accept: async (decision, attempt, details) => {
        entry.decision = redactTrace(decision);
        routing.push({
          objective,
          choice: decision.choice,
          choiceLabel: request.options.find(option => option.id === decision.choice)?.description,
          confidence: decision.confidence,
          probabilities: decision.probabilities,
          attempts: attempt,
        });
        session.controlDecisions = [...(session.controlDecisions ?? []), {
          ...decisionAudit(decisionStarted, attempt, decision, undefined, details),
          taskId: session.activeTask?.id, stage: session.activeTask?.workflow?.stage,
          role: verifierTurn ? "verifier" : request.context.stageObjective === prompts.objectives.scout ? "scout" : "main", objective, at: new Date().toISOString(),
        }];
        await save();
        return decision;
      },
    });
    if (result.ok) return result.value;
    entry.error = String(result.failure);
    session.controlDecisions = [...(session.controlDecisions ?? []), {
      ...decisionAudit(decisionStarted, result.details.requestAttempts.length, undefined, result.failure, result.details),
      taskId: session.activeTask?.id, stage: session.activeTask?.workflow?.stage,
      role: verifierTurn ? "verifier" : "main", objective, at: new Date().toISOString(),
    }];
    await save();
    throw new VexUnavailableError(result.failure, "decision");
  };
  return { choose };
}
