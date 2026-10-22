import { useEffect, useRef } from "react";
import type { Session } from "../../shared/types.js";
import { newSession } from "../../core/sessions.js";
import { changeConversationHistory } from "../../core/file-history.js";
import { store, project } from "./runtime.js";
import type { AppState } from "./useAppState.js";
import type { createTranscriptActions } from "./transcript-actions.js";
import type { usePromptQueue } from "./usePromptQueue.js";
import type { useConversations } from "./useConversations.js";

export function useSessionActions({ state, transcript, queue, conversations, setStatusFor, onClear, exit }: {
  state: AppState;
  transcript: ReturnType<typeof createTranscriptActions>;
  queue: ReturnType<typeof usePromptQueue>;
  conversations: ReturnType<typeof useConversations>;
  setStatusFor: (sessionId: string, status: string) => void;
  onClear: () => void;
  exit: () => void;
}) {
  const { session, config, jobs, switchingSession, activeSessionId, sessionDrafts, draft,
    thisPaceIds, sessionRecords, unreadCompletions, sessionLines, pendingApprovals, pendingQuestions,
    sessionStatuses, historyBusy, shellJobs, lastInterruptAt, sideAbort, setSideBusy, setSession,
    setResumeMenu, setConvoMenu, setPickerFocused, setPickerIndex, setDraft, setShowHeader,
    setLines, setApproval, setQuestion, setHistory, setStatus, setQueueVersion, setHistoryChanging,
    setOpenSessions, setShowConversationsTab } = state;
  const { add, addFor, renderSessionTurns } = transcript;
  const { promptQueue } = queue;
  const { sortedSessions, rememberSession } = conversations;
  const stopSideQuestion = () => {
    const pending = sideAbort.current;
    sideAbort.current = undefined;
    pending?.abort();
    setSideBusy(false);
  };
  const activateSession = async (chosen: Session) => {
    if (switchingSession.current) return;
    switchingSession.current = true;
    const previousId = activeSessionId.current;
    let target = jobs.current.get(chosen.id)?.session ?? chosen;
    if (previousId) sessionDrafts.current.set(previousId, draft);
    activeSessionId.current = target.id;
    try {
      if (!thisPaceIds.current.has(target.id) && !jobs.current.has(target.id)) {
        const full = await store.load(target.projectPath, target.id);
        if (full) target = full;
      }
      promptQueue.current.restore(target.id, target.queuedPrompts ?? []);
      sessionRecords.current.set(target.id, target);
      thisPaceIds.current.add(target.id);
      await store.activate(target);
      stopSideQuestion();
      onClear();
      setSession(target);
      unreadCompletions.current.delete(target.id);
      rememberSession(target);
      setResumeMenu(false);
      setConvoMenu(false);
      setPickerFocused(false);
      const targetIndex = sortedSessions.findIndex(item => item.id === target.id);
      setPickerIndex(targetIndex < 0 ? 0 : targetIndex);
      setDraft(sessionDrafts.current.get(target.id) ?? "");
      setShowHeader(true);
      if (sessionLines.current.has(target.id)) setLines(sessionLines.current.get(target.id)!);
      else renderSessionTurns(target);
      setApproval(pendingApprovals.current.get(target.id));
      setQuestion(pendingQuestions.current.get(target.id));
      setHistory(target.turns.map(t => t.prompt));
      setStatus(sessionStatuses.current.get(target.id) ?? (target.deferredTurn ? "Waiting for automatic retry" : "Ready"));
    } catch (error) {
      activeSessionId.current = previousId;
      if (previousId) setLines(sessionLines.current.get(previousId) ?? []);
      add("error", `Could not activate conversation: ${String(error)}`);
    } finally {
      switchingSession.current = false;
    }
  };
  const cancelRetry = async () => {
    const target = session;
    if (!target?.deferredTurn || jobs.current.has(target.id)) return;
    target.deferredTurn = undefined;
    const removed = promptQueue.current.clear(target.id);
    setQueueVersion(value => value + 1);
    setSession({ ...target });
    rememberSession(target);
    setStatusFor(target.id, "Ready");
    addFor(target.id, "info", `Automatic retry cancelled${removed ? `; ${removed} queued prompt${removed === 1 ? "" : "s"} cleared` : ""}.`);
    try { await store.saveChanges(target); }
    catch (error) { addFor(target.id, "error", `Could not save retry cancellation: ${String(error)}`); }
  };
  const interrupt = () => {
    const now = Date.now();
    if (now - lastInterruptAt.current < 150) return;
    lastInterruptAt.current = now;
    const id = activeSessionId.current;
    const pending = id ? pendingApprovals.current.get(id) : undefined;
    pending?.respond("decline");
    const pendingQuestion = id ? pendingQuestions.current.get(id) : undefined;
    pendingQuestion?.respond({});
    const job = id ? jobs.current.get(id) : undefined;
    if (job || sideAbort.current) {
      if (id && job) {
        const cleared = promptQueue.current.clear(id);
        if (cleared) {
          setQueueVersion(value => value + 1);
          addFor(id, "info", `Cleared ${cleared} queued prompt${cleared === 1 ? "" : "s"}.`);
        }
      }
      job?.controller.abort();
      sideAbort.current?.abort();
      if (id) setStatusFor(id, "Cancelling…");
    } else if (session?.deferredTurn) {
      void cancelRetry();
    } else if (jobs.current.size) {
      add("info", `${jobs.current.size} background turn(s) running. Use the conversation picker to switch or /exit to quit.`);
    } else exit();
  };
  const interruptRef = useRef(interrupt);
  interruptRef.current = interrupt;
  useEffect(() => {
    const onSignal = () => interruptRef.current();
    process.on("SIGINT", onSignal);
    return () => { process.off("SIGINT", onSignal); };
  }, []);
  const changeHistory = async (direction: "undo" | "redo") => {
    if (!session || historyBusy.current) return;
    if (jobs.current.has(session.id) || shellJobs) { add("info", "Wait for running work before changing history."); return; }
    historyBusy.current = true;
    setHistoryChanging(true);
    try {
      const result = await changeConversationHistory(store, session, direction);
      if (!result) { add("info", `No turn to ${direction}.`); return; }
      setSession({ ...session });
      rememberSession(session);
      renderSessionTurns(session);
      setDraft(direction === "undo" ? result.turn.prompt : "");
      setHistory(session.turns.map(turn => turn.prompt));
      add("info", `${direction === "undo" ? "Undid" : "Restored"} last turn and ${result.files} file change${result.files === 1 ? "" : "s"}.${!result.turn.fileEdits ? " Conversation only: no file snapshot was saved for this turn." : ""}${direction === "undo" ? " Prompt restored to composer. Use /redo to restore the turn." : ""}`);
    } catch (error) { add("error", String(error)); }
    finally { historyBusy.current = false; setHistoryChanging(false); }
  };

  const startNewConversation = async () => {
    if (!session || !config) return;
    const fresh = newSession(project, session.routingMode, undefined, config.autoLaunchSkills);
    thisPaceIds.current.add(fresh.id);
    if (session.routingMode === "manual") { fresh.route = session.route; fresh.manualWorkflow = session.manualWorkflow; }
    switchingSession.current = true;
    const previousId = activeSessionId.current;
    if (previousId) {
      sessionDrafts.current.set(previousId, "");
      if (session) {
        session.updatedAt = new Date().toISOString();
        void store.saveChanges(session).catch(() => { });
      }
    }
    activeSessionId.current = fresh.id;
    try {
      await store.saveChanges(fresh);
      stopSideQuestion();
      onClear();
      activeSessionId.current = fresh.id;
      sessionLines.current.set(fresh.id, []);
      setSession(fresh);
      setOpenSessions(old => {
        const map = new Map<string, Session>();
        if (session) map.set(session.id, session);
        for (const s of old) map.set(s.id, s);
        map.set(fresh.id, fresh);
        return [...map.values()];
      });
      setShowConversationsTab(true);
      setLines([]);
      setDraft("");
      setHistory([]);
      setPickerFocused(false);
      setPickerIndex(0);
      setShowHeader(true);
      setStatus("Ready");
      setApproval(undefined);
    } catch (error) {
      activeSessionId.current = previousId;
      if (previousId) setLines(sessionLines.current.get(previousId) ?? []);
      add("error", `Could not create conversation: ${String(error)}`);
    } finally {
      switchingSession.current = false;
    }
  };

  return { stopSideQuestion, activateSession, cancelRetry, interrupt, changeHistory, startNewConversation };
}
