import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { Config, Route, Session, TurnActivity } from "../shared/types.js";
import type { CodexRunner, Progress } from "../integrations/codex.js";
import { Orchestrator, VexUnavailableError } from "../core/orchestrator.js";
import { PaceStore } from "../core/sessions.js";
import { PromptQueue } from "../core/prompt-queue.js";
import { checkpointDue, createCheckpointIfDue } from "../core/checkpoint.js";
import { formatLiveUsage, formatTurnFooter, modelName } from "./turn-format.js";
import type { Line } from "./Transcript.js";
import { updateAgentTasks } from "../core/tasks.js";
import { formatCommandActivity } from "./shell-runner.js";
import type { RunningProcess } from "./RunningProcesses.js";

type TurnJob = { session: Session; controller: AbortController; prompt: string };
type PendingApproval = Extract<Progress, { kind: "approval" }> & { owner?: AbortController };
type AddLine = (sessionId: string, role: Line["role"], text: string) => void;
type Status = (sessionId: string, value: string) => void;

export type { TurnJob, PendingApproval };

export function createTurnRunner({
  turnSequence, activeSessionId, jobs, promptQueue, titleAborts, pendingApprovals, unreadCompletions,
  runner, orchestrator, store, rememberSession, onTurnStart, setRunningIds, addFor, activityFor, recordThoughtUsage, resetThoughtUsage, getTurnActivities, setStatusFor,
  showApproval, setSession, setVexState, refreshUsage, setQueueVersion, setProcesses, setLiveUsage, getConfig,
}: {
  turnSequence: MutableRefObject<number>;
  activeSessionId: MutableRefObject<string | undefined>;
  jobs: MutableRefObject<Map<string, TurnJob>>;
  promptQueue: MutableRefObject<PromptQueue>;
  titleAborts: MutableRefObject<Map<string, AbortController>>;
  pendingApprovals: MutableRefObject<Map<string, PendingApproval>>;
  unreadCompletions: MutableRefObject<Set<string>>;
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
  setSession: Dispatch<SetStateAction<Session | undefined>>;
  setVexState: Dispatch<SetStateAction<"connecting" | "connected" | "failed">>;
  refreshUsage: () => void;
  setQueueVersion: Dispatch<SetStateAction<number>>;
  setProcesses: Dispatch<SetStateAction<RunningProcess[]>>;
  setLiveUsage: Dispatch<SetStateAction<Record<string, string>>>;
  getConfig: () => Config;
}) {
  const runTurn = async (text: string, turnSession: Session, turnConfig: Config) => {
    let tasksChanged = false;
    let activeRoute: Route = turnSession.route;
    const controller = new AbortController();
    const turnId = ++turnSequence.current;
    const sessionId = turnSession.id;
    const previousTurn = turnSession.turns.at(-1);
    resetThoughtUsage(sessionId);
    onTurnStart(sessionId);
    rememberSession(turnSession);
    jobs.current.set(sessionId, { session: turnSession, controller, prompt: text });
    setRunningIds([...jobs.current.keys()]);
    addFor(sessionId, "you", text);
    setStatusFor(sessionId, "Starting…");
    if (!turnSession.turns.length && !turnSession.title && !titleAborts.current.has(sessionId)) {
      const luna = turnConfig.models.find(model => model.enabled !== false && model.model === "gpt-6-luna");
      if (luna) {
        const titleController = new AbortController();
        titleAborts.current.set(sessionId, titleController);
        const titleRoute = { model: luna.model, effort: luna.efforts.includes("low") ? "low" as const : luna.defaultEffort ?? luna.efforts[0] };
        void runner.run(
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
          await store.save(turnSession, () => activeSessionId.current === sessionId);
          rememberSession(turnSession);
          if (activeSessionId.current === sessionId) setSession({ ...turnSession });
        }).catch(() => {}).finally(() => {
          if (titleAborts.current.get(sessionId) === titleController) titleAborts.current.delete(sessionId);
        });
      }
    }
    try {
      const outcome = await orchestrator.turn(
        text,
        turnSession,
        turnConfig,
        (progress) => {
          if (progress.kind === "status") {
            setStatusFor(sessionId, progress.text);
            if (activeSessionId.current === sessionId) setSession({ ...turnSession });
          }
          if (progress.kind === "route") {
            activeRoute = progress.route;
            resetThoughtUsage(sessionId);
            setLiveUsage(old => ({ ...old, [sessionId]: "" }));
            setStatusFor(sessionId, `Using ${modelName(progress.route)}…`);
          }
          if (progress.kind === "usage") {
            setLiveUsage(old => ({ ...old, [sessionId]: formatLiveUsage(progress.usage, activeRoute) }));
            recordThoughtUsage(sessionId, turnId, progress.usage.reasoning_output_tokens);
          }
          if (progress.kind === "system") addFor(sessionId, "system", progress.text);
          if (progress.kind === "activity") {
            activityFor(sessionId, { ...progress, id: `turn-${turnId}-${progress.id}` });
            setStatusFor(sessionId, progress.category === "command" ? formatCommandActivity(progress.title).title : progress.title);
          }
          if (progress.kind === "tasks") {
            turnSession.tasks = updateAgentTasks(turnSession.tasks, progress.items);
            tasksChanged = true;
            rememberSession(turnSession);
            if (activeSessionId.current === sessionId) setSession({ ...turnSession });
          }
          if (progress.kind === "approval") showApproval(progress, sessionId, controller);
          if (progress.kind === "error") addFor(sessionId, "error", progress.text);
          if (progress.kind === "message") {
            setStatusFor(sessionId, "Finishing response…");
          }
        },
        controller.signal,
        () => activeSessionId.current === sessionId,
      );
      if (activeSessionId.current === sessionId) setSession({ ...outcome.session });
      addFor(sessionId, "codex", outcome.result);
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
      for (const artifact of outcome.artifacts) addFor(sessionId, "artifact", artifact);
      addFor(sessionId, "divider", "");
      if (checkpointDue(turnSession)) {
        try {
          const checkpoint = await createCheckpointIfDue(turnSession, runner, progress => {
            if (progress.kind === "status") setStatusFor(sessionId, progress.text);
            if (progress.kind === "approval") showApproval(progress, sessionId, controller);
            if (progress.kind === "error") addFor(sessionId, "error", progress.text);
          }, controller.signal, turnConfig.approvalMode);
          await store.save(turnSession, () => activeSessionId.current === sessionId);
          if (activeSessionId.current === sessionId) setSession({ ...turnSession });
          if (checkpoint) addFor(sessionId, "meta", "Context checkpoint saved for a future handoff.");
          else addFor(sessionId, "meta", "Context checkpoint could not be validated; the existing thread remains available.");
        } catch (error) {
          addFor(sessionId, "error", `Could not save context checkpoint: ${String(error)}`);
        }
      }
      setStatusFor(sessionId, "Done");
      refreshUsage();
    } catch (error) {
      if (controller.signal.aborted) {
        addFor(sessionId, "meta", "Turn cancelled by user");
        setStatusFor(sessionId, "Cancelled");
      } else {
        addFor(sessionId, "error", String(error));
        if (error instanceof VexUnavailableError && error.source === "connection") setVexState("failed");
        setStatusFor(sessionId, "Failed");
      }
    } finally {
      const lastTurn = turnSession.turns.at(-1);
      if (lastTurn && lastTurn !== previousTurn) {
        const activities = getTurnActivities(sessionId, turnId);
        if (activities.length) lastTurn.activities = activities;
      }
      setLiveUsage(old => {
        const updated = { ...old };
        delete updated[sessionId];
        return updated;
      });
      if (tasksChanged || lastTurn?.activities?.length) {
        await store.save(turnSession, () => activeSessionId.current === sessionId).catch(() => {});
      }
      setProcesses(old => old.filter(item => !item.id.startsWith(`turn-${turnId}-`)));
      const pending = pendingApprovals.current.get(sessionId);
      if (pending?.owner === controller) pending.respond("decline");
      jobs.current.delete(sessionId);
      if (activeSessionId.current !== sessionId) unreadCompletions.current.add(sessionId);
      rememberSession(turnSession);
      setRunningIds([...jobs.current.keys()]);
      if (typeof performance !== "undefined" && typeof performance.clearMeasures === "function") {
        try { performance.clearMeasures(); } catch {}
      }
      const next = promptQueue.current.take(sessionId);
      if (next !== undefined) {
        setQueueVersion(value => value + 1);
        void runTurn(next, turnSession, getConfig());
      }
    }
  };
  return runTurn;
}
