import type { OperationIntent, Session } from "../shared/types.js";
import type { TaskRelation } from "./active-task.js";
import type { RoutingPrompts } from "./routing/routing-prompts.js";
import { retryableTurn } from "./session-model.js";
import { checkpointHandoff } from "./checkpoint.js";
import { retainedConversationPrompt } from "./orchestrator-helpers.js";
import { autoLaunchPrompt, skillPrompt, type Skill } from "./system/skills.js";

export function prepareTurnPrompt({
  prompt, session, intent, userClarification, taskRelation, priorTask,
  usedThreadForClarification, prompts, skills, handoff,
}: {
  prompt: string;
  session: Session;
  intent?: OperationIntent;
  userClarification?: string;
  taskRelation: TaskRelation;
  priorTask: Session["activeTask"];
  usedThreadForClarification: boolean;
  prompts: RoutingPrompts;
  skills: Skill[];
  handoff?: string;
}) {
  const basePrompt = userClarification
    ? `${prompt}\n\nClarification: ${userClarification}`
    : prompt;
  const resumingDeferred = session.deferredTurn?.prompt === prompt && session.deferredTurn?.intent === intent;
  const resumedAfterLimit = resumingDeferred && (!session.deferredTurn?.reason || session.deferredTurn.reason === "usage");
  const retryingFailure = retryableTurn(session)?.prompt === prompt;
  const resolvedPrompt = taskRelation === "continue" && priorTask && !session.threadId
    ? `${basePrompt}\n\nPace's saved task brief (verify against conversation): ${priorTask.originalRequest}\nLater instructions: ${JSON.stringify(priorTask.instructions)}\nLast outcome: ${priorTask.latestOutcome ?? "Unknown"}\n${prompts.execution.savedTaskInstruction}`
    : (taskRelation === "continue" || usedThreadForClarification) && session.threadId && intent !== "verify_plan" && intent !== "revise_plan"
      ? `${basePrompt}\n\n${prompts.execution.existingThreadInstruction}`
      : basePrompt;
  const safePrompt = resumedAfterLimit
    ? `${resolvedPrompt}\n\n${prompts.execution.usageRetryInstruction}`
    : retryingFailure
      ? `${resolvedPrompt}\n\nThis request was interrupted by an error. Inspect current files and prior conversation before editing. Continue only unfinished work. Report completed work, remaining work, and checks.`
      : resolvedPrompt;
  const baseExecutionPrompt = skillPrompt(
    `${safePrompt}\n\n${prompts.execution.coverageInstruction}`,
    skills,
    session.activeSkills,
    session.skillOptions,
  );
  const promptWithHandoff = handoff
    ? `${baseExecutionPrompt}\n\n${prompts.handoff.reportInstruction}\n${handoff}`
    : baseExecutionPrompt;
  return { promptWithHandoff, resumingDeferred };
}

export function prepareRunnerPrompt({
  executionPrompt, session, intent, verifierTurn, planningTurn, skills,
}: {
  executionPrompt: string;
  session: Session;
  intent?: OperationIntent;
  verifierTurn: boolean;
  planningTurn: boolean;
  skills: Skill[];
}) {
  const checkpoint = !verifierTurn && intent !== "revise_plan" && session.checkpoint?.threadId === session.threadId &&
    session.turns.some(turn => turn.at === session.checkpoint?.sourceTurnAt)
    ? session.checkpoint : undefined;
  const runThreadId = intent === "continue_verify" ? session.verifier?.threadId ?? session.verifierThreadId : checkpoint || intent === "verify_plan" ? undefined : session.threadId;
  const checkpointTurn = checkpoint ? session.turns.findIndex(turn => turn.at === checkpoint.sourceTurnAt) : -1;
  const promptWithHistory = checkpoint
    ? checkpointHandoff(checkpoint.note, session.turns.slice(checkpointTurn + 1).filter(turn => !turn.failed).slice(-3).map(turn => ({ user: turn.prompt.slice(0, 1000), assistant: turn.result.slice(0, 1000) })), executionPrompt)
    : retainedConversationPrompt(executionPrompt, intent === "verify_plan" || intent === "revise_plan" ? { ...session, threadId: undefined, turns: [] } : session);
  const selectedAutoSkills = !runThreadId && !verifierTurn && intent !== "revise_plan" && !planningTurn
    ? skills.filter(skill => session.autoLaunchSkills?.includes(skill.name)) : [];
  const runnerPrompt = autoLaunchPrompt(promptWithHistory, selectedAutoSkills);
  return { runnerPrompt, runThreadId, checkpoint };
}
