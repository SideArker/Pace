import { randomUUID } from "node:crypto";
import type { AgentRole, Session, StageAttempt, WorkflowShape } from "../shared/types.js";
import type { CodexRunner, Execution, Progress } from "../integrations/codex-types.js";
import { CodexRunError } from "../integrations/codex-types.js";
import type { PaceStore } from "./sessions.js";
import { costForUsage } from "./routing/pricing.js";
import { updateAgentTasks } from "./tasks.js";

export class TransitionSaveError extends Error {
  constructor(cause: unknown) { super(`Required workflow save failed; execution stopped: ${String(cause)}`, { cause }); }
}
export class UncertainAttemptError extends Error {
  constructor(readonly attempts: StageAttempt[]) {
    super(`Previous execution has an uncertain result. Automatic retry is paused. Inspect its thread, artifacts and file changes, then resolve the attempt: ${attempts.map(item => `${item.id} (${item.role}, ${item.threadId ?? "thread unknown"})`).join(", ")}`);
  }
}
export async function requiredSave(store: PaceStore, session: Session, activate: boolean | (() => boolean) = true) {
  try { await store.saveChanges(session, activate); }
  catch (error) { throw new TransitionSaveError(error); }
}
export function ensureTask(session: Session, shape: WorkflowShape, source: "vex" | "user", replace = false) {
  if (replace || !session.activeTask) throw new Error("Create the task brief before selecting its workflow");
  session.activeTask.id ??= randomUUID();
  session.activeTask.assessment ??= "unknown";
  session.activeTask.workflow ??= {
    version: 1, generation: 1, shape, stage: shape === "scout" || shape === "scout_plan" ? "scout" : shape === "plan" ? "plan" : "final", source,
  };
}
/** Every model invocation has a durable start and terminal record, independent of visible history. */
export function durableRunner(
  runner: CodexRunner, store: PaceStore, session: Session, role: AgentRole, stage: string,
  activate: boolean | (() => boolean), after?: (attemptId: string) => Promise<void>,
): CodexRunner {
  return { async run(...args) {
    const [, , route, threadId, output, signal] = args;
    const started = performance.now();
    const id = randomUUID();
    const taskId = session.activeTask?.id ?? session.id;
    const record: StageAttempt = {
      id, taskId, generation: session.activeTask?.workflow?.generation ?? 0, role, stage,
      status: "running", route: { ...route }, threadId, startedAt: new Date().toISOString(), observations: [],
    };
    session.attempts = [...(session.attempts ?? []), record];
    await requiredSave(store, session, activate);
    const current = () => session.attempts!.find(item => item.id === id)!;
    const progress = (event: Progress) => {
      const attempt = current();
      if (event.kind === "thread") attempt.threadId = event.text;
      if (event.kind === "activity") attempt.observations.push({ kind: "activity", text: `${event.category}: ${event.title}${event.detail ? `\n${event.detail}` : ""}${event.outcome ? `\nOutcome: ${event.outcome}` : ""}` });
      if (event.kind === "tasks") {
        attempt.observations.push({ kind: "tasks", items: event.items });
        if (role === "main") session.tasks = updateAgentTasks(session.tasks, event.items);
        if (role === "verifier") {
          session.verifier ??= { route: { ...route } };
          session.verifier.tasks = updateAgentTasks(session.verifier.tasks, event.items);
        }
      }
      return output({ ...event, taskId, role, attemptId: id });
    };
    let execution: Execution;
    try {
      execution = await runner.run(...[...args.slice(0, 4), progress, ...args.slice(5)] as Parameters<CodexRunner["run"]>);
    } catch (error) {
      const attempt = current();
      attempt.status = signal?.aborted ? "cancelled" : "failed";
      attempt.error = String(error);
      if (error instanceof CodexRunError) {
        attempt.usage = error.usage; attempt.knownUsage = error.accounting?.knownUsage ?? error.usage;
        attempt.usageComplete = error.accounting?.usageComplete ?? !!error.usage;
        attempt.threadId = error.accounting?.threadId ?? attempt.threadId; attempt.turnId = error.accounting?.turnId;
      }
      finish(attempt, started);
      await requiredSave(store, session, activate);
      throw error;
    }
    const attempt = current();
    attempt.status = execution.completed ? "completed" : "failed";
    attempt.result = execution.result; attempt.threadId = execution.threadId ?? attempt.threadId; attempt.turnId = execution.turnId;
    attempt.usage = execution.usage; attempt.knownUsage = execution.knownUsage ?? execution.usage;
    attempt.usageComplete = execution.usageComplete ?? !!execution.usage;
    attempt.observations.push({ kind: "answer", text: execution.result });
    finish(attempt, started);
    await requiredSave(store, session, activate);
    await after?.(id);
    return execution;
  } };
}
function finish(attempt: StageAttempt, started: number) {
  attempt.finishedAt = new Date().toISOString(); attempt.durationMs = Math.round(performance.now() - started);
  attempt.estimatedCostUsd = attempt.usageComplete ? costForUsage(attempt.route, attempt.usage) : undefined;
  attempt.knownCostUsd = costForUsage(attempt.route, attempt.knownUsage);
}
/** Human reconciliation is explicit; unknown execution is never interpreted as no work. */
export async function resolveAttempt(store: PaceStore, session: Session, id: string, result: string) {
  const attempt = session.attempts?.find(item => item.id === id);
  if (!attempt || !["running", "awaiting_user"].includes(attempt.status)) throw new Error("No uncertain attempt with that ID.");
  attempt.status = "completed"; attempt.result = result; attempt.finishedAt = new Date().toISOString();
  attempt.observations.push({ kind: "answer", text: `User reconciled thread, artifacts and file changes: ${result}` });
  if (session.activeTask) { session.activeTask.assessment = "unknown"; if (session.activeTask.workflow) session.activeTask.workflow.needsAssessment = true; }
  await requiredSave(store, session);
}
export function taskAccounting(session: Session, taskId?: string) {
  const attempts = (session.attempts ?? []).filter(item => !taskId || item.taskId === taskId);
  const knownSubtotalUsd = attempts.reduce((sum, item) => sum + (item.knownCostUsd ?? item.estimatedCostUsd ?? 0), 0);
  const complete = attempts.length > 0 && attempts.every(item => item.usageComplete && item.estimatedCostUsd !== undefined && !["pending", "running", "awaiting_user"].includes(item.status));
  return { attempts: attempts.length, knownSubtotalUsd, complete, totalUsd: complete ? knownSubtotalUsd : undefined, durationMs: attempts.reduce((sum, item) => sum + (item.durationMs ?? 0), 0) };
}
