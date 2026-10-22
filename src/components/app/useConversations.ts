import { useMemo } from "react";
import type { Session } from "../../shared/types.js";
import { sectionConversations, type ConversationChoice } from "../Menus.js";
import { conversationState } from "../approval-state.js";
import { project } from "./runtime.js";
import type { AppState } from "./useAppState.js";

export function useConversations(state: AppState) {
  const { sessionRecords, setOpenSessions, runningIds, jobs, pendingApprovals, activeSessionId,
    approval, pendingQuestions, question, openSessions, thisPaceIds, pendingRevision } = state;
  const rememberSession = (target: Session) => {
    sessionRecords.current.set(target.id, target);
    setOpenSessions(old => {
      const index = old.findIndex(item => item.id === target.id);
      if (index < 0) return [target, ...old];
      return old.map((item, at) => at === index ? target : item);
    });
  };
  const getSessionState = (sessionId: string): "running" | "approval" | "question" | "done" => {
    return conversationState(
      runningIds.includes(sessionId) || jobs.current.has(sessionId),
      pendingApprovals.current.has(sessionId) || (activeSessionId.current === sessionId && !!approval),
      pendingQuestions.current.has(sessionId) || (activeSessionId.current === sessionId && !!question),
    );
  };
  const sortedSessions = useMemo(() => sectionConversations(
    openSessions.map(item => ({ ...item, state: getSessionState(item.id) })),
    thisPaceIds.current,
    project,
  ), [openSessions, runningIds, approval, question, pendingRevision]);
  const backgroundApprovals = [...pendingApprovals.current.keys()].filter(id => id !== activeSessionId.current);
  const backgroundQuestions = [...pendingQuestions.current.keys()].filter(id => id !== activeSessionId.current);
  const pickerChoices: ConversationChoice[] = sortedSessions.map(item => ({
    id: item.id,
    kind: item.kind,
    projectPath: item.projectPath,
    title: item.title,
    prompt: item.turns[0]?.prompt ?? jobs.current.get(item.id)?.prompt ?? "",
    state: getSessionState(item.id),
    updatedAt: item.updatedAt,
    section: item.section,
    sectionTitle: item.sectionTitle,
    sectionKey: item.sectionKey,
  }));

  return { rememberSession, sortedSessions, backgroundApprovals, backgroundQuestions, pickerChoices };
}
