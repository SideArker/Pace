import { setSteeringHistoryActive } from "./session-model.js";
import type { FileReviewRecord, Session, TurnSummary } from "../shared/types.js";
import { FileEdits, fileTurnActive } from "./file-edits.js";
import { type PaceStore, undoConversationTurn } from "./sessions.js";

function invalidateThread(session: Session) {
  session.threadId = undefined;
  session.threadTurnCount = undefined;
  session.checkpoint = undefined;
  if (session.activeTask) { session.activeTask.assessment = "unknown"; if (session.activeTask.workflow) session.activeTask.workflow.needsAssessment = true; }
  session.deferredTurn = undefined;
  session.updatedAt = new Date().toISOString();
}

/** Save history and file restoration together; compensate if saving history fails. */
async function restoreAndSave(store: PaceStore, session: Session, next: Session, id: string | undefined,
  direction: "undo" | "redo", paths?: string[]): Promise<number> {
  if (fileTurnActive(session.projectPath)) throw new Error("Wait for running turns in this project before changing files.");
  const edits = new FileEdits(store, session);
  const applicable = id && id !== "none";
  const count = applicable ? await edits.restore(id, direction, paths, () => store.saveChanges(next)) : 0;
  if (!applicable) await store.saveChanges(next);
  Object.assign(session, next);
  return count;
}

export async function changeConversationHistory(store: PaceStore, session: Session, direction: "undo" | "redo"):
  Promise<{ turn: TurnSummary; files: number } | undefined> {
  const next = structuredClone(session);
  const turn = direction === "undo" ? undoConversationTurn(next) : next.undoneTurns?.pop();
  if (!turn) return undefined;
  if (direction === "undo") next.undoneTurns = [...(next.undoneTurns ?? []), turn];
  else { next.turns.push(turn); setSteeringHistoryActive(next, [turn], true); }
  invalidateThread(next);
  const files = await restoreAndSave(store, session, next, turn.fileEdits, direction);
  return { turn, files };
}

export async function changeFileHistory(store: PaceStore, session: Session, id: string, direction: "undo" | "redo", path: string): Promise<number> {
  const next = structuredClone(session);
  invalidateThread(next);
  return restoreAndSave(store, session, next, id, direction, [path]);
}

/** Review the complete conversation; restore every contributing snapshot in one transaction. */
export async function reviewFileHistory(store: PaceStore, session: Session,
  decision: "accepted" | "rejected", path?: string): Promise<void> {
  if (fileTurnActive(session.projectPath)) throw new Error("Wait for running turns in this project before changing files.");
  const edits = new FileEdits(store, session);
  const conversation = await edits.conversation(session);
  if (conversation.overlapped) throw new Error("Cannot review workspace changes from overlapping conversations; browsing and comments remain available.");
  const visible = new Set(conversation.changes.filter(edit => !path || edit.path === path)
    .flatMap(edit => edit.previousPath ? [edit.previousPath, edit.path] : [edit.path]));
  const next = structuredClone(session);
  const records: FileReviewRecord[] = [];
  for (const turn of session.turns) {
    const id = turn.fileEdits;
    if (!id || id === "none") continue;
    const files = (await edits.load(id)).changes.filter(edit => visible.has(edit.path) && !edit.undone && session.fileReviews?.[id]?.[edit.path] !== decision);
    if (!files.length) continue;
    const decisions = Object.assign(Object.create(null) as Record<string, "accepted" | "rejected">, next.fileReviews?.[id]);
    (next.fileReviews ??= {})[id] = decisions;
    const previous = files.map(edit => ({ path: edit.path, decision: decisions[edit.path] }));
    const restoredPaths = decision === "rejected" ? files.map(edit => edit.path) : [];
    records.push({ fileEdits: id, previous, restoredPaths });
    for (const edit of files) decisions[edit.path] = decision;
  }
  if (!records.length) return;
  next.lastFileReview = records.length === 1 ? records[0] : { records };
  if (records.some(record => record.restoredPaths.length)) invalidateThread(next);
  await edits.restoreSequence([...records].reverse().filter(record => record.restoredPaths.length)
    .map(record => ({ id: record.fileEdits, direction: "undo", paths: record.restoredPaths })), () => store.saveChanges(next));
  Object.assign(session, next);
}

export async function undoFileReview(store: PaceStore, session: Session): Promise<void> {
  const last = session.lastFileReview;
  if (!last) return;
  const records = "records" in last ? last.records : [last];
  const next = structuredClone(session);
  for (const record of records) {
    const decisions = Object.assign(Object.create(null) as Record<string, "accepted" | "rejected">, next.fileReviews?.[record.fileEdits]);
    (next.fileReviews ??= {})[record.fileEdits] = decisions;
    for (const { path, decision } of record.previous) {
      if (decision) decisions[path] = decision;
      else delete decisions[path];
    }
  }
  next.lastFileReview = undefined;
  if (records.some(record => record.restoredPaths.length)) invalidateThread(next);
  await new FileEdits(store, session).restoreSequence(records.filter(record => record.restoredPaths.length)
    .map(record => ({ id: record.fileEdits, direction: "redo", paths: record.restoredPaths })), () => store.saveChanges(next));
  Object.assign(session, next);
}
