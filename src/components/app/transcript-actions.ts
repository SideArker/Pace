import type { Dispatch, RefObject, SetStateAction } from "react";
import type { Progress } from "../../integrations/codex.js";
import type { Session } from "../../shared/types.js";
import type { PaceStore } from "../../core/sessions.js";
import { artifactPath } from "../../core/system/artifacts.js";
import { linesFromSession } from "../session-transcript.js";
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
    const { lines: newLines, nextId: id } = linesFromSession(targetSession, nextId.current, reference => artifactPath(store, targetSession, reference));
    nextId.current = id;
    sessionLines.current.set(targetSession.id, newLines);
    if (activeSessionId.current === targetSession.id) setLines(newLines);
  };
  return { addFor, add, activityFor, activity, recordThoughtUsage, renderSessionTurns };
}
