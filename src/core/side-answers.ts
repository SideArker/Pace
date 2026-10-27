import { randomUUID } from "node:crypto";
import type { Config, Session } from "../shared/types.js";
import type { Progress } from "../integrations/codex-types.js";
import type { Orchestrator, TurnOutcome, RoutingRecord } from "./orchestrator.js";
import { loadRoutingPrompts } from "./routing/routing-prompts.js";
import { stageRequest } from "./vex/requests.js";
import { chosenRoute } from "./routing/router.js";
import { chooseDecision, decisionAudit } from "./vex/decisions.js";
import { durableRunner, requiredSave, TransitionSaveError } from "./task-execution.js";
import { costForUsage } from "./routing/pricing.js";

const SIDE_TEXT_LIMIT = 1_000;
const SIDE_SNAPSHOT_OMISSION = "\n[Older or excess context omitted; full record remains in Pace.]\n";

function sideExcerpt(value: string | undefined, limit = SIDE_TEXT_LIMIT): string | undefined {
  if (value === undefined || value.length <= limit) return value;
  const available = Math.max(0, limit - SIDE_SNAPSHOT_OMISSION.length);
  const head = Math.ceil(available * 0.7);
  return `${value.slice(0, head)}${SIDE_SNAPSHOT_OMISSION}${value.slice(-(available - head))}`;
}

/** Build a small model-facing view; the saved Pace session remains the full record. */
export function buildAsidePrompt(question: string, session: Session, instruction: string, snapshotAt: string): string {
  const task = session.activeTask;
  const snapshot = {
    snapshotAt,
    scope: "Selected recent conversation and execution evidence; this is not the full Pace or Codex history.",
    omitted: "Older turns, task records and tool observations are retained in Pace but omitted here to keep this request bounded.",
    turns: session.turns.slice(-5).map(turn => ({
      at: turn.at, intent: turn.intent,
      prompt: sideExcerpt(turn.displayPrompt ?? turn.prompt, 1_500),
      result: sideExcerpt(turn.result, 2_000),
    })),
    task: task ? {
      id: task.id,
      originalRequest: sideExcerpt(task.originalRequest, 3_000),
      instructions: task.instructions.slice(-6).map(item => sideExcerpt(item, 800)),
      latestOutcome: sideExcerpt(task.latestOutcome, 2_500),
      criteria: task.criteria?.slice(0, 8).map(item => ({ ...item, text: sideExcerpt(item.text, 500) })),
      constraints: task.constraints?.slice(0, 8).map(item => sideExcerpt(item, 500)),
      workflow: task.workflow ? { shape: task.workflow.shape, stage: task.workflow.stage, status: task.workflow.status } : undefined,
    } : undefined,
    tasks: (session.tasks ?? []).slice(-10).map(item => ({ ...item, text: sideExcerpt(item.text, 500) })),
    attempts: (session.attempts ?? []).filter(item => item.taskId === task?.id).slice(-4).map(item => ({
      id: item.id, role: item.role, stage: item.stage, status: item.status,
      result: sideExcerpt(item.result, 1_500), error: sideExcerpt(item.error, 800),
      observations: item.observations.slice(-5).map(observation => observation.kind === "activity"
        ? { kind: observation.kind, text: sideExcerpt(observation.text, 700) }
        : observation.kind === "tasks"
          ? { kind: observation.kind, items: observation.items?.slice(-8).map(entry => ({ ...entry, text: sideExcerpt(entry.text, 300) })) }
          : observation.kind === "artifacts"
            ? { kind: observation.kind, paths: observation.paths?.slice(-12) }
            : { kind: observation.kind, text: sideExcerpt(observation.text, 700) }),
    })),
  };
  return `${instruction}\n\nContext snapshot:\n${JSON.stringify(snapshot)}\n\nUser side question:\n${question}`;
}

/** Separate read-only context snapshot; never transfers ownership of the main task. */
export async function runAside(orchestrator: Orchestrator, question: string, source: Session, config: Config, progress: (event: Progress) => void, signal?: AbortSignal, activate: boolean | (() => boolean) = true): Promise<TurnOutcome> {
  if (!question.trim()) throw new Error("Type /btw <question> to ask a side question.");
  await requiredSave(orchestrator.store, source, activate);
  const session = structuredClone(source);
  const snapshotAt = new Date().toISOString();
  const prompts = loadRoutingPrompts(orchestrator.store.baseDir);
  const enabled = config.models.filter(model => model.enabled !== false && model.efforts.length);
  if (!enabled.length) throw new Error("No allowed route is available for a side answer.");
  const request = stageRequest(question, session.turns, enabled, prompts.side.objective, undefined, enabled, prompts, { activeTask: session.activeTask, previousRoute: session.route, hasCodexThread: !!session.threadId });
  const started = performance.now();
  const routing: RoutingRecord[] = [];
  const selected = await chooseDecision({
    vex: orchestrator.vex, request, signal, prompts,
    accept: async (decision, attempt, details) => {
      const route = chosenRoute(decision.choice, enabled);
      routing.push({ objective: prompts.side.objective, ...decision, attempts: attempt });
      session.controlDecisions = [...(session.controlDecisions ?? []), { ...decisionAudit(started, attempt, decision, undefined, details), taskId: session.activeTask?.id, role: "aside", stage: "aside", objective: prompts.side.objective, at: snapshotAt }];
      await requiredSave(orchestrator.store, session, activate);
      return route;
    },
  });
  if (!selected.ok) {
    session.controlDecisions = [...(session.controlDecisions ?? []), { ...decisionAudit(started, selected.details.requestAttempts.length, undefined, selected.failure, selected.details), taskId: session.activeTask?.id, role: "aside", stage: "aside", objective: prompts.side.objective, at: snapshotAt }];
    await requiredSave(orchestrator.store, session, activate);
    await requiredSave(orchestrator.store, source, activate);
    throw new Error(`Vex could not choose a side route after two attempts: ${String(selected.failure)}`);
  }
  const route = selected.value;
  const id = randomUUID();
  let asideAttemptId: string | undefined;
  progress({ kind: "route", route, role: "aside", taskId: session.activeTask?.id });
  try {
    const execution = await durableRunner(orchestrator.runner, orchestrator.store, session, "aside", "aside", activate, undefined, id => { asideAttemptId = id; }).run(
      buildAsidePrompt(question, session, prompts.side.instruction, snapshotAt),
      session.projectPath, route, undefined, progress, signal, "side", [], config.approvalMode,
    );
    const attempt = session.attempts!.find(item => item.id === asideAttemptId)!;
    session.sideAnswers = [...(session.sideAnswers ?? []), { id, taskId: session.activeTask?.id, attemptId: attempt.id, question, snapshotAt, route, result: execution.result, threadId: execution.threadId }];
    await requiredSave(orchestrator.store, session, activate);
    // Refresh the caller through its concrete changes, preserving any main work
    // made while this isolated snapshot was running.
    await requiredSave(orchestrator.store, source, activate);
    return { session, role: "aside", result: execution.result, note: `Side answer ${id}; lead remains ${session.route.model ?? "default"} ${session.route.effort ?? "default"}`, route, durationMs: Math.round(performance.now() - started), artifacts: [], usage: execution.usage, estimatedCostUsd: costForUsage(route, execution.usage), stages: [{ objective: prompts.side.objective, route, durationMs: attempt.durationMs ?? 0, usage: execution.usage, estimatedCostUsd: costForUsage(route, execution.usage) }], routing };
  } catch (error) {
    if (error instanceof TransitionSaveError) throw error;
    const attempt = session.attempts!.find(item => item.id === asideAttemptId);
    if (attempt) { session.sideAnswers = [...(session.sideAnswers ?? []), { id, taskId: session.activeTask?.id, attemptId: attempt.id, question, snapshotAt, route, error: String(error), threadId: attempt.threadId }]; await requiredSave(orchestrator.store, session, activate); await requiredSave(orchestrator.store, source, activate); }
    throw error;
  }
}
