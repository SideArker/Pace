import type { ApprovalMode } from "../../shared/types.js";
import { useAppInput } from "../useAppInput.js";
import { steerQueuedPrompt } from "../queue-steering.js";
import { store } from "./runtime.js";
import type { useModelRouting } from "./useModelRouting.js";
import type { useSessionActions } from "./useSessionActions.js";
import type { createPlanningActions } from "./planning-actions.js";
import type { AppState } from "./useAppState.js";
import type { createTranscriptActions } from "./transcript-actions.js";
import type { usePromptQueue } from "./usePromptQueue.js";
import type { useConversations } from "./useConversations.js";

export function useAppKeyboard({ state, transcript, queue, conversations, routing, sessions, planning, onClear }: {
  state: AppState;
  transcript: ReturnType<typeof createTranscriptActions>;
  queue: ReturnType<typeof usePromptQueue>;
  conversations: ReturnType<typeof useConversations>;
  routing: ReturnType<typeof useModelRouting>;
  sessions: ReturnType<typeof useSessionActions>;
  planning: ReturnType<typeof createPlanningActions>;
  onClear: () => void;
}) {
  const { pickerFocused, setPickerFocused, pickerIndex, setPickerIndex, pickerSearch, setPickerSearch,
    approval, question, pendingApprovals, pendingQuestions, activeSessionId, jobs, sideAbort, outputsExpanded, setOutputsExpanded,
    setTranscriptRevision, approvalMenu, setApprovalMenu, latestConfig, setConfig, resumeMenu, setResumeMenu,
    resumeChoices, missingProjectPaths, convoMenu, setConvoMenu, session, setSession, draft, setDraft,
    setHistory, queueMenu, setQueueMenu, setQueueVersion, diffOpen, mcpOpen } = state;
  const { modelMenu, setModelMenu, menuModels, menuEfforts, manualMenu, setManualMenu,
    manualRoutes, selectManualRoute, manualOptions, selectManualOption, menuIndex, setMenuIndex,
    setMenuModel, toggleModel, toggleEffort } = routing;
  const { add, addFor, renderSessionTurns } = transcript;
  const { promptQueue, queued } = queue;
  const { sortedSessions } = conversations;
  const { interrupt, cancelRetry, activateSession, changeHistory } = sessions;
  const { startOrTogglePlanning, handleExecutePlan, applyVerification } = planning;
  const focusPicker = () => {
    if (sortedSessions.length < 2 || modelMenu || convoMenu || queueMenu || approvalMenu || manualMenu) return false;
    const pendingIndex = sortedSessions.findIndex(item => item.id !== activeSessionId.current && (pendingApprovals.current.has(item.id) || pendingQuestions.current.has(item.id)));
    const current = sortedSessions.findIndex(item => item.id === activeSessionId.current);
    setPickerIndex(pendingIndex >= 0 ? pendingIndex : current >= 0 ? (current + 1) % sortedSessions.length : 0);
    setPickerFocused(true);
    return true;
  };
  const cancelArmed = useAppInput({
    interrupt, cancelRetry, pickerFocused, setPickerFocused, pickerIndex, setPickerIndex,
    pickerSearch, setPickerSearch,
    openSessions: sortedSessions, activateSession, approval, question, focusPicker, pendingApprovals,
    activeSessionId, jobs, sideAbort, outputsExpanded, setOutputsExpanded,
    redrawTranscript: () => { onClear(); setTranscriptRevision(value => value + 1); },
    modelMenu, setModelMenu, menuModels, menuEfforts,
    approvalMenu, setApprovalMenu, selectApprovalMode: async (mode: ApprovalMode) => {
      try {
        const updated = { ...latestConfig.current!, approvalMode: mode };
        await store.saveConfig(updated);
        setConfig(updated);
        latestConfig.current = updated;
        setApprovalMenu(false);
        add("info", `Approval mode: ${mode}. Active turns keep their starting mode.`);
      } catch (error) { add("error", `Could not save approval mode: ${String(error)}`); }
    },
    manualMenu, setManualMenu, manualRoutes, selectManualRoute, manualOptions, selectManualOption,
    menuIndex, setMenuIndex, setMenuModel, toggleModel, toggleEffort,
    resumeMenu, setResumeMenu, resumeChoices, missingProjectPaths, add,
    convoMenu, setConvoMenu, session, store, setSession, renderSessionTurns,
    draft, setDraft, setHistory, queueMenu, setQueueMenu, promptQueue, setQueueVersion,
    onQueueSteer: (sessionId, index) => {
      void steerQueuedPrompt(sessionId, index, jobs.current, promptQueue.current).then(prompt => {
        addFor(sessionId, "you", `Steering: ${prompt}`);
        setQueueVersion(value => value + 1);
        if (activeSessionId.current === sessionId) setQueueMenu(false);
      }).catch(error => addFor(sessionId, "error", `Could not steer: ${error instanceof Error ? error.message : String(error)}`));
    },
    onTogglePlan: () => { void startOrTogglePlanning(); },
    onExecutePlan: () => { void handleExecutePlan(); },
    onApplyVerification: applyVerification,
    onUndo: () => { void changeHistory("undo"); },
    onRedo: () => { void changeHistory("redo"); },
    diffOpen, modalOpen: mcpOpen || state.benchmarkOpen || state.memoryOpen,
  });
  const focusQueuedOrPicker = () => {
    if (queued.length && !modelMenu && !convoMenu && !queueMenu && !approvalMenu && !manualMenu) {
      setQueueMenu(true);
      setMenuIndex(0);
      return true;
    }
    return focusPicker();
  };

  return { cancelArmed, focusQueuedOrPicker };
}
