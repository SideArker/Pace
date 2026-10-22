import { useRef } from "react";
import { PromptQueue } from "../../core/prompt-queue.js";
import { store } from "./runtime.js";
import type { AppState } from "./useAppState.js";
import type { createTranscriptActions } from "./transcript-actions.js";

export function usePromptQueue({ state, transcript }: {
  state: AppState;
  transcript: ReturnType<typeof createTranscriptActions>;
}) {
  const { jobs, sessionRef, sessionRecords, queueSaves, activeSessionId, session, setQueueVersion, setDraft } = state;
  const { addFor, add } = transcript;
  const promptQueue = useRef(new PromptQueue((sessionId, prompts) => {
    const running = jobs.current.get(sessionId)?.session;
    const active = sessionRef.current?.id === sessionId ? sessionRef.current : undefined;
    const remembered = sessionRecords.current.get(sessionId);
    const target = running ?? active ?? remembered;
    if (!target) return;
    const queuedPrompts = [...prompts];
    for (const record of [running, active, remembered]) {
      if (record) record.queuedPrompts = queuedPrompts;
    }
    const previous = queueSaves.current.get(sessionId) ?? Promise.resolve();
    const saving = previous.catch(() => { }).then(async () => {
      await store.update(target, latest => { latest.queuedPrompts = queuedPrompts; }, () => activeSessionId.current === sessionId);
    });
    queueSaves.current.set(sessionId, saving);
    void saving.catch(error => addFor(sessionId, "error", `Could not save queued prompts: ${String(error)}`)).finally(() => {
      if (queueSaves.current.get(sessionId) === saving) queueSaves.current.delete(sessionId);
    });
  }));
  const queued = session ? promptQueue.current.list(session.id) : [];
  const handleQueueEdit = (index = 0): string | undefined => {
    if (!session) return undefined;
    const prompt = promptQueue.current.remove(session.id, index);
    if (!prompt) return undefined;
    setQueueVersion(v => v + 1);
    setDraft(prompt);
    add("info", `Editing queued message: ${prompt.replace(/\s+/g, " ").slice(0, 80)}`);
    return prompt;
  };
  const handleQueueDelete = () => {
    if (!session) return false;
    const popped = promptQueue.current.pop(session.id);
    if (!popped) return false;
    setQueueVersion(v => v + 1);
    add("info", `Removed queued message: ${popped.replace(/\s+/g, " ").slice(0, 80)}`);
    return true;
  };

  return { promptQueue, queued, handleQueueEdit, handleQueueDelete };
}
