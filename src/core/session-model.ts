import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { Session, TurnSummary } from "../shared/types.js";

export function normalizeProject(path: string): string {
  const absolute = resolve(path);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}
export function projectKey(path: string): string {
  return createHash("sha256").update(normalizeProject(path)).digest("hex");
}
export function newSession(
  projectPath: string,
  mode: Session["routingMode"],
  kind?: Session["kind"],
  autoLaunchSkills?: readonly string[],
): Session {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    ...(kind ? { kind } : {}),
    projectPath: normalizeProject(projectPath),
    createdAt: now,
    updatedAt: now,
    routingMode: mode,
    route: {},
    activeSkills: [],
    ...(autoLaunchSkills ? { autoLaunchSkills: [...autoLaunchSkills] } : {}),
    skillOptions: {},
    turns: [],
  };
}
export function setSteeringHistoryActive(session: Session, turns: TurnSummary[], active: boolean): void {
  const ids = new Set(turns.flatMap(turn => turn.steeringRecordIds ?? []));
  for (const record of session.steeringRecords ?? []) if (ids.has(record.id)) record.inactive = !active;
  // Retractions are monotonic. Redo restores the turn, but cannot resurrect stale knowledge.
  if (!active) session.memoryRetractedAttempts = [...new Set([...(session.memoryRetractedAttempts ?? []), ...turns.flatMap(turn => [...(turn.memoryAttemptIds ?? []), ...(turn.memoryAttemptId ? [turn.memoryAttemptId] : [])])])];
}
export function rewindConversation(session: Session, index: number): TurnSummary | undefined {
  const turn = session.turns[index];
  if (!turn) return undefined;
  setSteeringHistoryActive(session, session.turns.slice(index), false);
  session.turns = session.turns.slice(0, index);
  session.undoneTurns = undefined;
  session.threadId = undefined;
  session.threadTurnCount = undefined;
  session.checkpoint = undefined;
  if (session.activeTask) { session.activeTask.assessment = "unknown"; if (session.activeTask.workflow) session.activeTask.workflow.needsAssessment = true; }
  session.deferredTurn = undefined;
  return turn;
}
export function deleteConversationTurn(session: Session, index: number): void {
  if (index < 0 || index >= session.turns.length) return;
  setSteeringHistoryActive(session, session.turns.slice(index, index + 1), false);
  session.turns.splice(index, 1);
  session.undoneTurns = undefined;
  session.threadId = undefined;
  session.threadTurnCount = undefined;
  session.checkpoint = undefined;
  if (session.activeTask) { session.activeTask.assessment = "unknown"; if (session.activeTask.workflow) session.activeTask.workflow.needsAssessment = true; }
  session.deferredTurn = undefined;
}
export function undoConversationTurn(session: Session): TurnSummary | undefined {
  const turn = session.turns.pop();
  if (turn) { setSteeringHistoryActive(session, [turn], false); session.threadId = undefined; session.threadTurnCount = undefined; session.checkpoint = undefined; if (session.activeTask) { session.activeTask.assessment = "unknown"; if (session.activeTask.workflow) session.activeTask.workflow.needsAssessment = true; } session.deferredTurn = undefined; }
  return turn;
}

export function retryableTurn(session: Session): TurnSummary | undefined {
  for (let index = session.turns.length - 1; index >= 0; index--) {
    const turn = session.turns[index]!;
    if (!turn.failed || turn.cancelled) continue;
    if (!session.turns.slice(index + 1).some(later => !later.failed && later.prompt === turn.prompt)) return turn;
  }
  return undefined;
}
