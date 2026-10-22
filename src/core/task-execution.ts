import { randomUUID } from "node:crypto";
import type { AgentRole, Session, StageAttempt, WorkflowShape } from "../shared/types.js";
import type { CodexRunner, Execution, Progress } from "../integrations/codex-types.js";
import { CodexRunError } from "../integrations/codex-types.js";
import { registerActiveAttempt, type PaceStore } from "./sessions.js";
import { costForUsage, PRICE_SNAPSHOT } from "./routing/pricing.js";
import { updateAgentTasks } from "./tasks.js";

export class TransitionSaveError extends Error {
  constructor(cause: unknown) { super(`Required workflow save failed; execution stopped: ${String(cause)}`, { cause }); }
}
export class ActiveAttemptError extends Error {
  constructor() { super("An execution is still active for this conversation. Wait for it to finish before sending another turn."); }
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
    version: 1, generation: 1, shape, stage: shape === "scout" || shape === "scout_plan" ? "scout" : shape === "plan" ? "plan" : "final", status: "pending", source,
  };
}
/** Every model invocation has a durable start and terminal record, independent of visible history. */
export function durableRunner(
  runner: CodexRunner, store: PaceStore, session: Session, role: AgentRole, stage: string,
  activate: boolean | (() => boolean), after?: (attemptId: string) => Promise<void>,
  created?: (attemptId: string) => void,
): CodexRunner {
  return { async run(...args) {
    const [, , route, threadId, output, signal] = args;
    const started = performance.now();
    const id = randomUUID();
    const taskId = session.activeTask?.id ?? session.id;
    const record: StageAttempt = {
      pricing: structuredClone(PRICE_SNAPSHOT),
      id, taskId, generation: session.activeTask?.workflow?.generation ?? 0, role, stage,
      status: "running", route: { ...route }, threadId, startedAt: new Date().toISOString(), observations: [],
    };
    session.attempts = [...(session.attempts ?? []), record];
    const releaseAttempt = registerActiveAttempt(session, id);
    created?.(id);
    const setStageStatus = (status: StageAttempt["status"]) => {
      if ((role === "main" || role === "scout") && session.activeTask?.workflow) session.activeTask.workflow.status = status;
    };
    setStageStatus("running");
    try { await requiredSave(store, session, activate); }
    catch (error) { releaseAttempt(); throw error; }
    const current = () => session.attempts!.find(item => item.id === id)!;
    let progressSave: Promise<void> | undefined;
    let saveAgain = false;
    let autosaveTimer: ReturnType<typeof setInterval> | undefined;
    const saveProgress = () => {
      if (progressSave) { saveAgain = true; return progressSave; }
      progressSave = (async () => {
        try {
          do {
            saveAgain = false;
            await requiredSave(store, session, activate);
          } while (saveAgain);
        } finally { progressSave = undefined; }
      })();
      return progressSave;
    };
    autosaveTimer = setInterval(() => { void saveProgress().catch(() => {}); }, 2_000);
    const persistResult = async () => {
      if (autosaveTimer) clearInterval(autosaveTimer);
      await progressSave?.catch(() => {});
      try { await requiredSave(store, session, activate); }
      catch (error) {
        // Also stop retries in this process, whose object already contains the
        // unsaved result. Disk still records a running, uncertain invocation.
        current().status = "awaiting_user";
        setStageStatus("awaiting_user");
        throw error;
      }
    };
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
      const forwarded = output({ ...event, taskId, role, attemptId: id });
      if (event.kind === "thread") return Promise.resolve(forwarded).then(() => saveProgress());
      return forwarded;
    };
    let execution: Execution;
    try {
      try {
        execution = await runner.run(...[...args.slice(0, 4), progress, ...args.slice(5)] as Parameters<CodexRunner["run"]>);
        if (!execution.completed) throw new CodexRunError("Codex invocation did not complete", execution.usage, execution.context,
          { threadId: execution.threadId, turnId: execution.turnId, route: execution.route ?? route, knownUsage: execution.knownUsage, usageComplete: execution.usageComplete ?? !!execution.usage });
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
        setStageStatus(attempt.status);
        await persistResult();
        throw error;
      }
      const attempt = current();
      attempt.status = signal?.aborted ? "cancelled" : execution.completed ? "completed" : "failed";
      attempt.result = execution.result; attempt.threadId = execution.threadId ?? attempt.threadId; attempt.turnId = execution.turnId;
      attempt.usage = execution.usage; attempt.knownUsage = execution.knownUsage ?? execution.usage;
      attempt.usageComplete = execution.usageComplete ?? !!execution.usage;
      attempt.observations.push({ kind: "answer", text: execution.result });
      finish(attempt, started);
      setStageStatus(attempt.status);
      await persistResult();
      await after?.(id);
      return execution;
    } finally {
      if (autosaveTimer) clearInterval(autosaveTimer);
      await progressSave?.catch(() => {});
      releaseAttempt();
    }
  } };
}
function finish(attempt: StageAttempt, started: number) {
  attempt.finishedAt = new Date().toISOString(); attempt.durationMs = Math.round(performance.now() - started);
  attempt.estimatedCostUsd = attempt.usageComplete ? costForUsage(attempt.route, attempt.usage, attempt.pricing) : undefined;
  attempt.knownCostUsd = costForUsage(attempt.route, attempt.knownUsage, attempt.pricing);
}
export function taskAccounting(session: Session, taskId?: string) {
  const attempts = (session.attempts ?? []).filter(item => !taskId || item.taskId === taskId);
  const knownSubtotalUsd = attempts.reduce((sum, item) => sum + (item.knownCostUsd ?? item.estimatedCostUsd ?? 0), 0);
  const complete = !session.accountingIncomplete && attempts.length > 0 && attempts.every(item => item.usageComplete && item.estimatedCostUsd !== undefined && !["pending", "running", "awaiting_user"].includes(item.status));
  return { attempts: attempts.length, knownSubtotalUsd, complete, totalUsd: complete ? knownSubtotalUsd : undefined, durationMs: attempts.reduce((sum, item) => sum + (item.durationMs ?? 0), 0) };
}

/** Manual compaction changes context, but its inference cost belongs to the same ledger. */
export async function compactSession(
  store: PaceStore, session: Session,
  runner: Pick<import("../integrations/app-server-runner.js").AppServerRunner, "compact">,
  progress: (event: Progress) => void | Promise<void>, signal?: AbortSignal,
  activate: boolean | (() => boolean) = true,
) {
  if (!session.threadId) throw new Error("No Codex thread to compact");
  const threadId = session.threadId;
  const route = { ...session.route };
  let result: Awaited<ReturnType<typeof runner.compact>> | undefined;
  let attemptId: string | undefined;
  const adapter: CodexRunner = { run: async (_prompt, project, selected, _thread, callback) => {
    result = await runner.compact(threadId, project, selected, callback, signal);
    return { ...result, result: result.error ?? `Compaction ${result.outcome}`, completed: result.outcome === "completed" };
  } };
  try {
    await durableRunner(adapter, store, session, "status", "native_compaction", activate, undefined, id => { attemptId = id; }).run("Manual native compaction", session.projectPath, route, threadId, progress, signal);
  } catch (error) {
    if (error instanceof TransitionSaveError || !result) throw error;
  }
  const attempt = session.attempts!.find(item => item.id === attemptId)!;
  session.compactions = [...(session.compactions ?? []), {
    at: attempt.finishedAt!, attemptId, threadId, route, durationMs: result!.durationMs, outcome: result!.outcome,
    usage: attempt.usage, knownUsage: attempt.knownUsage, usageComplete: attempt.usageComplete,
    estimatedCostUsd: attempt.estimatedCostUsd, knownCostUsd: attempt.knownCostUsd, error: result!.error,
  }].slice(-50);
  if (session.contextByThread) delete session.contextByThread[threadId];
  await requiredSave(store, session, activate);
  return result!;
}
