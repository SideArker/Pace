import { randomUUID } from "node:crypto";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { Config, Route, Session, TurnActivity, OperationIntent, QueuedOperation } from "../shared/types.js";
import type { CodexRunner, Progress } from "../integrations/codex.js";
import { Orchestrator, VexUnavailableError } from "../core/orchestrator.js";
import { artifactPath } from "../core/system/artifacts.js";
import { PaceStore, SessionConflictError } from "../core/sessions.js";
import { preparePlanExecution } from "../core/operations.js";
import { durableRunner, TransitionSaveError } from "../core/task-execution.js";
import { PromptQueue } from "../core/prompt-queue.js";
import { checkpointDue, createCheckpointIfDue } from "../core/checkpoint.js";
import { captureCheckpoint } from '../core/memory/checkpoint.js';
import { formatLiveUsage, formatTurnFooter, modelName } from "./turn-format.js";
import type { Line } from "./Transcript.js";
import { formatCommandActivity, formatCommandStatus } from "./shell-runner.js";
import { readUsageLimits, type UsageLimits } from "../integrations/usage.js";
import { isUsageLimitError, transientRetryAt, transientRetryReason, usageRetryAt } from "../core/usage-retry.js";
import type { RunningProcess } from "./RunningProcesses.js";

type TurnJob = {
  session: Session; controller: AbortController; prompt: string; automaticRetry?: boolean;
  operationId?: string;
  turnKey?: string;
  steerAttemptId?: string;
  steerRole?: import("../shared/types.js").AgentRole;
  persistSteering?: () => Promise<void>;
  steer?: (prompt: string) => Promise<void>;
  pendingSteer?: Promise<void>;
  steeredPrompts?: string[];
};
type PendingApproval = Extract<Progress, { kind: "approval" }> & { owner?: AbortController };
type PendingQuestion = Extract<Progress, { kind: "question" }> & { owner?: AbortController };
type AddLine = (sessionId: string, role: Line["role"], text: string, options?: Pick<Line, "sourceId" | "streaming">) => void;
type Status = (sessionId: string, value: string) => void;

export type { TurnJob, PendingApproval, PendingQuestion };

export function createTurnRunner({
  turnSequence, activeSessionId, jobs, promptQueue, titleAborts, pendingApprovals, pendingQuestions, unreadCompletions,
  sessionLines,
  runner, orchestrator, store, rememberSession, onTurnStart, setRunningIds, addFor, activityFor, recordThoughtUsage, resetThoughtUsage, getTurnActivities, setStatusFor,
  showApproval, showQuestion, dismissQuestion, setSession, setVexState, refreshUsage, setQueueVersion, setProcesses, setLiveUsage, getConfig,
  readLimits = readUsageLimits,
}: {
  turnSequence: MutableRefObject<number>;
  activeSessionId: MutableRefObject<string | undefined>;
  jobs: MutableRefObject<Map<string, TurnJob>>;
  promptQueue: MutableRefObject<PromptQueue>;
  titleAborts: MutableRefObject<Map<string, AbortController>>;
  pendingApprovals: MutableRefObject<Map<string, PendingApproval>>;
  pendingQuestions: MutableRefObject<Map<string, PendingQuestion>>;
  unreadCompletions: MutableRefObject<Set<string>>;
  sessionLines: MutableRefObject<Map<string, Line[]>>;
  runner: CodexRunner;
  orchestrator: Orchestrator;
  store: PaceStore;
  rememberSession: (session: Session) => void;
  onTurnStart: (sessionId: string) => void;
  setRunningIds: Dispatch<SetStateAction<string[]>>;
  addFor: AddLine;
  activityFor: (sessionId: string, event: Extract<Progress, { kind: "activity" }>) => void;
  recordThoughtUsage: (sessionId: string, turnId: number, total: number) => void;
  resetThoughtUsage: (sessionId: string) => void;
  getTurnActivities: (sessionId: string, turnId: number) => TurnActivity[];
  setStatusFor: Status;
  showApproval: (request: Extract<Progress, { kind: "approval" }>, sessionId?: string, owner?: AbortController) => void;
  showQuestion: (request: Extract<Progress, { kind: "question" }>, sessionId?: string, owner?: AbortController) => void;
  dismissQuestion: (id: string, sessionId: string) => void;
  setSession: Dispatch<SetStateAction<Session | undefined>>;
  setVexState: Dispatch<SetStateAction<"connecting" | "connected" | "failed">>;
  refreshUsage: () => void;
  setQueueVersion: Dispatch<SetStateAction<number>>;
  setProcesses: Dispatch<SetStateAction<RunningProcess[]>>;
  setLiveUsage: Dispatch<SetStateAction<Record<string, string>>>;
  getConfig: () => Config;
  readLimits?: () => Promise<UsageLimits | undefined>;
}) {
  const runTurn = async (text: string, turnSession: Session, turnConfig: Config, intent?: OperationIntent, displayPrompt?: string, automaticRetry = false, queuedOperation?: QueuedOperation): Promise<boolean> => {
    const steering = turnSession.steeringRecords?.find(record => record.id === queuedOperation?.id);
    if (steering) {
      addFor(turnSession.id, "error", `Queued operation is recorded as ${steering.state} steering. Review its delivery before explicitly submitting a new message.`);
      return false;
    }
    if (intent === "execute_plan" && !turnSession.executionSource && (turnSession.kind === "planning" || turnSession.plan || turnSession.planArtifact)) {
      const owner = new AbortController();
      jobs.current.set(turnSession.id, { session: turnSession, controller: owner, prompt: text });
      setRunningIds([...jobs.current.keys()]);
      try {
      const argument = (queuedOperation?.text ?? "").replace(/^\/(?:execute|run-plan)(?:\s+|$)/, "").trim();
      const execution = await preparePlanExecution(store, turnSession, turnConfig, argument || undefined, queuedOperation?.id);
      if (activeSessionId.current === turnSession.id) { activeSessionId.current = execution.session.id; setSession(execution.session); }
      rememberSession(execution.session);
      const success = execution.completed || await runTurn(execution.prompt, execution.session, turnConfig, intent, displayPrompt, automaticRetry, queuedOperation);
      if (success && queuedOperation) promptQueue.current.acknowledge(turnSession.id, queuedOperation.id);
      const next = success ? promptQueue.current.peekOperation(turnSession.id) : undefined;
      if (next) void runTurn(next.text, turnSession, getConfig(), next.intent, undefined, false, next);
      return success;
      } catch (error) { addFor(turnSession.id, "error", String(error)); return false; }
      finally { if (jobs.current.get(turnSession.id)?.controller === owner) jobs.current.delete(turnSession.id); setRunningIds([...jobs.current.keys()]); }
    }
    let succeeded = false;
    let deferredForRetry = false;
    let failedForRetry = false;
    let recoveredSession: Session | undefined;
    let activeRoute: Route = turnSession.route;
    let emittedMessages = 0;
    const streamingMessages = new Map<string, string>();
    const controller = new AbortController();
    const turnId = ++turnSequence.current;
    const sessionId = turnSession.id;
    const previousTurn = turnSession.turns.at(-1);
    resetThoughtUsage(sessionId);
    onTurnStart(sessionId);
    rememberSession(turnSession);
    jobs.current.set(sessionId, { session: turnSession, controller, prompt: text, automaticRetry, operationId: queuedOperation?.id, turnKey: randomUUID(),
      persistSteering: () => store.saveChanges(turnSession, () => activeSessionId.current === sessionId) });
    setRunningIds([...jobs.current.keys()]);
    if (!turnSession.turns.length && turnSession.executionSource) addFor(sessionId, "plan", turnSession.executionSource.plan);
    if (intent === "execute_plan" && turnSession.executionSource) displayPrompt ??= "Executing saved plan in a fresh agent session.";
    addFor(sessionId, displayPrompt ? "system" : "you", displayPrompt ?? text);
    setStatusFor(sessionId, "Starting…");
    const startTitle = () => {
    if (!turnSession.turns.length && !turnSession.title && !titleAborts.current.has(sessionId)) {
      const luna = turnConfig.models.find(model => model.enabled !== false && model.model === "gpt-6-luna");
      if (luna) {
        const titleController = new AbortController();
        titleAborts.current.set(sessionId, titleController);
        const titleRoute = { model: luna.model, effort: luna.efforts.includes("low") ? "low" as const : luna.defaultEffort ?? luna.efforts[0] };
        void durableRunner(runner, store, turnSession, "status", "title", () => activeSessionId.current === sessionId).run(
          `Create a short conversation title from this initial user prompt. Return only the title, at most 8 words. Do not answer the prompt.\n\n${text.slice(0, 4000)}`,
          turnSession.projectPath,
          titleRoute,
          undefined,
          () => {},
          titleController.signal,
          "side",
        ).then(async result => {
          const title = result.result.replace(/^['"#]+|['"#]+$/g, "").replace(/\s+/g, " ").trim().slice(0, 80);
          if (!title || turnSession.title || titleController.signal.aborted) return;
          turnSession.title = title;
          await store.saveChanges(turnSession, () => activeSessionId.current === sessionId);
          if (titleController.signal.aborted) return;
          rememberSession(turnSession);
          if (activeSessionId.current === sessionId) setSession({ ...turnSession });
        }).catch(() => {}).finally(() => {
          if (titleAborts.current.get(sessionId) === titleController) titleAborts.current.delete(sessionId);
        });
      }
    }
    };
    try {
      const onProgress = Object.assign(
        (progress: Progress) => {
          if (progress.kind === "steering" && progress.role !== "status") {
            const job = jobs.current.get(sessionId);
            if (job?.controller === controller) {
              job.steer = progress.steer;
              job.steerAttemptId = progress.attemptId;
              job.steerRole = progress.role;
            }
          }
          if (progress.kind === "status") {
            setStatusFor(sessionId, progress.text);
            if (activeSessionId.current === sessionId) setSession({ ...turnSession });
          }
          if (progress.kind === "route") {
            if (progress.role === "main") startTitle();
            activeRoute = progress.route;
            resetThoughtUsage(sessionId);
            setLiveUsage(old => ({ ...old, [sessionId]: "" }));
            setStatusFor(sessionId, `Using ${modelName(progress.route)}…`);
          }
          if (progress.kind === "usage") {
            setLiveUsage(old => ({ ...old, [sessionId]: formatLiveUsage(progress.usage, activeRoute) }));
            recordThoughtUsage(sessionId, turnId, progress.usage.reasoning_output_tokens);
          }
          if (progress.kind === "handoff") addFor(sessionId, "handoff", progress.text);
          if (progress.kind === "system") addFor(sessionId, "system", progress.text);
          if (progress.kind === "activity") {
            activityFor(sessionId, { ...progress, id: `turn-${turnId}-${progress.attemptId ?? "main"}-${progress.id}` });
            setStatusFor(sessionId, progress.category === "command" ? formatCommandStatus(progress.title) : progress.title);
          }
          if (progress.kind === "tasks") {
            rememberSession(turnSession);
            if (activeSessionId.current === sessionId) setSession({ ...turnSession });
          }
          if (progress.kind === "approval") showApproval(progress, sessionId, controller);
          if (progress.kind === "question") showQuestion(progress, sessionId, controller);
          if (progress.kind === "questionResolved") dismissQuestion(progress.id, sessionId);
          if (progress.kind === "error") addFor(sessionId, "error", progress.text);
          if (progress.kind === "message") {
            setStatusFor(sessionId, progress.completed === false ? "Responding…" : "Finishing response…");
            const sourceId = progress.id ? `turn-${turnId}-${progress.attemptId ?? "main"}-${progress.id}` : undefined;
            if (progress.text.trim() || sourceId && streamingMessages.has(sourceId)) {
              addFor(sessionId, "codex", progress.text, sourceId ? { sourceId, streaming: progress.completed === false } : undefined);
              if (progress.completed !== false && progress.text.trim()) emittedMessages++;
              if (sourceId) {
                if (progress.completed === false) streamingMessages.set(sourceId, progress.text);
                else streamingMessages.delete(sourceId);
              }
            }
          }
        },
        { interactive: true },
      );
      const outcome = await orchestrator.turn(
        text,
        turnSession,
        turnConfig,
        onProgress,
        controller.signal,
        () => activeSessionId.current === sessionId,
        intent,
        displayPrompt,
        queuedOperation,
      );
      succeeded = outcome.note !== "Vex requested clarification";
      if (turnSession.deferredTurn?.prompt === text) {
        turnSession.deferredTurn = undefined;
        await store.saveChanges(turnSession, () => activeSessionId.current === sessionId);
      }
      if (activeSessionId.current === sessionId) setSession({ ...outcome.session });
      if (emittedMessages === 0 && outcome.result.trim()) {
        addFor(sessionId, "codex", outcome.result);
      }
      if (intent === "verify_plan") {
        const old = sessionLines.current.get(sessionId) ?? [];
        const action: Line = { id: Date.now(), role: "verify-actions", text: "Planner: `/plan <zmiany>` · verifier: użyj `v <wiadomość>`", action: "revise-plan", spaceBefore: false };
        const updated = [...old, action];
        sessionLines.current.set(sessionId, updated);
        if (activeSessionId.current === sessionId) setSession({ ...outcome.session });
        addFor(sessionId, "divider", "");
      }
      if (outcome.stages.length) addFor(sessionId,
        "meta",
        formatTurnFooter(
          outcome.route,
          outcome.note,
          outcome.usage,
          outcome.durationMs,
          outcome.estimatedCostUsd,
        ),
      );
      for (const artifact of outcome.artifacts) addFor(sessionId, "artifact", artifactPath(store, outcome.session, artifact));
      addFor(sessionId, "divider", "");
      if (!turnSession.deferredTurn && outcome.role !== "aside" && outcome.role !== "verifier" && intent !== "verify_plan" && intent !== "continue_verify" && intent !== "aside" && outcome.session.id === sessionId && checkpointDue(turnSession)) {
        try {
          const checkpoint = await createCheckpointIfDue(turnSession, durableRunner(runner, store, turnSession, "status", "checkpoint", () => activeSessionId.current === sessionId), progress => {
            if (progress.kind === "status") setStatusFor(sessionId, progress.text);
            if (progress.kind === "approval") showApproval(progress, sessionId, controller);
            if (progress.kind === "question") showQuestion(progress, sessionId, controller);
            if (progress.kind === "questionResolved") dismissQuestion(progress.id, sessionId);
            if (progress.kind === "error") addFor(sessionId, "error", progress.text);
          }, controller.signal, turnConfig.approvalMode);
          await store.saveChanges(turnSession, () => activeSessionId.current === sessionId);
          if (checkpoint) await captureCheckpoint(store, turnSession, controller.signal).catch(error => addFor(sessionId, 'error', `Memory capture degraded: ${String(error)}`));
          if (activeSessionId.current === sessionId) setSession({ ...turnSession });
          if (checkpoint) addFor(sessionId, "meta", "Context checkpoint saved. The next turn starts a fresh thread.");
          else addFor(sessionId, "meta", "Context checkpoint could not be validated; the existing thread remains available.");
        } catch (error) {
          if (error instanceof SessionConflictError || error instanceof TransitionSaveError && error.cause instanceof SessionConflictError) throw error;
          if (error instanceof TransitionSaveError) succeeded = false;
          addFor(sessionId, "error", `Could not save context checkpoint: ${String(error)}`);
        }
      }
      const assessment = outcome.session.activeTask?.assessment;
      setStatusFor(sessionId, outcome.note === "Vex requested clarification" ? "Waiting for clarification"
        : !succeeded ? "Workflow paused after persistence failure"
        : outcome.role === "aside" ? "Side answer complete; main task retained"
        : outcome.role === "verifier" ? "Verification complete; planner retained"
        : assessment === "partial" ? "Task has remaining work"
        : assessment === "unknown" ? "Task completion unknown" : "Done");
      if (turnSession.routingMode === "auto") setVexState("connected");
      refreshUsage();
    } catch (error) {
      succeeded = false;
      const retryReason = error instanceof VexUnavailableError
        ? error.source === "connection" ? "network" : transientRetryReason(error)
        : isUsageLimitError(error) ? "usage" : transientRetryReason(error);
      if (controller.signal.aborted) {
        if (turnSession.deferredTurn?.prompt === text) {
          turnSession.deferredTurn = undefined;
          await store.saveChanges(turnSession, () => activeSessionId.current === sessionId).catch(() => {});
        }
        addFor(sessionId, "meta", "Turn cancelled by user");
        setStatusFor(sessionId, "Cancelled");
      } else if (retryReason) {
        const reason = retryReason;
        const attempt = (turnSession.deferredTurn?.prompt === text ? turnSession.deferredTurn.attempt : 0) + 1;
        const retryAt = reason === "usage"
          ? usageRetryAt(error, await readLimits().catch(() => undefined))
          : transientRetryAt(reason, attempt);
        turnSession.deferredTurn = { prompt: text, retryAt: retryAt.toISOString(), attempt, reason, intent, displayPrompt, ...(queuedOperation ? { operation: queuedOperation } : {}) };
        try {
          await store.saveChanges(turnSession, () => activeSessionId.current === sessionId);
          deferredForRetry = true;
          rememberSession(turnSession);
          if (activeSessionId.current === sessionId) setSession({ ...turnSession });
          addFor(sessionId, "error", String(error));
          const label = reason === "usage" ? "Usage limit reached" : reason === "network" ? "Connection unavailable" : "Model capacity reached";
          addFor(sessionId, "meta", `${label}. Pace saved this request and will retry ${reason === "network" ? "when the connection returns" : `after ${retryAt.toLocaleString()}`} while open, or on next launch. Press Esc to cancel. Existing changes remain; the resumed agent will inspect them before continuing.`);
          setStatusFor(sessionId, reason === "usage" ? "Waiting for Codex usage reset" : reason === "network" ? "Waiting for connection" : "Waiting for model capacity");
        } catch (saveError) {
          addFor(sessionId, "error", `Could not save automatic retry: ${String(saveError)}`);
          setStatusFor(sessionId, "Failed");
        }
      } else if (error instanceof SessionConflictError || error instanceof TransitionSaveError && error.cause instanceof SessionConflictError) {
        titleAborts.current.get(sessionId)?.abort();
        try {
          const recovery = await store.recoverConflict(turnSession);
          recoveredSession = recovery.session;
          if (activeSessionId.current === sessionId) setSession({ ...recoveredSession });
          addFor(sessionId, "meta", `Conversation refreshed after a conflicting save. Send your next prompt to continue; no restart is needed. The interrupted turn was not rerun. Unsaved state retained at ${recovery.snapshotPath}`);
          setStatusFor(sessionId, "Ready after conversation recovery");
        } catch (recoveryError) {
          addFor(sessionId, "error", `Could not recover conversation: ${String(recoveryError)}`);
          setStatusFor(sessionId, "Conversation recovery failed");
        }
      } else {
        const failedTurn = turnSession.turns.at(-1);
        failedForRetry = !!failedTurn?.failed && !failedTurn.cancelled && failedTurn.prompt === text;
        if (turnSession.deferredTurn?.prompt === text) {
          turnSession.deferredTurn = undefined;
          await store.saveChanges(turnSession, () => activeSessionId.current === sessionId).catch(() => {});
        }
        addFor(sessionId, "error", String(error));
        if (failedForRetry)
          addFor(sessionId, "meta", "Use /retry to run this request again. Existing file changes remain in place.");
        if (failedForRetry && promptQueue.current.list(sessionId).length)
          addFor(sessionId, "meta", "Queued prompts are paused until a turn succeeds.");
        if (error instanceof VexUnavailableError && error.source === "connection") setVexState("failed");
        setStatusFor(sessionId, "Failed");
      }
    } finally {
      for (const [sourceId, text] of streamingMessages) addFor(sessionId, "codex", text, { sourceId, streaming: false });
      const job = jobs.current.get(sessionId);
      await job?.pendingSteer?.catch(() => {});
      const lastTurn = turnSession.turns.at(-1);
      if (!recoveredSession && lastTurn && lastTurn !== previousTurn && job?.steeredPrompts?.length) {
        lastTurn.steeringRecordIds = turnSession.steeringRecords?.filter(record => record.turnKey === job.turnKey && record.state === "delivered").map(record => record.id);
        lastTurn.steeringPrompts = [...(lastTurn.steeringPrompts ?? []), ...job.steeredPrompts];
        await store.saveChanges(turnSession, () => activeSessionId.current === sessionId).catch(error => {
          addFor(sessionId, "error", `Could not save steering history: ${String(error)}`);
        });
      }
      if (!recoveredSession && lastTurn && lastTurn !== previousTurn) {
        const activities = getTurnActivities(sessionId, turnId);
        if (activities.length) lastTurn.activities = activities;
      }
      setLiveUsage(old => {
        const updated = { ...old };
        delete updated[sessionId];
        return updated;
      });
      if (!recoveredSession && lastTurn?.activities?.length) {
        await store.saveChanges(turnSession, () => activeSessionId.current === sessionId).catch(() => {});
      }
      setProcesses(old => old.filter(item => !item.id.startsWith(`turn-${turnId}-`)));
      const pending = pendingApprovals.current.get(sessionId);
      if (pending?.owner === controller) pending.respond("decline");
      const question = pendingQuestions.current.get(sessionId);
      if (question?.owner === controller) question.respond({});
      jobs.current.delete(sessionId);
      if (activeSessionId.current !== sessionId) unreadCompletions.current.add(sessionId);
      rememberSession(recoveredSession ?? turnSession);
      setRunningIds([...jobs.current.keys()]);
      if (typeof performance !== "undefined" && typeof performance.clearMeasures === "function") {
        try { performance.clearMeasures(); } catch {}
      }
      if (succeeded && queuedOperation) promptQueue.current.acknowledge(sessionId, queuedOperation.id);
      const next = !succeeded || deferredForRetry || failedForRetry || turnSession.deferredTurn ? undefined : promptQueue.current.peekOperation(sessionId);
      if (next !== undefined) {
        setQueueVersion(value => value + 1);
        void runTurn(next.text, turnSession, getConfig(), next.intent, undefined, false, next);
      }
    }
    return succeeded;
  };
  return runTurn;
}
