import type { Session } from "../shared/types.js";
import { formatTurnFooter } from "./turn-format.js";
import type { Line } from "./Transcript.js";

/** Rebuild displayed history from the turns retained in the saved session. */
export function linesFromSession(targetSession: Session, firstId: number, artifactPath: (reference: string) => string): {
  lines: Line[];
  nextId: number;
} {
  const lines: Line[] = [];
  let id = firstId;
  for (const turn of targetSession.turns) {
    lines.push({
      id: id++, role: turn.displayPrompt ? "system" : "you",
      text: turn.displayPrompt ?? turn.prompt, spaceBefore: lines.length > 0,
    });
    for (const action of turn.activities ?? []) lines.push({
      id: id++, role: "activity", text: action.text, spaceBefore: false,
      activity: { category: action.category, detail: action.detail, completed: true,
        outcome: action.outcome, durationMs: action.durationMs, tokens: action.tokens },
    });
    for (const item of turn.questions ?? []) lines.push({
      id: id++, role: "question", text: `${item.question}\nYou: ${item.answer}`, spaceBefore: false,
    });
    lines.push({ id: id++, role: turn.cancelled ? "meta" : turn.failed ? "error" : "codex", text: turn.result, spaceBefore: false });
    if (turn.intent === "verify_plan" && !turn.failed) lines.push({
      id: id++, role: "verify-actions",
      text: "Planner: `/plan <zmiany>` · verifier: użyj `v <wiadomość>`",
      action: "revise-plan",
      spaceBefore: false,
    });
    if (!turn.failed && (turn.stages?.length ?? 1) > 0) lines.push({
      id: id++, role: "meta",
      text: formatTurnFooter(turn.route, turn.routeNote, turn.usage, turn.durationMs, turn.estimatedCostUsd),
      spaceBefore: false,
    });
    for (const artifact of turn.artifacts ?? []) lines.push({
      id: id++, role: "artifact", text: artifactPath(artifact), spaceBefore: false,
    });
    lines.push({ id: id++, role: "divider", text: "", spaceBefore: false });
  }
  if (targetSession.deferredTurn) lines.push({
    id: id++, role: "meta", spaceBefore: false,
    text: `Automatic ${targetSession.deferredTurn.reason ?? "usage"} retry: ${targetSession.deferredTurn.reason === "network" ? "checking connection" : `resuming after ${new Date(targetSession.deferredTurn.retryAt).toLocaleString()}`}. Press Esc to cancel.`,
  });
  return { lines, nextId: id };
}
