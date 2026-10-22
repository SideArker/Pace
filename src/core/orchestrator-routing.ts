import { randomUUID } from "node:crypto";
import type { Session, TaskAssessment } from "../shared/types.js";
import type { Progress } from "../integrations/codex-types.js";
import { assessmentRequest, type VexRequest, type VexRouter } from "./vex/client.js";
import { validateDecision, type RoutingDecision } from "./routing/router.js";
import type { RoutingPrompts } from "./routing/routing-prompts.js";
import type { RoutingRecord } from "./orchestrator.js";
import { awaitRouting } from "./orchestrator-helpers.js";
import { TransitionSaveError } from "./task-execution.js";

export class VexUnavailableError extends Error {
  constructor(
    cause: unknown,
    readonly source: "connection" | "decision",
  ) {
    super(`Vex routing failed: ${String(cause)}`);
  }
}
export function createTurnRouting({
  vex, session, prompts, verifierTurn, routing, save, onProgress, signal,
}: {
  vex: Pick<VexRouter, "choose">;
  session: Session;
  prompts: RoutingPrompts;
  verifierTurn: boolean;
  routing: RoutingRecord[];
  save: () => Promise<void>;
  onProgress: (progress: Progress) => void;
  signal?: AbortSignal;
}) {
  const choose = async (
    request: VexRequest,
    objective: string,
  ): Promise<RoutingDecision> => {
    let failure: unknown;
    const decisionStarted = performance.now();
    for (let attempt = 1; attempt <= 2; attempt++) {
      signal?.throwIfAborted();
      try {
        const decision = validateDecision(
          await awaitRouting(vex.choose(request), signal),
          request.options,
        );
        signal?.throwIfAborted();
        routing.push({
          objective,
          choice: decision.choice,
          choiceLabel: request.options.find(option => option.id === decision.choice)?.description,
          confidence: decision.confidence,
          probabilities: decision.probabilities,
          attempts: attempt,
        });
        session.controlDecisions = [...(session.controlDecisions ?? []), {
          id: randomUUID(), taskId: session.activeTask?.id, stage: session.activeTask?.workflow?.stage,
          role: verifierTurn ? "verifier" : request.context.stageObjective === prompts.objectives.scout ? "scout" : "main", objective, choice: decision.choice, confidence: decision.confidence,
          probabilities: decision.probabilities, durationMs: Math.round(performance.now() - decisionStarted), at: new Date().toISOString(), source: "vex", contextAction: "continue",
          requests: attempt,
        }];
        await save();
        return decision;
      } catch (error) {
        if (error instanceof TransitionSaveError) throw error;
        signal?.throwIfAborted();
        failure = error;
      }
    }
    session.controlDecisions = [...(session.controlDecisions ?? []), { id: randomUUID(), taskId: session.activeTask?.id, stage: session.activeTask?.workflow?.stage, role: verifierTurn ? "verifier" : "main", objective, choice: "unavailable", confidence: 0, probabilities: {}, durationMs: Math.round(performance.now() - decisionStarted), at: new Date().toISOString(), source: "vex", contextAction: "continue", requests: 2, failed: true, error: String(failure) }];
    await save();
    throw new VexUnavailableError(failure, "decision");
  };
  const assess = async (attemptId: string, updateTask: boolean) => {
    const attempt = session.attempts?.find(item => item.id === attemptId);
    if (!attempt) return;
    try {
      const decision = await choose(assessmentRequest(session, attemptId, prompts), "task completion assessment");
      const record = session.controlDecisions!.at(-1)!;
      record.attemptId = attemptId; record.taskId = attempt.taskId; record.role = attempt.role; record.stage = attempt.stage;
      const currentAttempt = session.attempts!.find(item => item.id === attemptId)!;
      currentAttempt.assessment = { value: decision.choice as TaskAssessment, evidence: currentAttempt.observations.length, decisionId: record.id };
      if (updateTask && session.activeTask) session.activeTask.assessment = decision.choice as TaskAssessment;
      await save();
    } catch (error) {
      if (error instanceof TransitionSaveError) throw error;
      if (updateTask && session.activeTask) session.activeTask.assessment = "unknown";
      onProgress({ kind: "error", text: `Task completion is unknown: ${String(error)}` });
      await save();
    }
  };
  return { choose, assess };
}
