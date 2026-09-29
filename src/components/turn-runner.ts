import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { Config, Session } from "../shared/types.js";
import type { CodexRunner, Progress } from "../integrations/codex.js";
import { Orchestrator, VexUnavailableError } from "../core/orchestrator.js";
import { PaceStore } from "../core/sessions.js";
import { PromptQueue } from "../core/prompt-queue.js";
import { formatTurnFooter, modelName } from "./turn-format.js";
import type { Line } from "./Transcript.js";

type TurnJob = { session: Session; controller: AbortController; prompt: string };
type PendingApproval = Extract<Progress, { kind: "approval" }> & { owner?: AbortController };
type AddLine = (sessionId: string, role: Line["role"], text: string) => void;
type Status = (sessionId: string, value: string) => void;

export type { TurnJob, PendingApproval };

export function createTurnRunner({
  turnSequence, activeSessionId, jobs, promptQueue, titleAborts, pendingApprovals, unreadCompletions,
  runner, orchestrator, store, rememberSession, setRunningIds, addFor, activityFor, setStatusFor,
  showApproval, setSession, setVexState, refreshUsage, setQueueVersion,
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
  setRunningIds: Dispatch<SetStateAction<string[]>>;
  addFor: AddLine;
  activityFor: (sessionId: string, event: Extract<Progress, { kind: "activity" }>) => void;
  setStatusFor: Status;
  showApproval: (request: Extract<Progress, { kind: "approval" }>, sessionId?: string, owner?: AbortController) => void;
  setSession: Dispatch<SetStateAction<Session | undefined>>;
  setVexState: Dispatch<SetStateAction<"connecting" | "connected" | "failed">>;
  refreshUsage: () => void;
  setQueueVersion: Dispatch<SetStateAction<number>>;
}) {
  const runTurn = async (text: string, turnSession: Session, turnConfig: Config) => {
    const controller = new AbortController();
    const turnId = ++turnSequence.current;
    const sessionId = turnSession.id;
    rememberSession(turnSession);
    jobs.current.set(sessionId, { session: turnSession, controller, prompt: text });
    setRunningIds([...jobs.current.keys()]);
    addFor(sessionId, "you", text);
    setStatusFor(sessionId, "Starting…");
    if (!turnSession.turns.length && !turnSession.title) {
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
          if (!title || turnSession.title) return;
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
          if (progress.kind === "route")
            setStatusFor(sessionId, `Using ${modelName(progress.route)}…`);
          if (progress.kind === "system") addFor(sessionId, "system", progress.text);
          if (progress.kind === "activity") {
            activityFor(sessionId, { ...progress, id: `turn-${turnId}-${progress.id}` });
            setStatusFor(sessionId, progress.title);
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
      const pending = pendingApprovals.current.get(sessionId);
      if (pending?.owner === controller) pending.respond("decline");
      jobs.current.delete(sessionId);
      if (activeSessionId.current !== sessionId) unreadCompletions.current.add(sessionId);
      rememberSession(turnSession);
      setRunningIds([...jobs.current.keys()]);
      const next = promptQueue.current.take(sessionId);
      if (next !== undefined) {
        setQueueVersion(value => value + 1);
        void runTurn(next, turnSession, turnConfig);
      }
    }
  };
  return runTurn;
}
