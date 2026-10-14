import type { Session, TurnSummary } from "../shared/types.js";
import { FileEdits, fileTurnActive } from "./file-edits.js";
import { type PaceStore, undoConversationTurn } from "./sessions.js";

function invalidateThread(session: Session) {
  session.threadId = undefined;
  session.threadTurnCount = undefined;
  session.checkpoint = undefined;
  session.activeTask = undefined;
  session.deferredTurn = undefined;
  session.updatedAt = new Date().toISOString();
}

/** Save history and file restoration together; compensate if saving history fails. */
async function restoreAndSave(store: PaceStore, session: Session, next: Session, id: string | undefined,
  direction: "undo" | "redo", paths?: string[]): Promise<number> {
  if (fileTurnActive(session.projectPath)) throw new Error("Wait for running turns in this project before changing files.");
  const edits = new FileEdits(store, session);
  const applicable = id && id !== "none";
  const count = applicable ? await edits.restore(id, direction, paths, () => store.save(next)) : 0;
  if (!applicable) await store.save(next);
  Object.assign(session, next);
  return count;
}

export async function changeConversationHistory(store: PaceStore, session: Session, direction: "undo" | "redo"):
  Promise<{ turn: TurnSummary; files: number } | undefined> {
  const next = structuredClone(session);
  const turn = direction === "undo" ? undoConversationTurn(next) : next.undoneTurns?.pop();
  if (!turn) return undefined;
  if (direction === "undo") next.undoneTurns = [...(next.undoneTurns ?? []), turn];
  else next.turns.push(turn);
  invalidateThread(next);
  const files = await restoreAndSave(store, session, next, turn.fileEdits, direction);
  return { turn, files };
}

export async function changeFileHistory(store: PaceStore, session: Session, id: string, direction: "undo" | "redo", path: string): Promise<number> {
  const next = structuredClone(session);
  invalidateThread(next);
  return restoreAndSave(store, session, next, id, direction, [path]);
}
