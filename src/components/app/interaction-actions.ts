import type { ApprovalDecision, Progress } from "../../integrations/codex.js";
import type { UserAnswers } from "../../integrations/codex-types.js";
import type { PendingApproval, PendingQuestion } from "../turn-runner.js";
import type { createTranscriptActions } from "./transcript-actions.js";
import type { AppState } from "./useAppState.js";
import type { useModelRouting } from "./useModelRouting.js";

type InteractionActionsOptions = {
  state: AppState;
  transcript: ReturnType<typeof createTranscriptActions>;
  routing: ReturnType<typeof useModelRouting>;
};

export function createInteractionActions({ state, transcript, routing }: InteractionActionsOptions) {
  const {
    sessionStatuses,
    activeSessionId,
    pendingApprovals,
    pendingQuestions,
    setStatus,
    setPendingRevision,
    setApproval,
    setQuestion,
    setApprovalMenu,
    setResumeMenu,
    setConvoMenu,
    setQueueMenu,
  } = state;
  const { addFor } = transcript;
  const { setModelMenu } = routing;

  const setStatusFor = (sessionId: string, value: string) => {
    sessionStatuses.current.set(sessionId, value);
    if (activeSessionId.current === sessionId) setStatus(value);
  };
  const showApproval = (
    request: Extract<Progress, { kind: "approval" }>,
    sessionId = activeSessionId.current,
    owner?: AbortController,
  ) => {
    if (!sessionId || pendingApprovals.current.has(sessionId)) {
      request.respond("decline");
      return;
    }
    const pending: PendingApproval = {
      ...request,
      owner,
      respond: (decision: ApprovalDecision) => {
        if (pendingApprovals.current.get(sessionId)?.id !== request.id) return;
        pendingApprovals.current.delete(sessionId);
        setPendingRevision(value => value + 1);
        if (activeSessionId.current === sessionId) setApproval(undefined);
        request.respond(decision);
        addFor(sessionId, "info", decision === "accept" ? "Approved once." : "Declined.");
        setStatusFor(sessionId, decision === "accept" ? "Resuming" : "Stopped command");
      },
    };
    pendingApprovals.current.set(sessionId, pending);
    setPendingRevision(value => value + 1);
    if (activeSessionId.current === sessionId) setApproval(pending);
    setStatusFor(sessionId, "Waiting for approval");
  };
  const showQuestion = (
    request: Extract<Progress, { kind: "question" }>,
    sessionId = activeSessionId.current,
    owner?: AbortController,
  ) => {
    if (!sessionId || pendingQuestions.current.has(sessionId)) {
      request.respond({});
      return;
    }
    const pending: PendingQuestion = {
      ...request,
      owner,
      respond: (answers: UserAnswers) => {
        if (pendingQuestions.current.get(sessionId)?.id !== request.id) return;
        pendingQuestions.current.delete(sessionId);
        setPendingRevision(value => value + 1);
        if (activeSessionId.current === sessionId) setQuestion(undefined);
        request.respond(answers);
        for (const item of request.questions) {
          const answer = answers[item.id]?.answers[0];
          if (answer) addFor(sessionId, "question", `${item.question}\nYou: ${item.isSecret ? "[hidden]" : answer}`);
        }
        setStatusFor(sessionId, Object.keys(answers).length ? "Resuming" : "Question skipped");
      },
    };
    pendingQuestions.current.set(sessionId, pending);
    setPendingRevision(value => value + 1);
    if (activeSessionId.current === sessionId) {
      setModelMenu(undefined);
      setApprovalMenu(false);
      setResumeMenu(false);
      setConvoMenu(false);
      setQueueMenu(false);
      setQuestion(pending);
    }
    setStatusFor(sessionId, "Waiting for answer");
  };
  const dismissQuestion = (id: string, sessionId: string) => {
    if (pendingQuestions.current.get(sessionId)?.id !== id) return;
    pendingQuestions.current.delete(sessionId);
    setPendingRevision(value => value + 1);
    if (activeSessionId.current === sessionId) setQuestion(undefined);
    setStatusFor(sessionId, "Question expired");
  };

  return { setStatusFor, showApproval, showQuestion, dismissQuestion };
}
