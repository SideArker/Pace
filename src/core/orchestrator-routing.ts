import { redactTrace, type PromptTrace } from "./prompt-trace.js";
import { projectVexRequest } from "./vex/context.js";
import { limitedAssessment } from "./task-assessment.js";
import type { Session, TaskAssessment } from "../shared/types.js";
import type { Progress } from "../integrations/codex-types.js";
import { assessmentRequest, type VexRequest, type VexRouter } from "./vex/client.js";
import type { RoutingDecision } from "./routing/router.js";
import type { RoutingPrompts } from "./routing/routing-prompts.js";
import type { RoutingRecord } from "./orchestrator.js";
import { chooseDecision, decisionAudit } from "./vex/decisions.js";
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
  const assess = async (attemptId: string, updateTask: boolean) => {
    const attempt = session.attempts?.find(item => item.id === attemptId);
    if (!attempt) return;
    try {
      const decision = await choose(assessmentRequest(session, attemptId, prompts), "task completion assessment");
      const record = session.controlDecisions!.at(-1)!;
      record.attemptId = attemptId; record.taskId = attempt.taskId; record.role = attempt.role; record.stage = attempt.stage;
      const currentAttempt = session.attempts!.find(item => item.id === attemptId)!;
      currentAttempt.assessment = limitedAssessment(currentAttempt, session.activeTask, decision.choice as TaskAssessment, record.id, record.projection?.requiredEvidenceOmitted ?? false);
      if (updateTask && session.activeTask) session.activeTask.assessment = currentAttempt.assessment.value;
      await save();
    } catch (error) {
      if (error instanceof TransitionSaveError) throw error;
      const currentAttempt = session.attempts!.find(item => item.id === attemptId)!;
      const record = session.controlDecisions?.at(-1);
      if (record?.failed) {
        record.attemptId = attemptId; record.taskId = attempt.taskId; record.role = attempt.role; record.stage = attempt.stage;
        currentAttempt.assessment = limitedAssessment(currentAttempt, session.activeTask, undefined, record.id, true);
      }
      if (updateTask && session.activeTask) session.activeTask.assessment = "unknown";
      onProgress({ kind: "error", text: `Task completion is unknown: ${String(error)}` });
      await save();
    }
  };
  return { choose, assess };
}
