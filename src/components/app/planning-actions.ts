import type { Dispatch, SetStateAction, RefObject } from "react";
import { basename } from "node:path";
import type { Config, Session } from "../../shared/types.js";
import { newSession, type PaceStore } from "../../core/sessions.js";
import { artifactDirectory, artifactPath, savePlanArtifact } from "../../core/system/artifacts.js";
import { preparePlanExecution, operation } from "../../core/operations.js";
import { tryReadPlanFile, verifyPlanPrompt } from "../../core/orchestrator-helpers.js";
import type { PromptQueue } from "../../core/prompt-queue.js";
import type { Progress } from "../../integrations/codex.js";
import type { createTurnRunner, TurnJob } from "../turn-runner.js";
import type { Line } from "../Transcript.js";

type Setter<T> = Dispatch<SetStateAction<T>>;
type PlanningOptions = {
  session: Session | undefined;
  config: Config | undefined;
  store: PaceStore;
  project: string;
  thisPaceIds: RefObject<Set<string>>;
  switchingSession: RefObject<boolean>;
  activeSessionId: RefObject<string | undefined>;
  sessionDrafts: RefObject<Map<string, string>>;
  sessionLines: RefObject<Map<string, Line[]>>;
  runTurnRef: RefObject<ReturnType<typeof createTurnRunner> | undefined>;
  jobs: RefObject<Map<string, TurnJob>>;
  promptQueue: RefObject<PromptQueue>;
  stopSideQuestion: () => void;
  onClear: () => void;
  rememberSession: (session: Session) => void;
  add: (role: Line["role"], text: string) => void;
  setSession: Setter<Session | undefined>;
  setOpenSessions: Setter<Session[]>;
  setShowConversationsTab: Setter<boolean>;
  setLines: Setter<Line[]>;
  setDraft: Setter<string>;
  setHistory: Setter<string[]>;
  setPickerFocused: Setter<boolean>;
  setPickerIndex: Setter<number>;
  setShowHeader: Setter<boolean>;
  setStatus: Setter<string>;
  setApproval: Setter<Extract<Progress, { kind: "approval" }> | undefined>;
  setQueueVersion: Setter<number>;
};

export function createPlanningActions({
  session, config, store, project, thisPaceIds, switchingSession, activeSessionId, sessionDrafts, sessionLines, runTurnRef, jobs, promptQueue, stopSideQuestion, onClear, rememberSession, add, setSession, setOpenSessions, setShowConversationsTab, setLines, setDraft, setHistory, setPickerFocused, setPickerIndex, setShowHeader, setStatus, setApproval, setQueueVersion
}: PlanningOptions) {
  const startOrTogglePlanning = async (promptText?: string) => {
    if (!session) return;
    const planFile = promptText ? tryReadPlanFile(promptText.replace(/^load\s+/i, ""), session.projectPath) : undefined;
    const loadedPlan = planFile?.content;
    const planPath = planFile?.path;
    const planTitle = planPath ? `Plan: ${basename(planPath)}` : undefined;

    if (!session.turns.length && !session.title) {
      const updated: Session = {
        ...session,
        kind: "planning",
        ...(loadedPlan ? { plan: loadedPlan, title: planTitle } : {}),
      };
      try {
        if (loadedPlan) updated.planArtifact = await savePlanArtifact(artifactDirectory(store, updated), updated.id, "imported plan", loadedPlan, updated.planArtifact);
        await store.saveChanges(updated);
        setSession(updated);
        rememberSession(updated);
        if (loadedPlan && planPath) {
          add("info", `◈ Loaded plan from ${basename(planPath)} (${loadedPlan.split("\n").length} lines). Project files remain read-only; use /verify or /execute.`);
          add("codex", `Plan: ${artifactPath(store, updated, updated.planArtifact!)}. Full content is available to /verify and /execute.`);
        } else {
          add("info", "◈ Planning mode active (purple plan). Explore and draft a plan in conversation artifacts.");
          if (promptText && config) void runTurnRef.current?.(promptText, updated, config);
        }
      } catch (error) {
        add("error", `Could not update session mode: ${String(error)}`);
      }
      return;
    }
    const fresh = newSession(project, session.routingMode, "planning", config?.autoLaunchSkills);
    if (loadedPlan) {
      fresh.plan = loadedPlan;
      if (planTitle) fresh.title = planTitle;
    }
    thisPaceIds.current.add(fresh.id);
    switchingSession.current = true;
    const previousId = activeSessionId.current;
    if (previousId) {
      sessionDrafts.current.set(previousId, "");
      session.updatedAt = new Date().toISOString();
      void store.saveChanges(session).catch(() => {});
    }
    activeSessionId.current = fresh.id;
    try {
      if (loadedPlan) fresh.planArtifact = await savePlanArtifact(artifactDirectory(store, fresh), fresh.id, "imported plan", loadedPlan);
      await store.saveChanges(fresh);
      stopSideQuestion();
      onClear();
      sessionLines.current.set(fresh.id, []);
      setSession(fresh);
      setOpenSessions(old => {
        const map = new Map<string, Session>();
        if (session) map.set(session.id, session);
        for (const s of old) map.set(s.id, s);
        map.set(fresh.id, fresh);
        return [...map.values()];
      });
      setShowConversationsTab(true);
      setLines([]);
      setDraft("");
      setHistory([]);
      setPickerFocused(false);
      setPickerIndex(0);
      setShowHeader(true);
      setStatus("Ready");
      setApproval(undefined);
      if (loadedPlan && planPath) {
        add("info", `◈ Started planning session with ${basename(planPath)} (${loadedPlan.split("\n").length} lines). Plan artifacts are writable; use /verify or /execute.`);
        add("codex", `Plan: ${artifactPath(store, fresh, fresh.planArtifact!)}. Full content is available to /verify and /execute.`);
      } else {
        add("info", "◈ Started fresh planning session (purple plan). Explore and draft a plan in conversation artifacts.");
        if (promptText && config) void runTurnRef.current?.(promptText, fresh, config);
      }
    } catch (error) {
      activeSessionId.current = previousId;
      if (previousId) setLines(sessionLines.current.get(previousId) ?? []);
      add("error", `Could not create planning conversation: ${String(error)}`);
    } finally {
      switchingSession.current = false;
    }
  };
  const handleExecutePlan = async (arg?: string) => {
    if (!session || !config) return;
    let execution: Awaited<ReturnType<typeof preparePlanExecution>>;
    try { execution = await preparePlanExecution(store, session, config, arg); }
    catch (error) { add("error", `Could not dispatch plan: ${String(error)}`); return; }
    const fresh = execution.session;
    add("info", "◈ Dispatching latest saved plan to a fresh execution session via Vex...");
    thisPaceIds.current.add(fresh.id);
    switchingSession.current = true;
    const previousId = activeSessionId.current;
    if (previousId) {
      sessionDrafts.current.set(previousId, "");
      session.updatedAt = new Date().toISOString();
      void store.saveChanges(session).catch(() => {});
    }
    activeSessionId.current = fresh.id;
    try {
      await store.saveChanges(fresh);
      stopSideQuestion();
      onClear();
      sessionLines.current.set(fresh.id, []);
      setSession(fresh);
      setOpenSessions(old => {
        const map = new Map<string, Session>();
        if (session) map.set(session.id, session);
        for (const s of old) map.set(s.id, s);
        map.set(fresh.id, fresh);
        return [...map.values()];
      });
      setShowConversationsTab(true);
      setLines([]);
      setDraft("");
      setHistory([]);
      setPickerFocused(false);
      setPickerIndex(0);
      setShowHeader(true);
      setStatus("Starting…");
      setApproval(undefined);
      void runTurnRef.current?.(execution.prompt, fresh, config, "execute_plan", "Executing saved plan in a fresh agent session. The plan details are hidden from this chat.");
    } catch (error) {
      activeSessionId.current = previousId;
      if (previousId) setLines(sessionLines.current.get(previousId) ?? []);
      add("error", `Could not dispatch plan: ${String(error)}`);
    } finally {
      switchingSession.current = false;
    }
  };
  const handleVerifyPlan = async (args?: string) => {
    if (!session) return;
    const trimmed = args?.trim() ?? "";
    const firstSpace = trimmed.search(/\s/);
    const firstToken = firstSpace < 0 ? trimmed : trimmed.slice(0, firstSpace);
    const planFile = firstToken ? tryReadPlanFile(firstToken, session.projectPath) : undefined;
    const reviewPrompt = trimmed && planFile ? trimmed.slice(firstSpace).trim() || undefined : trimmed || undefined;
    const targetPlan = planFile?.content || (session.planArtifact
      ? tryReadPlanFile(artifactPath(store, session, session.planArtifact), session.projectPath)?.content
      : session.plan);
    if (!targetPlan) {
      add("error", "No plan found to verify. Use /verify [file] [prompt], or create a plan with /plan.");
      return;
    }
    if (planFile) {
      add("info", `◈ Loaded plan from ${basename(planFile.path)} for verification.`);
    }
    const goal = session.turns[0]?.prompt;
    session.planRoute ??= { ...session.route };
    add("info", "◈ Verifying plan in read-only mode with a fresh agent. Use /verify <focus> to guide review...");
    if (config) void runTurnRef.current?.(verifyPlanPrompt(targetPlan, goal, reviewPrompt), session, config, "verify_plan");
  };
  const applyVerification = () => {
    if (!session || !config || jobs.current.has(session.id)) return;
    const report = session.turns.at(-1);
    if (!report || report.intent !== "verify_plan" || report.failed) return;
    const prompt = `Apply the following accepted verification findings to the existing implementation plan. Inspect the saved plan and repository. Revise the saved plan artifact in place. Preserve correct content and incorporate only concrete findings below. Do not implement code.\n\nVerification findings:\n${report.result}`;
    add("info", "◈ Sending verification findings to planner for plan revision...");
    void runTurnRef.current?.(prompt, session, config, "revise_plan", "Applying verification findings to the saved plan with the planner.");
  };
  const continueVerifier = (message: string) => {
    if (!session || !config || !session.verifierThreadId || !message.trim()) return;
    const item = { ...operation(message, session.id, session.activeTask?.id), intent: "continue_verify" as const, role: "verifier" as const };
    if (jobs.current.has(session.id)) {
      promptQueue.current.add(session.id, item); setQueueVersion(value => value + 1); return;
    }
    void runTurnRef.current?.(message, session, config, "continue_verify", undefined, false, item);
  };
  return { startOrTogglePlanning, handleExecutePlan, handleVerifyPlan, applyVerification, continueVerifier };
}
