import { useEffect } from "react";
import { PaceStore, newSession } from "../../core/sessions.js";
import { configuredSkills } from "../../core/system/skills.js";
import { newerPaceVersion } from "../../core/routing/pricing.js";
import { latestNpmVersion } from "../../core/npm-version.js";
import { loadResumeChoices } from "../resume-choices.js";
import { useUsage } from "./useUsage.js";
import { project, installedVersion, vex } from "./runtime.js";
import type { AppState } from "./useAppState.js";
import type { createTranscriptActions } from "./transcript-actions.js";
import type { usePromptQueue } from "./usePromptQueue.js";

export function useAppLifecycle({ state, transcript, queue }: {
  state: AppState;
  transcript: ReturnType<typeof createTranscriptActions>;
  queue: ReturnType<typeof usePromptQueue>;
}) {
  const { runningIds, sideBusy, shellJobs, processes, setTick, remoteHost, pendingApprovals,
    pendingQuestions, jobs, titleAborts, shells, setVexState, setConfig, latestConfig, setSkills,
    sessionRecords, thisPaceIds, activeSessionId, sessionLines, preSessionLines, setSession,
    setOpenSessions, setMissingProjectPaths, setStatus } = state;
  const { add } = transcript;
  const { promptQueue } = queue;
  useEffect(() => {
    let active = true;
    void latestNpmVersion().then(latest => {
      if (active && latest && newerPaceVersion(installedVersion, latest))
        add("meta", `Pace ${latest} is available on npm. Run npm install -g @sidearker/pace to update.`);
    });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!runningIds.length && !sideBusy && shellJobs === 0 && !processes.length) return;
    const timer = setInterval(() => setTick((value) => value + 1), 80);
    return () => clearInterval(timer);
  }, [runningIds.length, sideBusy, shellJobs, processes.length]);
  useEffect(
    () => () => {
      void remoteHost.current?.close();
      for (const pending of pendingApprovals.current.values()) pending.respond("decline");
      for (const pending of pendingQuestions.current.values()) pending.respond({});
      for (const [sessionId, job] of jobs.current) {
        job.controller.abort();
      }
      for (const controller of titleAborts.current.values()) controller.abort();
      for (const child of shells.current) child.kill();
    },
    [],
  );
  useEffect(() => {
    void vex
      .start()
      .then(() => setVexState("connected"))
      .catch((error) => {
        setVexState("failed");
        add(
          "error",
          `Vex MCP connection failed: ${String(error)}. Auto routing is unavailable; manual turns remain available.`,
        );
      });
    return () => {
      void vex.close();
    };
  }, []);
  const { usageLimits, usageError, usageWarning, refreshUsage } = useUsage();
  useEffect(() => {
    if (typeof performance === "undefined") return;
    const clear = () => {
      try {
        if (typeof performance.clearMeasures === "function") performance.clearMeasures();
        if (typeof performance.clearMarks === "function") performance.clearMarks();
      } catch {
        // no-op
      }
    };
    clear();
    const timer = setInterval(clear, 10_000);
    return () => {
      clearInterval(timer);
      clear();
    };
  }, []);
  useEffect(() => {
    let active = true;
    const load = async () => {
      const notices: string[] = [];
      const localStore = new PaceStore(undefined, (message) =>
        notices.push(message),
      );
      const loaded = await localStore.loadConfig();
      if (!active) return;
      setConfig(loaded);
      latestConfig.current = loaded;
      try { setSkills(await configuredSkills(loaded)); }
      catch (error) { add("error", `Could not discover skills: ${String(error)}`); }
      const fresh = newSession(project, loaded.routingMode, undefined, loaded.autoLaunchSkills);
      sessionRecords.current.set(fresh.id, fresh);
      thisPaceIds.current.add(fresh.id);
      activeSessionId.current = fresh.id;
      sessionLines.current.set(fresh.id, preSessionLines.current);
      setSession(fresh);
      const loadedChoices = await loadResumeChoices(localStore, [fresh], []);
      for (const saved of loadedChoices.sessions) promptQueue.current.restore(saved.id, saved.queuedPrompts ?? []);
      setOpenSessions(loadedChoices.sessions);
      setMissingProjectPaths(loadedChoices.missingProjectPaths);
      const waiting = loadedChoices.sessions.filter(item => item.deferredTurn);
      if (waiting.length) add("info", `${waiting.length} saved conversation${waiting.length === 1 ? "" : "s"} waiting for automatic retry. Pace will resume pending requests when ready.`);
      for (const notice of notices) add("error", notice);
      setStatus("Ready");
    };
    void load().catch((error) => {
      add(
        "error",
        `Could not load Pace configuration or sessions: ${String(error)}`,
      );
      setStatus("Storage unavailable; fix configuration and restart Pace");
    });
    return () => {
      active = false;
    };
  }, []);

  return { usageLimits, usageError, usageWarning, refreshUsage };
}
