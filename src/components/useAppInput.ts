import { useInput } from "ink";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { ApprovalDecision, Progress } from "../integrations/codex.js";
import { EFFORTS } from "../shared/config.js";
import type { Session } from "../shared/types.js";
import { PromptQueue } from "../core/prompt-queue.js";
import { PaceStore, rewindConversation, deleteConversationTurn, undoConversationTurn } from "../core/sessions.js";
import type { Line } from "./Transcript.js";
import type { PendingApproval, TurnJob } from "./turn-runner.js";

export function useAppInput(options: {
  interrupt: () => void;
  pickerFocused: boolean;
  setPickerFocused: Dispatch<SetStateAction<boolean>>;
  pickerIndex: number;
  setPickerIndex: Dispatch<SetStateAction<number>>;
  openSessions: Session[];
  activateSession: (session: Session) => Promise<void>;
  approval: Extract<Progress, { kind: "approval" }> | undefined;
  focusPicker: () => boolean;
  pendingApprovals: MutableRefObject<Map<string, PendingApproval>>;
  activeSessionId: MutableRefObject<string | undefined>;
  jobs: MutableRefObject<Map<string, TurnJob>>;
  sideAbort: MutableRefObject<AbortController | undefined>;
  promptQueue: MutableRefObject<PromptQueue>;
  setQueueVersion: Dispatch<SetStateAction<number>>;
  addFor: (id: string, role: Line["role"], text: string) => void;
  setStatus: (value: string) => void;
  outputsExpanded: boolean;
  setOutputsExpanded: Dispatch<SetStateAction<boolean>>;
  modelMenu: "models" | "efforts" | undefined;
  setModelMenu: Dispatch<SetStateAction<"models" | "efforts" | undefined>>;
  menuModels: string[];
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
  setDraft: Dispatch<SetStateAction<string>>;
  setHistory: Dispatch<SetStateAction<string[]>>;
}) {
  const {
    interrupt, pickerFocused, setPickerFocused, pickerIndex, setPickerIndex,
    openSessions, activateSession, approval, focusPicker, pendingApprovals,
    activeSessionId, jobs, sideAbort, promptQueue, setQueueVersion, addFor,
    setStatus, outputsExpanded, setOutputsExpanded,
    modelMenu, setModelMenu, menuModels, menuIndex,
    setMenuIndex, setMenuModel, toggleModel, toggleEffort, resumeMenu,
    setResumeMenu, resumeChoices, missingProjectPaths, add, convoMenu,
    setConvoMenu, session, store, setSession, renderSessionTurns, setDraft,
    setHistory,
  } = options;
  useInput((input, key) => {
    if (key.ctrl && input === "c") { interrupt(); return; }
    if (pickerFocused) {
      if (key.escape || key.tab) setPickerFocused(false);
      else if (key.upArrow) {
        if (pickerIndex === 0) setPickerFocused(false);
        else setPickerIndex(value => value - 1);
      } else if (key.downArrow) setPickerIndex(value => (value + 1) % openSessions.length);
      else if (key.return) {
        const chosen = openSessions[pickerIndex];
        setPickerFocused(false);
        if (chosen && chosen.id !== activeSessionId.current) void activateSession(chosen);
      }
      return;
    }
    if (approval) {
      if (key.downArrow && focusPicker()) return;
      const pending = activeSessionId.current ? pendingApprovals.current.get(activeSessionId.current) : undefined;
      if (input.toLowerCase() === "y") pending?.respond("accept");
      else if (input.toLowerCase() === "n") pending?.respond("decline");
      else if (key.escape) interrupt();
      return;
    }
    if (key.escape && !modelMenu && !resumeMenu && !convoMenu && !pickerFocused) {
      const job = activeSessionId.current ? jobs.current.get(activeSessionId.current) : undefined;
      if (job || sideAbort.current) {
        if (job && activeSessionId.current) {
          const cleared = promptQueue.current.clear(activeSessionId.current);
          if (cleared) {
            setQueueVersion(value => value + 1);
            addFor(activeSessionId.current, "info", `Cleared ${cleared} queued prompt${cleared === 1 ? "" : "s"}.`);
          }
        }
        job?.controller.abort();
        sideAbort.current?.abort();
        setStatus("Cancelling…");
        return;
      }
    }
    if (key.ctrl && input === "o") setOutputsExpanded(value => !value);
    if (modelMenu) {
      const size = modelMenu === "models" ? menuModels.length : EFFORTS.length;
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
        else toggleEffort(EFFORTS[menuIndex]!);
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
          add("error", `Project folder is missing: ${chosen.projectPath}. Restore it at this path, then reopen /resume.`);
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
        rewindConversation(session, menuIndex);
        session.updatedAt = new Date().toISOString();
        void store.save(session);
        setSession({ ...session });
        renderSessionTurns(session);
        setDraft(targetTurn.prompt);
        setHistory(session.turns.map((t) => t.prompt));
        setConvoMenu(false);
        add("info", `Rewound to turn ${menuIndex + 1}. Prompt loaded into composer.`);
      } else if (key.delete || key.backspace || input === "d") {
        if (!session) return;
        deleteConversationTurn(session, menuIndex);
        session.updatedAt = new Date().toISOString();
        void store.save(session);
        setSession({ ...session });
        renderSessionTurns(session);
        setHistory(session.turns.map((t) => t.prompt));
        if (session.turns.length === 0) setConvoMenu(false);
        else setMenuIndex(Math.min(menuIndex, session.turns.length - 1));
        add("info", `Deleted turn ${menuIndex + 1}.`);
      }
      return;
    }
    if (key.ctrl && input === "z") {
      if (!jobs.current.has(session?.id ?? "") && session?.turns.length) {
        const popped = undoConversationTurn(session)!;
        session.updatedAt = new Date().toISOString();
        void store.save(session);
        setSession({ ...session });
        renderSessionTurns(session);
        setDraft(popped.prompt);
        setHistory(session.turns.map((t) => t.prompt));
        add("info", "Undid last turn. Prompt restored to composer.");
      }
      return;
    }
  });
}
