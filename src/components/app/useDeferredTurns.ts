import { useEffect } from "react";
import { networkReachable, transientRetryAt } from "../../core/usage-retry.js";
import type { Session } from "../../shared/types.js";
import type { createTurnRunner } from "../turn-runner.js";
import { store } from "./runtime.js";
import type { AppState } from "./useAppState.js";
import type { createTranscriptActions } from "./transcript-actions.js";
import type { usePromptQueue } from "./usePromptQueue.js";

export function useDeferredTurns({ state, transcript, queue, rememberSession, runTurn }: {
  state: AppState;
  transcript: ReturnType<typeof createTranscriptActions>;
  queue: ReturnType<typeof usePromptQueue>;
  rememberSession: (session: Session) => void;
  runTurn: ReturnType<typeof createTurnRunner>;
}) {
  const { config, openSessions, jobs, latestConfig, activeSessionId, sessionLines, setSession, vexState } = state;
  const { addFor, renderSessionTurns } = transcript;
  const { promptQueue } = queue;
  useEffect(() => {
    if (!config) return;
    let active = true;
    const checking = new Set<string>();
    const check = () => {
      for (const target of openSessions) {
        const pending = target.deferredTurn;
        if (!pending && !jobs.current.has(target.id) && !checking.has(target.id) && !target.turns.at(-1)?.failed &&
          !target.attempts?.some(item => ["running", "awaiting_user"].includes(item.status))) {
          const item = promptQueue.current.peekOperation(target.id);
          if (item) {
            checking.add(target.id);
            void (async () => {
              const full = await store.load(target.projectPath, target.id);
              if (!active || !full || jobs.current.has(target.id) || full.deferredTurn || full.turns.at(-1)?.failed || full.attempts?.some(attempt => ["running", "awaiting_user"].includes(attempt.status))) return;
              await runTurn(item.text, full, latestConfig.current ?? config, item.intent, undefined, false, item);
            })().catch(error => addFor(target.id, "error", `Could not resume queued operation: ${String(error)}`)).finally(() => checking.delete(target.id));
          }
        }
        if (!pending || jobs.current.has(target.id)) continue;
        if (Date.parse(pending.retryAt) > Date.now()) continue;
        if (checking.has(target.id)) continue;
        checking.add(target.id);
        void (async () => {
          const full = await store.load(target.projectPath, target.id);
          if (!active || target.deferredTurn !== pending || jobs.current.has(target.id) || !full?.deferredTurn) return;
          const saved = full.deferredTurn;
          if (Date.parse(saved.retryAt) > Date.now()) return;
          if (saved.reason === "network" && !await networkReachable()) {
            if (!active || target.deferredTurn !== pending || jobs.current.has(target.id)) return;
            saved.retryAt = transientRetryAt("network", saved.attempt).toISOString();
            rememberSession(full);
            if (activeSessionId.current === full.id) setSession({ ...full });
            return;
          }
          if (!active || target.deferredTurn !== pending || jobs.current.has(target.id)) return;
          if (!sessionLines.current.has(full.id)) renderSessionTurns(full);
          addFor(full.id, "meta", saved.reason === "network" ? "Connection restored. Resuming saved request…" : "Retry time reached. Resuming saved request…");
          void runTurn(saved.prompt, full, latestConfig.current ?? config, saved.intent, saved.displayPrompt, true, saved.operation);
        })().catch(error => addFor(target.id, "error", `Could not resume automatic retry: ${String(error)}`))
          .finally(() => checking.delete(target.id));
      }
    };
    check();
    const timer = setInterval(check, 5_000);
    return () => { active = false; clearInterval(timer); };
  }, [config, openSessions, vexState]);
}
