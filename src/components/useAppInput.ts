import { useInput } from "ink";
import { useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { ApprovalDecision, Progress } from "../integrations/codex.js";
import { EFFORTS } from "../shared/config.js";
import type { ApprovalMode, Route, Session } from "../shared/types.js";
import { PaceStore, rewindConversation, deleteConversationTurn } from "../core/sessions.js";
import type { PromptQueue } from "../core/prompt-queue.js";
import { isAltDeleteKey } from "./Composer.js";
import type { Line } from "./Transcript.js";
import type { PendingApproval, TurnJob } from "./turn-runner.js";

const DOUBLE_ESCAPE_MS = 750;

export function isSecondEscape(previous: { sessionId: string; at: number } | undefined, sessionId: string, now: number): boolean {
  return !!previous && previous.sessionId === sessionId && now - previous.at >= 0 && now - previous.at <= DOUBLE_ESCAPE_MS;
}

export function useAppInput(options: {
  historyBusy?: MutableRefObject<boolean>;
  interrupt: () => void;
  cancelRetry: () => void;
  pickerFocused: boolean;
  setPickerFocused: Dispatch<SetStateAction<boolean>>;
  pickerIndex: number;
  setPickerIndex: Dispatch<SetStateAction<number>>;
  openSessions: Session[];
  activateSession: (session: Session) => Promise<void>;
  approval: Extract<Progress, { kind: "approval" }> | undefined;
  question: Extract<Progress, { kind: "question" }> | undefined;
  focusPicker: () => boolean;
  pendingApprovals: MutableRefObject<Map<string, PendingApproval>>;
  activeSessionId: MutableRefObject<string | undefined>;
  jobs: MutableRefObject<Map<string, TurnJob>>;
  sideAbort: MutableRefObject<AbortController | undefined>;
  outputsExpanded: boolean;
  setOutputsExpanded: Dispatch<SetStateAction<boolean>>;
  redrawTranscript: () => void;
  modelMenu: "models" | "efforts" | undefined;
  approvalMenu: boolean;
  setApprovalMenu: Dispatch<SetStateAction<boolean>>;
  selectApprovalMode: (mode: ApprovalMode) => Promise<void>;
  manualMenu?: boolean;
  setManualMenu?: Dispatch<SetStateAction<boolean>>;
  manualRoutes?: Route[];
  selectManualRoute?: (route: Route | (typeof EFFORTS)[number]) => Promise<void>;
  manualOptions?: string[];
  selectManualOption?: (index: number) => void;
  setModelMenu: Dispatch<SetStateAction<"models" | "efforts" | undefined>>;
  menuModels: string[];
  menuEfforts: readonly (typeof EFFORTS)[number][];
  menuIndex: number;
  setMenuIndex: Dispatch<SetStateAction<number>>;
  setMenuModel: Dispatch<SetStateAction<string>>;
  toggleModel: (name: string) => void;
  toggleEffort: (effort: (typeof EFFORTS)[number]) => void;
  resumeMenu: boolean;
  setResumeMenu: Dispatch<SetStateAction<boolean>>;
  resumeChoices: Session[];
  missingProjectPaths: string[];
  add: (role: Line["role"], text: string) => void;
  convoMenu: boolean;
  setConvoMenu: Dispatch<SetStateAction<boolean>>;
  session: Session | undefined;
  store: PaceStore;
  setSession: Dispatch<SetStateAction<Session | undefined>>;
  renderSessionTurns: (session: Session) => void;
  draft?: string;
  setDraft: Dispatch<SetStateAction<string>>;
  setHistory: Dispatch<SetStateAction<string[]>>;
  queueMenu?: boolean;
  setQueueMenu?: Dispatch<SetStateAction<boolean>>;
  promptQueue?: MutableRefObject<PromptQueue>;
  setQueueVersion?: Dispatch<SetStateAction<number>>;
  onQueueSteer?: (sessionId: string, index: number) => void;
  onTogglePlan?: () => void;
  onExecutePlan?: () => void;
  onApplyVerification?: () => void;
  onUndo?: () => void;
  onRedo?: () => void;
  diffOpen?: boolean;
  modalOpen?: boolean;
  pickerSearch?: string;
  setPickerSearch?: Dispatch<SetStateAction<string>>;
}) {
  const {
    interrupt, cancelRetry, pickerFocused, setPickerFocused, pickerIndex, setPickerIndex,
    openSessions, activateSession, approval, question, focusPicker, pendingApprovals,
    activeSessionId, jobs, sideAbort, outputsExpanded, setOutputsExpanded, redrawTranscript,
    modelMenu, setModelMenu, approvalMenu, setApprovalMenu, selectApprovalMode,
    manualMenu, setManualMenu, manualRoutes, selectManualRoute, manualOptions, selectManualOption,
    menuModels, menuEfforts, menuIndex,
    setMenuIndex, setMenuModel, toggleModel, toggleEffort, resumeMenu,
    setResumeMenu, resumeChoices, missingProjectPaths, add, convoMenu,
    setConvoMenu, session, store, setSession, renderSessionTurns, draft, setDraft,
    setHistory, queueMenu, setQueueMenu, promptQueue, setQueueVersion,
    onTogglePlan, onExecutePlan, onApplyVerification, onUndo, onRedo, diffOpen, pickerSearch, setPickerSearch,
  } = options;
  const lastEscape = useRef<{ sessionId: string; at: number } | undefined>(undefined);
  const escapeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [cancelArmed, setCancelArmed] = useState(false);
  const clearEscape = () => {
    lastEscape.current = undefined;
    if (escapeTimer.current) clearTimeout(escapeTimer.current);
    escapeTimer.current = undefined;
    setCancelArmed(false);
  };
  useEffect(() => () => { if (escapeTimer.current) clearTimeout(escapeTimer.current); }, []);
  const handleCancelEscape = () => {
    const id = activeSessionId.current;
    if (id && !jobs.current.has(id) && !sideAbort.current && !approval && !question && session?.deferredTurn) {
      cancelRetry();
      return true;
    }
    if (id && jobs.current.get(id)?.automaticRetry) {
      interrupt();
      return true;
    }
    if (!(id && jobs.current.has(id)) && !sideAbort.current && !approval && !question) return false;
    const sessionId = id ?? "";
    const now = Date.now();
    if (isSecondEscape(lastEscape.current, sessionId, now)) {
      clearEscape();
      interrupt();
    } else {
      clearEscape();
      lastEscape.current = { sessionId, at: now };
      setCancelArmed(true);
      escapeTimer.current = setTimeout(clearEscape, DOUBLE_ESCAPE_MS);
    }
    return true;
  };
  const historyWrite = useRef(false);
  useInput((input, key) => {
    if (diffOpen || options.modalOpen) return;
    if (!key.escape) clearEscape();
    else if (pickerFocused || modelMenu || approvalMenu || resumeMenu || convoMenu || queueMenu || manualMenu) clearEscape();
    if (key.ctrl && input === "c") {
      if (draft) {
        setDraft("");
        return;
      }
      interrupt();
      return;
    }
    if (key.ctrl && (input.toLowerCase() === "o" || input === "\x0f")) {
      redrawTranscript();
      setOutputsExpanded(value => !value);
      return;
    }
    if (pickerFocused) {
      const query = (pickerSearch ?? "").trim().toLowerCase();
      const effectiveSessions = query
        ? openSessions.filter(session => {
            const title = (session.title ?? "").toLowerCase();
            const prompt = (session.turns[0]?.prompt ?? "").toLowerCase();
            const id = session.id.toLowerCase();
            const path = (session.projectPath ?? "").toLowerCase();
            return title.includes(query) || prompt.includes(query) || id.includes(query) || path.includes(query);
          })
        : openSessions;

      if (key.escape) {
        if (pickerSearch) {
          setPickerSearch?.("");
          setPickerIndex(0);
        } else {
          setPickerFocused(false);
        }
      } else if (key.tab) {
        setPickerFocused(false);
      } else if (key.upArrow) {
        if (pickerIndex === 0) setPickerFocused(false);
        else setPickerIndex(value => value - 1);
      } else if (key.downArrow) {
        const maxLen = effectiveSessions.length || 1;
        setPickerIndex(value => (value + 1) % maxLen);
      } else if (key.return) {
        const chosen = effectiveSessions[pickerIndex];
        setPickerFocused(false);
        setPickerSearch?.("");
        if (chosen && missingProjectPaths.includes(chosen.projectPath))
          add("error", `Project folder is missing: ${chosen.projectPath}. Restore it here or run pace reconnect "${chosen.projectPath}" "<new path>" in a terminal, then reopen the conversation picker.`);
        else if (chosen && chosen.id !== activeSessionId.current) void activateSession(chosen);
      } else if (key.backspace || key.delete) {
        setPickerSearch?.(s => s.slice(0, -1));
        setPickerIndex(0);
      } else if (input && !key.ctrl && !key.meta && !key.pageUp && !key.pageDown) {
        setPickerSearch?.(s => s + input);
        setPickerIndex(0);
      }
      return;
    }
    if (approval) {
      if (key.downArrow && focusPicker()) return;
      const pending = activeSessionId.current ? pendingApprovals.current.get(activeSessionId.current) : undefined;
      if (input.toLowerCase() === "y") pending?.respond("accept");
      else if (input.toLowerCase() === "n") pending?.respond("decline");
      else if (key.escape) handleCancelEscape();
      return;
    }
    if (question) {
      if (key.shift && key.tab) focusPicker();
      else if (key.escape) handleCancelEscape();
      return;
    }
    if (input.toLowerCase() === "a" && session?.turns.at(-1)?.intent === "verify_plan" && !jobs.current.has(session.id)) {
      onApplyVerification?.();
      return;
    }
    if (key.escape && !modelMenu && !approvalMenu && !resumeMenu && !convoMenu && !queueMenu && !manualMenu && !pickerFocused) {
      if (handleCancelEscape()) return;
    }
    if (modelMenu) {
      const size = modelMenu === "models" ? menuModels.length : menuEfforts.length;
      if (key.escape) {
        setModelMenu(modelMenu === "efforts" ? "models" : undefined);
        setMenuIndex(0);
      } else if (key.upArrow || key.downArrow || key.tab)
        setMenuIndex((value) => (value + (key.upArrow ? -1 : 1) + size) % size);
      else if (key.return && modelMenu === "models") {
        setMenuModel(menuModels[menuIndex]!);
        setModelMenu("efforts");
        setMenuIndex(0);
      } else if (input === " " || (key.return && modelMenu === "efforts")) {
        if (modelMenu === "models") toggleModel(menuModels[menuIndex]!);
        else toggleEffort(menuEfforts[menuIndex]!);
      } else if (input.toLowerCase() === "m" && modelMenu === "efforts") {
        void selectManualRoute?.(menuEfforts[menuIndex]!);
      }
      return;
    }
    if (approvalMenu) {
      const modes: ApprovalMode[] = ["request-approval", "limited", "full-access"];
      if (key.escape) setApprovalMenu(false);
      else if (key.upArrow || key.downArrow || key.tab)
        setMenuIndex(value => (value + (key.upArrow ? -1 : 1) + modes.length) % modes.length);
      else if (key.return) void selectApprovalMode(modes[menuIndex] ?? modes[0]!);
      return;
    }
    if (manualMenu) {
      const routes = manualOptions ?? manualRoutes ?? [];
      if (key.escape) setManualMenu?.(false);
      else if (key.upArrow || key.downArrow || key.tab)
        setMenuIndex(value => (value + (key.upArrow ? -1 : 1) + routes.length) % routes.length);
      else if (key.return) {
        if (manualOptions) selectManualOption?.(menuIndex);
        else {
          const chosen = (manualRoutes ?? [])[menuIndex];
          if (chosen) void selectManualRoute?.(chosen);
        }
      }
      return;
    }
    if (resumeMenu) {
      if (key.escape) setResumeMenu(false);
      else if (key.upArrow || key.downArrow || key.tab)
        setMenuIndex(
          (value) =>
            (value + (key.upArrow ? -1 : 1) + resumeChoices.length) %
            resumeChoices.length,
        );
      else if (key.return) {
        const chosen = resumeChoices[menuIndex];
        if (chosen && missingProjectPaths.includes(chosen.projectPath))
          add("error", `Project folder is missing: ${chosen.projectPath}. Restore it here or run pace reconnect "${chosen.projectPath}" "<new path>" in a terminal, then reopen the conversation picker.`);
        else if (chosen) void activateSession(chosen);
      }
      return;
    }
    if (convoMenu) {
      const turns = session?.turns ?? [];
      if (key.escape) setConvoMenu(false);
      else if (key.upArrow || key.downArrow || key.tab)
        setMenuIndex(
          (value) =>
            (value + (key.upArrow ? -1 : 1) + Math.max(1, turns.length)) %
            Math.max(1, turns.length),
        );
      else if (key.return) {
        if (!session) return;
        const targetTurn = turns[menuIndex];
        if (!targetTurn) return;
        if (jobs.current.has(session.id) || historyWrite.current || options.historyBusy?.current) { add("info", "Wait for this conversation to finish saving before changing history."); return; }
        const updated = structuredClone(session);
        rewindConversation(updated, menuIndex);
        historyWrite.current = true;
        if (options.historyBusy) options.historyBusy.current = true;
        void store.saveChanges(updated).then(() => {
          Object.assign(session, updated);
          setSession({ ...session });
          renderSessionTurns(session);
          setDraft(targetTurn.prompt);
          setHistory(session.turns.map((t) => t.prompt));
          setConvoMenu(false);
          add("info", `Rewound to turn ${menuIndex + 1}. Prompt loaded into composer.`);
        }).catch(error => add("error", `Could not save history: ${String(error)}`)).finally(() => {
          historyWrite.current = false;
          if (options.historyBusy) options.historyBusy.current = false;
        });
      } else if (key.delete || key.backspace || input === "d") {
        if (!session) return;
        if (jobs.current.has(session.id) || historyWrite.current || options.historyBusy?.current) { add("info", "Wait for this conversation to finish saving before changing history."); return; }
        const updated = structuredClone(session);
        deleteConversationTurn(updated, menuIndex);
        historyWrite.current = true;
        if (options.historyBusy) options.historyBusy.current = true;
        void store.saveChanges(updated).then(() => {
          Object.assign(session, updated);
          setSession({ ...session });
          renderSessionTurns(session);
          setHistory(session.turns.map((t) => t.prompt));
          if (session.turns.length === 0) setConvoMenu(false);
          else setMenuIndex(Math.min(menuIndex, session.turns.length - 1));
          add("info", `Deleted turn ${menuIndex + 1}.`);
        }).catch(error => add("error", `Could not save history: ${String(error)}`)).finally(() => {
          historyWrite.current = false;
          if (options.historyBusy) options.historyBusy.current = false;
        });
      }
      return;
    }
    if (queueMenu && promptQueue && setQueueMenu && setQueueVersion) {
      const sessionId = session?.id ?? activeSessionId.current ?? "";
      const queuedPrompts = promptQueue.current.list(sessionId);
      if (key.escape || !queuedPrompts.length) {
        setQueueMenu(false);
        return;
      }
      if (key.upArrow || key.downArrow || key.tab) {
        setMenuIndex((value) =>
          (value + (key.upArrow ? -1 : 1) + queuedPrompts.length) % queuedPrompts.length,
        );
        return;
      }
      if (!key.ctrl && !key.meta && input.toLowerCase() === "s") {
        options.onQueueSteer?.(sessionId, menuIndex);
        return;
      }
      if (key.rightArrow || key.return) {
        const target = promptQueue.current.remove(sessionId, menuIndex);
        setQueueVersion((v) => v + 1);
        setQueueMenu(false);
        if (target) {
          setDraft(target);
          add("info", `Editing queued message ${menuIndex + 1}. Press Enter to submit.`);
        }
        return;
      }
      if (key.delete || key.backspace || input === "d" || isAltDeleteKey(input, key)) {
        const removed = promptQueue.current.remove(sessionId, menuIndex);
        setQueueVersion((v) => v + 1);
        const remaining = promptQueue.current.list(sessionId);
        if (!remaining.length) {
          setQueueMenu(false);
        } else {
          setMenuIndex(Math.min(menuIndex, remaining.length - 1));
        }
        if (removed) {
          add("info", `Deleted queued message ${menuIndex + 1}.`);
        }
        return;
      }
      return;
    }
    if (key.ctrl && input === "z") {
      if (!jobs.current.has(session?.id ?? "") && session?.turns.length) onUndo?.();
      return;
    }
    if (key.ctrl && input === "y") {
      if (!jobs.current.has(session?.id ?? "") && session?.undoneTurns?.length) onRedo?.();
      return;
    }
    if ((key.ctrl && (input === "p" || input === "\x10")) || (key.meta && (input === "p" || input === "P"))) {
      onTogglePlan?.();
      return;
    }
    if ((key.ctrl && (input === "e" || input === "\x05")) || (key.meta && (input === "e" || input === "E"))) {
      onExecutePlan?.();
      return;
    }
  });
  return cancelArmed;
}
