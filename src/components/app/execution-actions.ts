import { createTurnRunner } from "../turn-runner.js";
import { createShellRunner } from "../shell-runner.js";
import { compactSession } from "../../core/task-execution.js";
import { store, runner, orchestrator, project } from "./runtime.js";
import type { Session } from "../../shared/types.js";
import type { createInteractionActions } from "./interaction-actions.js";
import type { AppState } from "./useAppState.js";
import type { createTranscriptActions } from "./transcript-actions.js";
import type { usePromptQueue } from "./usePromptQueue.js";

export function createExecutionActions({ state, transcript, queue, interactions, rememberSession, refreshUsage }: {
  state: AppState;
  transcript: ReturnType<typeof createTranscriptActions>;
  queue: ReturnType<typeof usePromptQueue>;
  interactions: ReturnType<typeof createInteractionActions>;
  rememberSession: (session: Session) => void;
  refreshUsage: () => void;
}) {
  const { session, config, turnSequence, activeSessionId, jobs, titleAborts, pendingApprovals,
    pendingQuestions, unreadCompletions, sessionLines, thisPaceIds, lastReasoningTokens, setRunningIds,
    setSession, setVexState, setQueueVersion, setProcesses, setLiveUsage, latestConfig, runTurnRef,
    nextId, shells, setShellJobs } = state;
  const { promptQueue } = queue;
  const { addFor, add, activityFor, activity, recordThoughtUsage } = transcript;
  const { setStatusFor, showApproval, showQuestion, dismissQuestion } = interactions;
  const runTurn = createTurnRunner({
    turnSequence, activeSessionId, jobs, promptQueue, titleAborts, pendingApprovals, pendingQuestions, unreadCompletions, sessionLines,
    runner, orchestrator, store, rememberSession, onTurnStart: sessionId => thisPaceIds.current.add(sessionId), setRunningIds, addFor, activityFor,
    recordThoughtUsage, resetThoughtUsage: (sessionId: string) => lastReasoningTokens.current.delete(sessionId),
    getTurnActivities: (sessionId: string, turnId: number) => (sessionLines.current.get(sessionId) ?? [])
      .filter(line => line.sourceId?.startsWith(`turn-${turnId}-`) && line.activity?.completed)
      .slice(-200)
      .map(line => ({
        category: line.activity!.category, text: line.text.slice(0, 2000),
        detail: line.activity!.detail?.slice(0, 12000), outcome: line.activity!.outcome,
        durationMs: line.activity!.durationMs, tokens: line.activity!.tokens,
      })),
    setStatusFor, showApproval, showQuestion, dismissQuestion, setSession, setVexState, refreshUsage, setQueueVersion,
    setProcesses, setLiveUsage, getConfig: () => latestConfig.current ?? config!,
  });
  runTurnRef.current = runTurn;
  const shell = createShellRunner({
    project: session?.projectPath ?? project,
    nextId,
    shells,
    setShellJobs,
    approvalMode: config?.approvalMode ?? "request-approval",
    activity,
    add,
    requestApproval: (command, reason) => new Promise(resolveDecision => {
      showApproval({
        kind: "approval",
        id: `shell-approval-${nextId.current++}`,
        command,
        cwd: session?.projectPath ?? project,
        reason: config?.approvalMode === "limited" ? "Limited mode asks before each Bash command." : reason,
        respond: decision => resolveDecision(decision === "accept"),
      });
    }),
  });

  const compact = () => {
    if (!session || !config) return;
    const target = session;
    const sessionId = target.id;
    const threadId = session.threadId;
    const controller = new AbortController();
    jobs.current.set(sessionId, { session: target, controller, prompt: "/compact" });
    setRunningIds([...jobs.current.keys()]);
    addFor(sessionId, "info", "Compacting Codex context…");
    void (async () => {
      let completed = false;
      try {
        const result = await compactSession(store, target, runner,
          progress => { if (progress.kind === "status") setStatusFor(sessionId, progress.text); }, controller.signal,
          () => activeSessionId.current === sessionId);
        rememberSession(target);
        completed = result.outcome === "completed";
        if (activeSessionId.current === sessionId) setSession({ ...target });
        const detail = result.outcome === "completed" ? "Context compacted." :
          result.outcome === "cancelled" ? "Compaction cancelled." : `Compaction failed: ${result.error ?? "unknown error"}`;
        addFor(sessionId, result.outcome === "failed" ? "error" : "info", detail);
        setStatusFor(sessionId, result.outcome === "completed" ? "Done" : result.outcome === "cancelled" ? "Cancelled" : "Failed");
      } catch (error) {
        addFor(sessionId, "error", `Could not save compaction: ${String(error)}`);
        setStatusFor(sessionId, "Failed");
      } finally {
        jobs.current.delete(sessionId);
        if (activeSessionId.current !== sessionId) unreadCompletions.current.add(sessionId);
        setRunningIds([...jobs.current.keys()]);
        const next = completed ? promptQueue.current.peekOperation(sessionId) : undefined;
        if (next !== undefined) {
          setQueueVersion(value => value + 1);
          void runTurn(next.text, target, config, next.intent, undefined, false, next);
        }
      }
    })();
  };

  return { runTurn, shell, compact };
}
