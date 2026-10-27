import type { Dispatch, RefObject, SetStateAction } from "react";
import type { Progress } from "../../integrations/codex.js";
import type { Session } from "../../shared/types.js";
import type { PaceStore } from "../../core/sessions.js";
import { artifactPath } from "../../core/system/artifacts.js";
import { formatTurnFooter } from "../turn-format.js";
import { formatCommandActivity } from "../shell-runner.js";
import { updateProcesses, type RunningProcess } from "../RunningProcesses.js";
import type { Line } from "../Transcript.js";

type TranscriptOptions = {
  store: PaceStore;
  nextId: RefObject<number>;
  activeSessionId: RefObject<string | undefined>;
  sessionLines: RefObject<Map<string, Line[]>>;
  preSessionLines: RefObject<Line[]>;
  lastReasoningTokens: RefObject<Map<string, number>>;
  setLines: Dispatch<SetStateAction<Line[]>>;
  setProcesses: Dispatch<SetStateAction<RunningProcess[]>>;
};

export function createTranscriptActions({
  store, nextId, activeSessionId, sessionLines, preSessionLines, lastReasoningTokens, setLines, setProcesses
}: TranscriptOptions) {
  const addFor = (sessionId: string, role: Line["role"], text: string, options?: Pick<Line, "sourceId" | "streaming">) => {
    const old = sessionLines.current.get(sessionId) ?? [];
    const index = options?.sourceId ? old.findIndex(line => line.sourceId === options.sourceId) : -1;
    const updated: Line[] = index >= 0 ? old.map((line, at) => at === index ? { ...line, text, ...options } : line) : [...old, {
      id: nextId.current++, role, text,
      spaceBefore: role === "you" && old.length > 0,
      ...options,
    }];
    sessionLines.current.set(sessionId, updated);
    if (activeSessionId.current === sessionId) setLines(updated);
  };
  const add = (role: Line["role"], text: string) => {
    if (activeSessionId.current) addFor(activeSessionId.current, role, text);
    else {
      const old = preSessionLines.current;
      const updated: Line[] = [...old, { id: nextId.current++, role, text, spaceBefore: role === "you" && old.length > 0 }];
      preSessionLines.current = updated;
      setLines(updated);
    }
  };
  const activityFor = (sessionId: string, event: Extract<Progress, { kind: "activity" }>) => {
    const old = sessionLines.current.get(sessionId) ?? [];
    const sourceId = event.id;
    const previous = old.find(line => line.sourceId === sourceId);
    const startedAt = previous?.activity?.startedAt ?? Date.now();
    const display = event.category === "command" ? formatCommandActivity(event.title, event.detail) : { title: event.title, detail: event.detail };
    if (event.category === "command") setProcesses(old => updateProcesses(old, sessionId, event, Date.now()));
    const update = { text: display.title, activity: {
      category: event.category, detail: display.detail, completed: event.completed,
      outcome: event.outcome ?? (event.completed && /^(?:Failed|Failed to edit):?\b/.test(event.title) ? "failure" : undefined),
      startedAt, durationMs: event.completed ? Date.now() - startedAt : undefined,
      tokens: previous?.activity?.tokens,
    } };
    const index = old.findIndex(line => line.sourceId === sourceId);
    const updated: Line[] = index < 0
      ? [...old, { id: nextId.current++, role: "activity", sourceId, spaceBefore: false, ...update }]
      : old.map((line, at) => at === index ? { ...line, ...update } : line);
    sessionLines.current.set(sessionId, updated);
    if (activeSessionId.current === sessionId) setLines(updated);
  };
  const activity = (event: Extract<Progress, { kind: "activity" }>) => {
    if (activeSessionId.current) activityFor(activeSessionId.current, event);
  };
  const recordThoughtUsage = (sessionId: string, turnId: number, total: number) => {
    const previous = lastReasoningTokens.current.get(sessionId) ?? 0;
    lastReasoningTokens.current.set(sessionId, total);
    const delta = total >= previous ? total - previous : total;
    if (delta < 0) return;
    const old = sessionLines.current.get(sessionId) ?? [];
    let index = old.length - 1;
    while (index >= 0 && !(old[index]?.activity?.category === "thinking" && old[index]?.sourceId?.startsWith(`turn-${turnId}-`))) index--;
    if (index < 0) return;
    const updated = old.map((line, at) => at === index ? {
      ...line, activity: { ...line.activity!, tokens: (line.activity?.tokens ?? 0) + delta },
    } : line);
    sessionLines.current.set(sessionId, updated);
    if (activeSessionId.current === sessionId) setLines(updated);
  };
  const renderSessionTurns = (targetSession: Session) => {
    const newLines: Line[] = [];
    let id = nextId.current;
    for (const turn of targetSession.turns) {
      newLines.push({
        id: id++,
        role: turn.displayPrompt ? "system" : "you",
        text: turn.displayPrompt ?? turn.prompt,
        spaceBefore: newLines.length > 0,
      });
      for (const prompt of turn.steeringPrompts ?? []) newLines.push({
        id: id++, role: "you", text: `Steering: ${prompt}`, spaceBefore: false,
      });
      for (const action of turn.activities ?? []) newLines.push({
        id: id++, role: "activity", text: action.text, spaceBefore: false,
        activity: { category: action.category, detail: action.detail, completed: true,
          outcome: action.outcome, durationMs: action.durationMs, tokens: action.tokens },
      });
      for (const item of turn.questions ?? []) newLines.push({
        id: id++, role: "question", text: `${item.question}\nYou: ${item.answer}`, spaceBefore: false,
      });
      newLines.push({
        id: id++,
        role: turn.cancelled ? "meta" : turn.failed ? "error" : "codex",
        text: turn.result,
        spaceBefore: false,
      });
      if (turn.intent === "verify_plan" && !turn.failed) newLines.push({
        id: id++, role: "verify-actions",
        text: "Planner: `/plan <zmiany>` · verifier: użyj `v <wiadomość>`",
        action: "revise-plan",
        spaceBefore: false,
      });
      if (!turn.failed && (turn.stages?.length ?? 1) > 0) {
        newLines.push({
          id: id++,
          role: "meta",
          text: formatTurnFooter(turn.route, turn.routeNote, turn.usage, turn.durationMs, turn.estimatedCostUsd),
          spaceBefore: false,
        });
      }
      for (const artifact of turn.artifacts ?? []) {
        newLines.push({
          id: id++,
          role: "artifact",
          text: artifactPath(store, targetSession, artifact),
          spaceBefore: false,
        });
      }
      newLines.push({
        id: id++,
        role: "divider",
        text: "",
        spaceBefore: false,
      });
    }
    if (targetSession.deferredTurn) newLines.push({
      id: id++, role: "meta", spaceBefore: false,
      text: `Automatic ${targetSession.deferredTurn.reason ?? "usage"} retry: ${targetSession.deferredTurn.reason === "network" ? "checking connection" : `resuming after ${new Date(targetSession.deferredTurn.retryAt).toLocaleString()}`}. Press Esc to cancel.`,
    });
    nextId.current = id;
    sessionLines.current.set(targetSession.id, newLines);
    if (activeSessionId.current === targetSession.id) setLines(newLines);
  };
  return { addFor, add, activityFor, activity, recordThoughtUsage, renderSessionTurns };
}
