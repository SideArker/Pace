import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Static, Text, useApp, useStdout } from "ink";
import type { ApprovalDecision, Progress } from "../integrations/codex.js";
import type { UserAnswers } from "../integrations/codex-types.js";
import type { ApprovalMode, Config, ManualWorkflow, Route, Session } from "../shared/types.js";
import { PaceStore, newSession, rewindConversation, deleteConversationTurn, undoConversationTurn, retryableTurn } from "../core/sessions.js";
import { Orchestrator, VexUnavailableError } from "../core/orchestrator.js";
import { PromptQueue } from "../core/prompt-queue.js";
import { AppServerRunner } from "../integrations/codex.js";
import { VexRouter } from "../core/vex/client.js";
import { EFFORTS, withModels } from "../shared/config.js";
import { artifactDirectory, artifactPath, artifactSnapshot, legacyArtifactDirectory, savePlanArtifact } from "../core/system/artifacts.js";
import { existingFolder, sameFolder } from "../core/system/folders.js";
import { configuredSkills, defaultSkillFolder, enabledSkills, skillCommand, skillOption, skillRequest, updateAutoLaunchSkills, validSkillName, type Skill } from "../core/system/skills.js";
import { formatTurnFooter, modelName } from "./turn-format.js";
import { readUsageLimits, usageWarnings } from "../integrations/usage.js";
import { readAvailableModels, type AvailableModel } from "../integrations/models.js";
import type { UsageLimits, UsageWarningLevels } from "../integrations/usage.js";
import { Composer, commandToken } from "./Composer.js";
import { saveClipboardImage } from "./pasted-images.js";
import { ComposerFrame } from "./ComposerFrame.js";
import { WorkingStatus } from "./WorkingStatus.js";
import { QuestionPanel } from "./QuestionPanel.js";
import { BottomPanel } from "./BottomPanel.js";
import { QueuedMessages } from "./QueuedMessages.js";
import { useAppInput } from "./useAppInput.js";

import { Transcript, splitTranscript, type Line } from "./Transcript.js";
import { HeaderLogo, HeaderStatus } from "./Header.js";
import { UsageBar } from "./UsageBar.js";
import { ApprovalModeMenu, CommandMenu, ConversationPicker, ConvoMenu, ManualWorkflowMenu, ModelMenu, QueueMenu, ResumeMenu, sectionConversations, type ConversationChoice } from "./Menus.js";
import { basename, join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { createShellRunner, displayCommand, formatCommandActivity, oneOffShellCommand } from "./shell-runner.js";
import { RunningProcesses, updateProcesses, type RunningProcess } from "./RunningProcesses.js";
import { TaskPanel } from "./TaskPanel.js";
import { conversationState } from "./approval-state.js";
import { taskSummary } from "../core/tasks.js";
import { createTurnRunner, type PendingApproval, type PendingQuestion, type TurnJob } from "./turn-runner.js";
import { costForUsage, currentManifestSource, currentVersionManifest, modelRates, newerPaceVersion, refreshVersionManifest } from "../core/routing/pricing.js";
import { formatLatestRoute } from "./route-format.js";
import { contextPercent, measuredContext } from "../core/context.js";
import { networkReachable, transientRetryAt } from "../core/usage-retry.js";
import { loadResumeChoices } from "./resume-choices.js";
import { executePlanPrompt, tryReadPlanFile, verifyPlanPrompt } from "../core/orchestrator-helpers.js";
export const commands = [
  "/plan",
  "/execute",
  "/verify",
  "/models",
  "/version",
  "/auto",
  "/manual",
  "/workflow",
  "/new",
  "/resume",
  "/convo",
  "/undo",
  "/usage",
  "/retry",
  "/cancelretry",
  "/btw",
  "/artifacts",
  "/trust",
  "/skills",
  "/stats",
  "/route",
  "/approval",
  "/tasks",
  "/compact",
  "/context",
  "/clear",
  "/exit",
];
const hiddenCommands = ["/help", "/run-plan", "/turns"];
export const isRegisteredCommand = (input: string, skillNames: readonly string[] = []): boolean => {
  const command = input.trim().split(/\s+/, 1)[0];
  return commands.includes(command) || hiddenCommands.includes(command) || skillNames.includes(command);
};
const workflowChoices = [
  { shape: "single", label: "Single agent" },
  { shape: "scout", label: "Scout → Completion" },
  { shape: "plan", label: "Plan only" },
  { shape: "scout_plan", label: "Scout → Plan" },
] as const;
type WorkflowShape = ManualWorkflow["shape"];
type WorkflowStage = keyof ManualWorkflow["routes"];
const workflowStages = (shape: WorkflowShape): WorkflowStage[] =>
  shape === "scout" || shape === "scout_plan" ? ["scout", "final"] : ["final"];
export const commandArguments: Record<string, string> = {
  "/plan": "[prompt|file]",
  "/execute": "[file] [prompt]",
  "/verify": "[file]",
  "/manual": "[model] [effort]",
  "/workflow": "[name|auto]",
  "/approval": "[mode]",
  "/skills": "[folder|enable|disable|auto|off]",
  "/btw": "<question>",
};
export const skillArguments = (skillName: string): string => {
  if (skillName === "caveman") return "[mode]";
  return "[request]";
};
const commandDescriptions: Record<string, string> = {
  "/plan": "Start/toggle planning or load plan file (e.g. /plan plan.md)",
  "/execute": "Dispatch plan to fresh session via Vex (e.g. /execute [plan.md])",
  "/verify": "Review plan with a fresh read-only agent (e.g. /verify [plan.md])",
  "/models": "Choose model and reasoning effort",
  "/version": "Show Pace and price catalog versions",
  "/auto": "Let Pace route models automatically",
  "/manual": "Configure workflow stages, models, and effort",
  "/workflow": "Choose workflow strategy (single, scout, plan, scout-plan)",
  "/new": "Start a new conversation",
  "/resume": "Switch to a saved conversation",
  "/convo": "Browse and manage conversation turns",
  "/undo": "Revert latest turn and file changes",
  "/usage": "Show Codex account usage and rate limits",
  "/retry": "Retry the latest failed request in this conversation",
  "/cancelretry": "Cancel automatic retry and clear its queue",
  "/btw": "Ask a side question without adding to context",
  "/artifacts": "Show generated artifacts",
  "/trust": "Manage trusted project folders",
  "/skills": "Discover and manage agent skills",
  "/stats": "Show conversation stats and token costs",
  "/route": "Show routing decisions and stage breakdown",
  "/approval": "Set command approval mode",
  "/tasks": "Show background agent tasks",
  "/compact": "Compact conversation context to save tokens",
  "/context": "Show context window usage breakdown",
  "/clear": "Clear screen and conversation",
  "/exit": "Quit Pace",
};
export const normalizeNewCommand = (input: string) => input.trim().replace(/^(?:\.\/(?!clear(?=\s|$))|\/\.)(new|clear|approval)(?=\s|$)/, "/$1");
const workingTips = [
  "Type / to browse commands",
  "Use /context to check thread size",
  "Use /route to inspect routing decisions",
  "Use /tasks to review current steps",
  "Send another prompt to queue it",
  "Ctrl+O toggles command and reasoning details",
  "Use /models to adjust available routes",
] as const;
const folderArgument = (value: string) => value.trim().replace(/^(?:"(.*)"|'(.*)')$/, (_match, double: string | undefined, single: string | undefined) => double ?? single ?? value);
const project = process.cwd();
const installedVersion = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version as string;
const store = new PaceStore();
const vex = new VexRouter();
const runner = new AppServerRunner();
const orchestrator = new Orchestrator(store, runner, vex);

export default function App({ onClear }: { onClear: () => void }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [terminalDimensions, setTerminalDimensions] = useState(() => ({
    columns: stdout?.columns ?? 80,
    rows: stdout?.rows ?? 24,
  }));
  const lastTerminalDimensions = useRef(terminalDimensions);

  useEffect(() => {
    const stream = stdout ?? process.stdout;
    if (!stream) return;
    const onResize = () => {
      const next = {
        columns: stream.columns ?? 80,
        rows: stream.rows ?? 24,
      };
      if (next.columns === lastTerminalDimensions.current.columns && next.rows === lastTerminalDimensions.current.rows) return;
      lastTerminalDimensions.current = next;
      // Ink has already redrawn using the old layout. Clear that frame before
      // remounting Static at the new width so it cannot remain in scrollback.
      onClear();
      setTranscriptRevision(value => value + 1);
      setTerminalDimensions(next);
    };
    stream.on?.("resize", onResize);
    return () => {
      stream.off?.("resize", onResize);
    };
  }, [stdout]);

  const [config, setConfig] = useState<Config>();
  const [availableModels, setAvailableModels] = useState<AvailableModel[]>([]);
  const [knownModels, setKnownModels] = useState(() => Object.keys(currentVersionManifest().pricing.rates));
  const [modelCatalogStatus, setModelCatalogStatus] = useState<"loading" | "ready" | "unavailable">("loading");
  const modelCatalogRequest = useRef(0);
  const latestConfig = useRef<Config | undefined>(undefined);
  if (config) latestConfig.current = config;
  const [skills, setSkills] = useState<Skill[]>([]);
  const [session, setSession] = useState<Session>();
  const sessionRef = useRef<Session | undefined>(undefined);
  sessionRef.current = session;
  const sessionRecords = useRef(new Map<string, Session>());
  const [openSessions, setOpenSessions] = useState<Session[]>([]);
  const thisPaceIds = useRef(new Set<string>());
  const [pickerFocused, setPickerFocused] = useState(false);
  const [pickerIndex, setPickerIndex] = useState(0);
  const [pickerSearch, setPickerSearch] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [status, setStatus] = useState("Loading…");
  const [runningIds, setRunningIds] = useState<string[]>([]);
  const [sideBusy, setSideBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [outputsExpanded, setOutputsExpanded] = useState(false);
  const [transcriptRevision, setTranscriptRevision] = useState(0);
  const [usageLimits, setUsageLimits] = useState<UsageLimits>();
  const [usageError, setUsageError] = useState<string>();
  const [usageWarning, setUsageWarning] = useState<string>();
  const usageRequestPending = useRef(false);
  const usageWarningLevels = useRef<UsageWarningLevels>({});
  const usageMounted = useRef(false);
  const [showHeader, setShowHeader] = useState(true);
  const [selection, setSelection] = useState(0);
  const [tick, setTick] = useState(0);
  const [shellMode, setShellMode] = useState(false);
  const [shellJobs, setShellJobs] = useState(0);
  const [processes, setProcesses] = useState<RunningProcess[]>([]);
  const [liveUsage, setLiveUsage] = useState<Record<string, string>>({});
  const [approval, setApproval] = useState<Extract<Progress, { kind: "approval" }>>();
  const [question, setQuestion] = useState<PendingQuestion>();
  const [pendingRevision, setPendingRevision] = useState(0);
  const runTurnRef = useRef<((text: string, turnSession: Session, turnConfig: Config, intent?: "verify_plan" | "execute_plan", displayPrompt?: string, automaticRetry?: boolean) => Promise<void>) | undefined>(undefined);
  const [approvalMenu, setApprovalMenu] = useState(false);
  const [vexState, setVexState] = useState<
    "connecting" | "connected" | "failed"
  >("connecting");
  const [modelMenu, setModelMenu] = useState<
    "models" | "efforts" | undefined
  >();
  const [resumeMenu, setResumeMenu] = useState(false);
  const [convoMenu, setConvoMenu] = useState(false);
  const [queueMenu, setQueueMenu] = useState(false);
  const [manualMenu, setManualMenu] = useState(false);
  const [workflowOnly, setWorkflowOnly] = useState(false);
  const [manualWizard, setManualWizard] = useState<{
    step: "workflow" | "model" | "effort";
    shape?: WorkflowShape;
    stageIndex: number;
    model?: string;
    routes: ManualWorkflow["routes"];
  }>({ step: "workflow", stageIndex: 0, routes: {} });
  const [resumeChoices, setResumeChoices] = useState<Session[]>([]);
  const [resumeProcessIds, setResumeProcessIds] = useState<string[]>([]);
  const [missingProjectPaths, setMissingProjectPaths] = useState<string[]>([]);
  const [menuModel, setMenuModel] = useState("");
  const [menuIndex, setMenuIndex] = useState(0);
  const nextId = useRef(0);
  const turnSequence = useRef(0);
  const jobs = useRef(new Map<string, TurnJob>());
  const queueSaves = useRef(new Map<string, Promise<void>>());
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
    const saving = previous.catch(() => {}).then(() => store.save(target, () => activeSessionId.current === sessionId));
    queueSaves.current.set(sessionId, saving);
    void saving.catch(error => addFor(sessionId, "error", `Could not save queued prompts: ${String(error)}`)).finally(() => {
      if (queueSaves.current.get(sessionId) === saving) queueSaves.current.delete(sessionId);
    });
  }));
  const [, setQueueVersion] = useState(0);
  const activeSessionId = useRef<string | undefined>(undefined);
  const sessionLines = useRef(new Map<string, Line[]>());
  const lastReasoningTokens = useRef(new Map<string, number>());
  const sessionDrafts = useRef(new Map<string, string>());
  const preSessionLines = useRef<Line[]>([]);
  const sessionStatuses = useRef(new Map<string, string>());
  const unreadCompletions = useRef(new Set<string>());
  const pendingApprovals = useRef(new Map<string, PendingApproval>());
  const pendingQuestions = useRef(new Map<string, PendingQuestion>());
  const sideAbort = useRef<AbortController | undefined>(undefined);
  const titleAborts = useRef(new Map<string, AbortController>());
  const shells = useRef(new Set<{ kill: () => boolean }>());
  const lastInterruptAt = useRef(0);
  const switchingSession = useRef(false);
  const staticHistory = useRef<{ sessionId?: string; firstId?: number; key: number }>({ key: 0 });
  const busy = !!session && runningIds.includes(session.id);
  const [workingTip, setWorkingTip] = useState<string>();
  useEffect(() => {
    setWorkingTip(undefined);
    if (!busy) return;
    let previous = Math.floor(Math.random() * workingTips.length);
    let interval: ReturnType<typeof setInterval> | undefined;
    const chooseTip = () => {
      const offset = 1 + Math.floor(Math.random() * (workingTips.length - 1));
      previous = (previous + offset + workingTips.length) % workingTips.length;
      setWorkingTip(workingTips[previous]);
    };
    const delay = setTimeout(() => { chooseTip(); interval = setInterval(chooseTip, 15_000); }, 8_000);
    return () => { clearTimeout(delay); if (interval) clearInterval(interval); };
  }, [busy, session?.id]);
  const queued = session ? promptQueue.current.list(session.id) : [];
  const [showConversationsTab, setShowConversationsTab] = useState(false);
  const rememberSession = (target: Session) => {
    sessionRecords.current.set(target.id, target);
    setOpenSessions(old => {
      const index = old.findIndex(item => item.id === target.id);
      if (index < 0) return [target, ...old];
      return old.map((item, at) => at === index ? target : item);
    });
  };
  const getSessionState = (sessionId: string): "running" | "approval" | "question" | "done" => {
    return conversationState(
      runningIds.includes(sessionId) || jobs.current.has(sessionId),
      pendingApprovals.current.has(sessionId) || (activeSessionId.current === sessionId && !!approval),
      pendingQuestions.current.has(sessionId) || (activeSessionId.current === sessionId && !!question),
    );
  };
  const sortedSessions = useMemo(() => sectionConversations(
    openSessions.map(item => ({ ...item, state: getSessionState(item.id) })),
    thisPaceIds.current,
    project,
  ), [openSessions, runningIds, approval, question, pendingRevision]);
  const backgroundApprovals = [...pendingApprovals.current.keys()].filter(id => id !== activeSessionId.current);
  const backgroundQuestions = [...pendingQuestions.current.keys()].filter(id => id !== activeSessionId.current);
  const pickerChoices: ConversationChoice[] = sortedSessions.map(item => ({
    id: item.id,
    kind: item.kind,
    projectPath: item.projectPath,
    title: item.title,
    prompt: item.turns[0]?.prompt ?? jobs.current.get(item.id)?.prompt ?? "",
    state: getSessionState(item.id),
    updatedAt: item.updatedAt,
    section: item.section,
    sectionTitle: item.sectionTitle,
    sectionKey: item.sectionKey,
  }));
  const stopSideQuestion = () => {
    const pending = sideAbort.current;
    sideAbort.current = undefined;
    pending?.abort();
    setSideBusy(false);
  };
  const addFor = (sessionId: string, role: Line["role"], text: string) => {
    const old = sessionLines.current.get(sessionId) ?? [];
    const updated: Line[] = [...old, {
      id: nextId.current++, role, text,
      spaceBefore: role === "you" && old.length > 0,
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
  const setStatusFor = (sessionId: string, value: string) => {
    sessionStatuses.current.set(sessionId, value);
    if (activeSessionId.current === sessionId) setStatus(value);
  };
  const showApproval = (request: Extract<Progress, { kind: "approval" }>, sessionId = activeSessionId.current, owner?: AbortController) => {
    if (!sessionId || pendingApprovals.current.has(sessionId)) {
      request.respond("decline");
      return;
    }
    const pending: PendingApproval = { ...request, owner, respond: (decision: ApprovalDecision) => {
      if (pendingApprovals.current.get(sessionId)?.id !== request.id) return;
      pendingApprovals.current.delete(sessionId);
      setPendingRevision(value => value + 1);
      if (activeSessionId.current === sessionId) setApproval(undefined);
      request.respond(decision);
      addFor(sessionId, "info", decision === "accept" ? "Approved once." : "Declined.");
      setStatusFor(sessionId, decision === "accept" ? "Resuming" : "Stopped command");
    } };
    pendingApprovals.current.set(sessionId, pending);
    setPendingRevision(value => value + 1);
    if (activeSessionId.current === sessionId) setApproval(pending);
    setStatusFor(sessionId, "Waiting for approval");
  };
  const showQuestion = (request: Extract<Progress, { kind: "question" }>, sessionId = activeSessionId.current, owner?: AbortController) => {
    if (!sessionId || pendingQuestions.current.has(sessionId)) { request.respond({}); return; }
    const pending: PendingQuestion = { ...request, owner, respond: (answers: UserAnswers) => {
      if (pendingQuestions.current.get(sessionId)?.id !== request.id) return;
      pendingQuestions.current.delete(sessionId);
      setPendingRevision(value => value + 1);
      if (activeSessionId.current === sessionId) setQuestion(undefined);
      request.respond(answers);
      for (const item of request.questions) {
        const answer = answers[item.id]?.answers[0];
        if (answer) addFor(sessionId, "question", `${item.question}\nYou: ${item.isSecret ? "[hidden]" : answer}`);
      }
      setStatusFor(sessionId, Object.keys(answers).length ? "Resuming" : "Question skipped");
    } };
    pendingQuestions.current.set(sessionId, pending);
    setPendingRevision(value => value + 1);
    if (activeSessionId.current === sessionId) {
      setModelMenu(undefined); setApprovalMenu(false); setResumeMenu(false); setConvoMenu(false); setQueueMenu(false);
      setQuestion(pending);
    }
    setStatusFor(sessionId, "Waiting for answer");
  };
  const dismissQuestion = (id: string, sessionId: string) => {
    if (pendingQuestions.current.get(sessionId)?.id !== id) return;
    pendingQuestions.current.delete(sessionId);
    setPendingRevision(value => value + 1);
    if (activeSessionId.current === sessionId) setQuestion(undefined);
    setStatusFor(sessionId, "Question expired");
  };
  const skillCommands = (config ? enabledSkills(skills, config) : [])
    .flatMap(skill => [`/${skill.name}`, `@${skill.name}`])
    .filter(command => !commands.includes(command));
  const selectableAutoSkills = (config ? enabledSkills(skills, config) : []).filter(skill => validSkillName(skill.name));
  const registeredCommands = [...commands, ...hiddenCommands, ...skillCommands];
  const commandDescriptionsWithSkills = Object.fromEntries([
    ...Object.entries(commandDescriptions),
    ...skills.map(skill => [`/skills auto ${skill.name}`, skill.description]),
    ["/skills auto off", "Clear ON-LAUNCH skills for this and future conversations"],
    ...(config ? enabledSkills(skills, config).flatMap(skill => [
      [`/${skill.name}`, skill.description],
      [`@${skill.name}`, skill.description],
    ] as [string, string][]) : []),
  ]);
  const commandArgsWithSkills: Record<string, string> = {
    ...commandArguments,
    ...(config ? Object.fromEntries(
      enabledSkills(skills, config).flatMap(skill => [
        [`/${skill.name}`, skillArguments(skill.name)],
        [`@${skill.name}`, skillArguments(skill.name)],
      ]),
    ) : {}),
  };
  const autoSkillInput = !shellMode && /^\/skills auto(?:\s+([a-z0-9_-]*))?$/i.exec(draft);
  const token = autoSkillInput ? { start: 0, prefix: draft } : shellMode ? undefined : commandToken(draft);
  const matches = autoSkillInput
    ? [...selectableAutoSkills.map(skill => `/skills auto ${skill.name}`), "/skills auto off"].filter(command => command.startsWith(draft.endsWith(" ") ? draft : `${draft} `) || command === draft)
    : token ? [...commands, ...skillCommands].filter(command => command.startsWith(token.prefix)) : [];
  const selectedAutoSkill = () => {
    const match = matches[selection];
    if (!match || (!skillCommands.includes(match) && !match.startsWith("/skills auto "))) return undefined;
    const name = match.startsWith("/skills auto ") ? match.slice("/skills auto ".length) : match.replace(/^[/@]/, "");
    return selectableAutoSkills.find(skill => skill.name === name);
  };
  const changeAutoLaunch = async (name?: string, toggle = false) => {
    if (!session || !config) return;
    const updatedSession = { ...session };
    const selected = updateAutoLaunchSkills(updatedSession, name, toggle);
    const updatedConfig = { ...latestConfig.current ?? config, autoLaunchSkills: [...selected] };
    try {
      await store.saveConfig(updatedConfig);
      latestConfig.current = updatedConfig;
      setConfig(updatedConfig);
      await store.save(updatedSession);
      rememberSession(updatedSession);
      setSession(updatedSession);
      add("info", selected.length ? `ON-LAUNCH skills: ${selected.join(", ")}.` : "ON-LAUNCH skills cleared.");
    } catch (error) { add("error", `Could not save ON-LAUNCH skills: ${String(error)}`); }
  };
  const refreshUsage = () => {
    if (usageRequestPending.current) return;
    usageRequestPending.current = true;
    void readUsageLimits()
      .then(limits => {
        if (!usageMounted.current) return;
        if (!limits) { setUsageError("Usage unavailable"); return; }
        setUsageLimits(limits);
        setUsageError(undefined);
        const warnings = usageWarnings(limits, usageWarningLevels.current);
        usageWarningLevels.current = warnings.levels;
        if (warnings.messages.length > 0) {
          setUsageWarning(warnings.messages[0]);
        } else if (!warnings.levels["5h"] && !warnings.levels["7d"]) {
          setUsageWarning(undefined);
        }
      })
      .catch(() => { if (usageMounted.current) setUsageError("Usage unavailable"); })
      .finally(() => { usageRequestPending.current = false; });
  };
  const menuModels = [
    ...new Set([
      ...(config?.models.map((model) => model.model) ?? []),
      ...availableModels.map((model) => model.model),
      ...knownModels,
    ]),
  ];
  const menuEfforts = availableModels.find((model) => model.model === menuModel)?.efforts ?? currentVersionManifest().models?.[menuModel]?.efforts ?? EFFORTS;
  const refreshModelCatalog = (forceManifest = false) => {
    const request = ++modelCatalogRequest.current;
    setModelCatalogStatus("loading");
    void refreshVersionManifest(fetch, undefined, forceManifest).then(manifest => {
      if (request === modelCatalogRequest.current) setKnownModels(Object.keys(manifest.pricing.rates));
    });
    void readAvailableModels()
      .then((models) => {
        if (request !== modelCatalogRequest.current) return;
        setAvailableModels(models);
        setModelCatalogStatus("ready");
      })
      .catch(() => {
        if (request === modelCatalogRequest.current) setModelCatalogStatus("unavailable");
      });
  };
  useEffect(() => {
    refreshModelCatalog();
    return () => { modelCatalogRequest.current++; };
  }, []);
  useEffect(() => {
    let active = true;
    void refreshVersionManifest().then(manifest => {
      if (!active) return;
      setKnownModels(Object.keys(manifest.pricing.rates));
      if (newerPaceVersion(installedVersion, manifest.pace.latest))
        add("info", `Pace ${manifest.pace.latest} is available: ${manifest.pace.releaseUrl}`);
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
  useEffect(() => {
    usageMounted.current = true;
    refreshUsage();
    const timer = setInterval(refreshUsage, 30_000);
    return () => {
      usageMounted.current = false;
      clearInterval(timer);
    };
  }, []);
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
  const saveModels = async (models: Config["models"], confirmation: string) => {
    if (!config) return;
    try {
      const updated = withModels(config, models);
      await store.saveConfig(updated);
      setConfig(updated);
      add("info", confirmation);
    } catch (error) {
      add("error", `Could not save models: ${String(error)}`);
    }
  };
  const toggleModel = (name: string) => {
    if (!config) return;
    const found = config.models.find((model) => model.model === name);
    const discovered = availableModels.find((model) => model.model === name) ?? currentVersionManifest().models?.[name];
    const enabled = found?.enabled === false || !found;
    const models = found
      ? config.models.map((model) =>
          model.model === name ? { ...model, enabled } : model,
        )
      : [
          ...config.models,
          {
            model: name,
            efforts: [discovered?.defaultEffort ?? "medium"],
            defaultEffort: discovered?.defaultEffort ?? "medium",
            enabled: true,
          },
        ];
    void saveModels(models, `${name} ${enabled ? "enabled" : "disabled"}.`);
  };
  const toggleEffort = (effort: (typeof EFFORTS)[number]) => {
    if (!config) return;
    const found = config.models.find((model) => model.model === menuModel);
    const present = found?.efforts.includes(effort) ?? false;
    if (present && found?.efforts.length === 1) {
      add(
        "error",
        "Keep at least one reasoning level; disable the model from the model list.",
      );
      return;
    }
    const models = found
      ? config.models.map((model) =>
          model.model === menuModel
            ? {
                ...model,
                efforts: present
                  ? model.efforts.filter((value) => value !== effort)
                  : [...model.efforts, effort],
                defaultEffort:
                  model.defaultEffort === effort && present
                    ? model.efforts.find((value) => value !== effort)
                    : model.defaultEffort,
              }
            : model,
        )
      : [
          ...config.models,
          {
            model: menuModel,
            efforts: [effort],
            defaultEffort: effort,
            enabled: true,
          },
        ];
    void saveModels(
      models,
      `${menuModel}: ${effort} ${present ? "disabled" : "enabled"}.`,
    );
  };
  const selectManualRoute = async (target: Route | (typeof EFFORTS)[number]) => {
    if (typeof target === "string") {
      const effort = target;
      if (!config || !session || !menuModel) return;
      if (jobs.current.has(session.id)) {
        add("error", "Wait for the current turn to finish before changing its manual route.");
        return;
      }
      try {
        const existing = config.models.find((model) => model.model === menuModel);
        const models = existing
          ? config.models.map((model) => model.model === menuModel
            ? { ...model, enabled: true, efforts: model.efforts.includes(effort) ? model.efforts : [...model.efforts, effort] }
            : model)
          : [...config.models, { model: menuModel, efforts: [effort], defaultEffort: effort, enabled: true }];
        const updatedConfig = withModels(config, models);
        await store.saveConfig(updatedConfig);
        const updatedSession = { ...session, routingMode: "manual" as const, route: { model: menuModel, effort }, manualWorkflow: undefined };
        await store.save(updatedSession);
        setConfig(updatedConfig);
        setSession(updatedSession);
        rememberSession(updatedSession);
        setModelMenu(undefined);
        add("info", `Manual route: ${menuModel} ${effort}.${modelRates(menuModel) ? " Use /auto to return to Vex routing." : " This model has no verified auto-routing price; disable it before using /auto."}`);
      } catch (error) {
        add("error", `Could not select model: ${String(error)}`);
      }
      return;
    }
    const route = target;
    setManualMenu(false);
    if (!session) return;
    const updated = { ...session, routingMode: "manual" as const, route, manualWorkflow: undefined };
    try {
      await store.save(updated);
      setSession(updated);
      rememberSession(updated);
      const name =
        route.model?.replace(
          /^gpt-(\d+)-(.+)$/,
          (_match: string, ver: string, n: string) =>
            `GPT-${ver} ${n[0]!.toUpperCase()}${n.slice(1)}`,
        ) ?? route.model ?? "";
      const effort = route.effort
        ? ` ${route.effort[0]!.toUpperCase()}${route.effort.slice(1)}`
        : "";
      add("info", `Manual routing enabled: ${name}${effort}.`);
    } catch (error) {
      add("error", `Could not save manual route: ${String(error)}`);
    }
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
  const activateSession = async (chosen: Session) => {
    if (switchingSession.current) return;
    switchingSession.current = true;
    const previousId = activeSessionId.current;
    let target = jobs.current.get(chosen.id)?.session ?? chosen;
    if (previousId) sessionDrafts.current.set(previousId, draft);
    activeSessionId.current = target.id;
    try {
      if (!thisPaceIds.current.has(target.id) && !jobs.current.has(target.id)) {
        const full = await store.load(target.projectPath, target.id);
        if (full) target = full;
      }
      promptQueue.current.restore(target.id, target.queuedPrompts ?? []);
      sessionRecords.current.set(target.id, target);
      thisPaceIds.current.add(target.id);
      await store.activate(target);
      stopSideQuestion();
      onClear();
      setSession(target);
      unreadCompletions.current.delete(target.id);
      rememberSession(target);
      setResumeMenu(false);
      setConvoMenu(false);
      setPickerFocused(false);
      const targetIndex = sortedSessions.findIndex(item => item.id === target.id);
      setPickerIndex(targetIndex < 0 ? 0 : targetIndex);
      setDraft(sessionDrafts.current.get(target.id) ?? "");
      setShowHeader(true);
      if (sessionLines.current.has(target.id)) setLines(sessionLines.current.get(target.id)!);
      else renderSessionTurns(target);
      setApproval(pendingApprovals.current.get(target.id));
      setQuestion(pendingQuestions.current.get(target.id));
      setHistory(target.turns.map(t => t.prompt));
      setStatus(sessionStatuses.current.get(target.id) ?? (target.deferredTurn ? "Waiting for automatic retry" : "Ready"));
    } catch (error) {
      activeSessionId.current = previousId;
      if (previousId) setLines(sessionLines.current.get(previousId) ?? []);
      add("error", `Could not activate conversation: ${String(error)}`);
    } finally {
      switchingSession.current = false;
    }
  };
  const cancelRetry = async () => {
    const target = session;
    if (!target?.deferredTurn || jobs.current.has(target.id)) return;
    target.deferredTurn = undefined;
    const removed = promptQueue.current.clear(target.id);
    setQueueVersion(value => value + 1);
    setSession({ ...target });
    rememberSession(target);
    setStatusFor(target.id, "Ready");
    addFor(target.id, "info", `Automatic retry cancelled${removed ? `; ${removed} queued prompt${removed === 1 ? "" : "s"} cleared` : ""}.`);
    try { await store.save(target); }
    catch (error) { addFor(target.id, "error", `Could not save retry cancellation: ${String(error)}`); }
  };
  const interrupt = () => {
    const now = Date.now();
    if (now - lastInterruptAt.current < 150) return;
    lastInterruptAt.current = now;
    const id = activeSessionId.current;
    const pending = id ? pendingApprovals.current.get(id) : undefined;
    pending?.respond("decline");
    const pendingQuestion = id ? pendingQuestions.current.get(id) : undefined;
    pendingQuestion?.respond({});
    const job = id ? jobs.current.get(id) : undefined;
    if (job || sideAbort.current) {
      if (id && job) {
        const cleared = promptQueue.current.clear(id);
        if (cleared) {
          setQueueVersion(value => value + 1);
          addFor(id, "info", `Cleared ${cleared} queued prompt${cleared === 1 ? "" : "s"}.`);
        }
      }
      job?.controller.abort();
      sideAbort.current?.abort();
      if (id) setStatusFor(id, "Cancelling…");
    } else if (session?.deferredTurn) {
      void cancelRetry();
    } else if (jobs.current.size) {
      add("info", `${jobs.current.size} background turn(s) running. Use /resume to switch or /exit to quit.`);
    } else exit();
  };
  const interruptRef = useRef(interrupt);
  interruptRef.current = interrupt;
  useEffect(() => {
    const onSignal = () => interruptRef.current();
    process.on("SIGINT", onSignal);
    return () => { process.off("SIGINT", onSignal); };
  }, []);
  const enabledModels = (config?.models ?? []).filter((m) => m.enabled !== false);
  const manualRoutes: Route[] = enabledModels.flatMap((m) =>
    m.efforts.map((e) => ({ model: m.model, effort: e })),
  );
  const availableWorkflows = workflowChoices.filter(choice =>
    !["scout", "scout_plan"].includes(choice.shape) || enabledModels.some(model => model.model === "gpt-6-luna"));
  const manualStage = manualWizard.shape ? workflowStages(manualWizard.shape)[manualWizard.stageIndex] : undefined;
  const manualOptions = manualWizard.step === "workflow"
    ? ["Delegate choice to Vex", ...availableWorkflows.map(choice => choice.label)]
    : manualWizard.step === "model"
      ? ["Delegate choice to Vex", ...(manualStage === "scout" ? enabledModels.filter(m => m.model === "gpt-6-luna") : enabledModels).map(m => m.model)]
      : ["Delegate choice to Vex", ...(enabledModels.find(m => m.model === manualWizard.model)?.efforts ?? [])];
  const saveWorkflow = async (shape: WorkflowShape, routes: ManualWorkflow["routes"]) => {
    if (!session) return;
    const updated = { ...session, routingMode: "manual" as const, manualWorkflow: { shape, routes } };
    try {
      await store.save(updated);
      setSession(updated);
      rememberSession(updated);
      setManualMenu(false);
      add("info", `Manual ${shape} workflow saved. Send the task as your next message.`);
    } catch (error) { add("error", `Could not save workflow: ${String(error)}`); }
  };
  const finishManualStage = async (selection: Route | "vex") => {
    if (!session || !manualWizard.shape || !manualStage) return;
    const routes = { ...manualWizard.routes, [manualStage]: selection };
    const nextIndex = manualWizard.stageIndex + 1;
    if (nextIndex < workflowStages(manualWizard.shape).length) {
      setManualWizard({ ...manualWizard, step: "model", stageIndex: nextIndex, model: undefined, routes });
      setMenuIndex(0);
      return;
    }
    await saveWorkflow(manualWizard.shape, routes);
  };
  const selectManualOption = (index: number) => {
    if (manualWizard.step === "workflow") {
      if (index === 0) {
        if (!session) return;
        const updated = { ...session, routingMode: "auto" as const, manualWorkflow: undefined };
        void store.save(updated).then(() => {
          setSession(updated); rememberSession(updated); setManualMenu(false);
          add("info", "Workflow choice delegated to Vex.");
        }).catch(error => add("error", `Could not save routing mode: ${String(error)}`));
        return;
      }
      const shape = availableWorkflows[index - 1]?.shape;
      if (!shape) return;
      if (workflowOnly) {
        void saveWorkflow(shape, Object.fromEntries(workflowStages(shape).map(stage => [stage, "vex"])));
        return;
      }
      setManualWizard({ step: "model", shape, stageIndex: 0, routes: {} });
    } else if (manualWizard.step === "model") {
      if (index === 0) { void finishManualStage("vex"); return; }
      const model = manualOptions[index];
      if (!model) return;
      setManualWizard({ ...manualWizard, step: "effort", model });
    } else {
      if (!manualWizard.model) return;
      const effort = manualOptions[index];
      void finishManualStage(index === 0 ? { model: manualWizard.model } : { model: manualWizard.model, effort: effort as Route["effort"] });
    }
    setMenuIndex(0);
  };
  const focusPicker = () => {
    if (sortedSessions.length < 2 || modelMenu || convoMenu || queueMenu || approvalMenu || manualMenu) return false;
    const pendingIndex = sortedSessions.findIndex(item => item.id !== activeSessionId.current && (pendingApprovals.current.has(item.id) || pendingQuestions.current.has(item.id)));
    const current = sortedSessions.findIndex(item => item.id === activeSessionId.current);
    setPickerIndex(pendingIndex >= 0 ? pendingIndex : current >= 0 ? (current + 1) % sortedSessions.length : 0);
    setPickerFocused(true);
    return true;
  };
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
        await store.save(updated);
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
      void store.save(session).catch(() => {});
    }
    activeSessionId.current = fresh.id;
    try {
      if (loadedPlan) fresh.planArtifact = await savePlanArtifact(artifactDirectory(store, fresh), fresh.id, "imported plan", loadedPlan);
      await store.save(fresh);
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
    if (!session) return;
    let targetPlan = session.planArtifact
      ? tryReadPlanFile(artifactPath(store, session, session.planArtifact), session.projectPath)?.content
      : session.plan;
    let extraPrompt: string | undefined;
    let loadedFromPath: string | undefined;

    if (arg) {
      const trimmed = arg.trim();
      const wholeFile = tryReadPlanFile(trimmed, session.projectPath);
      const parts = trimmed.split(/\s+/);
      const firstFile = !wholeFile && parts.length > 1 ? tryReadPlanFile(parts[0]!, session.projectPath) : undefined;
      if (wholeFile) {
        targetPlan = wholeFile.content;
        loadedFromPath = wholeFile.path;
      } else if (firstFile) {
        targetPlan = firstFile.content;
        loadedFromPath = firstFile.path;
        extraPrompt = parts.slice(1).join(" ").trim();
      } else {
        extraPrompt = trimmed;
      }
    }

    if (!targetPlan) {
      add("error", "No plan found to execute. Provide a plan file (e.g. /execute plan.md) or create one with /plan.");
      return;
    }

    if (loadedFromPath) {
      add("info", `◈ Loaded plan from ${basename(loadedFromPath)} (${targetPlan.split("\n").length} lines).`);
    }
    add("info", "◈ Dispatching plan to fresh execution session via Vex (Explore → Implement)...");
    const fresh = newSession(project, "auto", "normal", config?.autoLaunchSkills);
    fresh.title = loadedFromPath
      ? `Exec: ${basename(loadedFromPath)}`
      : session.title ? `Exec: ${session.title.replace(/^Exec:\s*/i, "")}` : "Plan Execution";
    thisPaceIds.current.add(fresh.id);
    switchingSession.current = true;
    const previousId = activeSessionId.current;
    if (previousId) {
      sessionDrafts.current.set(previousId, "");
      session.updatedAt = new Date().toISOString();
      void store.save(session).catch(() => {});
    }
    activeSessionId.current = fresh.id;
    try {
      await store.save(fresh);
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
      const prompt = extraPrompt
        ? `${executePlanPrompt(targetPlan)}\n\nAdditional user instructions:\n${extraPrompt}`
        : executePlanPrompt(targetPlan);
      if (config) void runTurnRef.current?.(prompt, fresh, config, "execute_plan", "Executing saved plan in a fresh agent session. The plan details are hidden from this chat.");
    } catch (error) {
      activeSessionId.current = previousId;
      if (previousId) setLines(sessionLines.current.get(previousId) ?? []);
      add("error", `Could not dispatch plan: ${String(error)}`);
    } finally {
      switchingSession.current = false;
    }
  };
  const handleVerifyPlan = async (arg?: string) => {
    if (!session) return;
    const planFile = arg ? tryReadPlanFile(arg, session.projectPath) : undefined;
    const targetPlan = planFile?.content || (session.planArtifact
      ? tryReadPlanFile(artifactPath(store, session, session.planArtifact), session.projectPath)?.content
      : session.plan);
    if (!targetPlan) {
      add("error", "No plan found to verify. Provide a plan file (e.g. /verify plan.md) or create one with /plan.");
      return;
    }
    if (planFile) {
      add("info", `◈ Loaded plan from ${basename(planFile.path)} for verification.`);
    }
    const goal = session.turns[0]?.prompt;
    add("info", "◈ Verifying plan in read-only mode with a fresh agent...");
    if (config) void runTurnRef.current?.(verifyPlanPrompt(targetPlan, goal), session, config, "verify_plan");
  };
  const cancelArmed = useAppInput({
    interrupt, cancelRetry, pickerFocused, setPickerFocused, pickerIndex, setPickerIndex,
    pickerSearch, setPickerSearch,
    openSessions: sortedSessions, activateSession, approval, question, focusPicker, pendingApprovals,
    activeSessionId, jobs, sideAbort, outputsExpanded, setOutputsExpanded,
    redrawTranscript: () => { onClear(); setTranscriptRevision(value => value + 1); },
    modelMenu, setModelMenu, menuModels, menuEfforts,
    approvalMenu, setApprovalMenu, selectApprovalMode: async (mode: ApprovalMode) => {
      try {
        const updated = { ...latestConfig.current!, approvalMode: mode };
        await store.saveConfig(updated);
        setConfig(updated);
        latestConfig.current = updated;
        setApprovalMenu(false);
        add("info", `Approval mode: ${mode}. Active turns keep their starting mode.`);
      } catch (error) { add("error", `Could not save approval mode: ${String(error)}`); }
    },
    manualMenu, setManualMenu, manualRoutes, selectManualRoute, manualOptions, selectManualOption,
    menuIndex, setMenuIndex, setMenuModel, toggleModel, toggleEffort,
    resumeMenu, setResumeMenu, resumeChoices, missingProjectPaths, add,
    convoMenu, setConvoMenu, session, store, setSession, renderSessionTurns,
    draft, setDraft, setHistory, queueMenu, setQueueMenu, promptQueue, setQueueVersion,
    onTogglePlan: () => { void startOrTogglePlanning(); },
    onExecutePlan: () => { void handleExecutePlan(); },
  });
  const focusQueuedOrPicker = () => {
    if (queued.length && !modelMenu && !convoMenu && !queueMenu && !approvalMenu && !manualMenu) {
      setQueueMenu(true);
      setMenuIndex(0);
      return true;
    }
    return focusPicker();
  };
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
  const shell = createShellRunner({
    project: session?.projectPath ?? project,
    nextId,
    shells,
    setShellJobs,
    approvalMode: config?.approvalMode ?? "request-approval",
    activity,
    add,
    requestApproval: (command, reason) => new Promise(resolveDecision => {
      showApproval({
        kind: "approval",
        id: `shell-approval-${nextId.current++}`,
        command,
        cwd: session?.projectPath ?? project,
        reason: config?.approvalMode === "limited" ? "Limited mode asks before each Bash command." : reason,
        respond: decision => resolveDecision(decision === "accept"),
      });
    }),
  });
  const askBtw = async (question: string) => {
    if (!session || !config) return;
    if (!question.trim()) { add("error", "Type /btw <question> to ask a side question."); return; }
    if (sideBusy) { add("info", "A side question is already running."); return; }
    const activeJob = jobs.current.get(session.id);
    const activePrompt = activeJob?.prompt;
    const history = session.turns
      .filter(turn => !turn.failed)
      .map(turn => `User: ${turn.prompt}\nPace: ${turn.result}`)
      .join("\n\n");
    const liveLines = (sessionLines.current.get(session.id) ?? [])
      .filter(line => line.role !== "you" || line.text !== `/btw ${question}`)
      .slice(-24)
      .map(line => {
        const speaker = line.role === "codex" ? "Pace" : line.role === "you" ? "User" : line.role === "activity" ? "Agent activity" : line.role === "system" ? "System" : line.role;
        const detail = line.activity?.detail ? ` (${line.activity.detail})` : "";
        return `${speaker}: ${line.text}${detail}`;
      })
      .join("\n");
    const tasks = (activeJob?.session.tasks ?? session.tasks ?? [])
      .map(task => `${task.completed ? "[x]" : "[ ]"} ${task.text}`)
      .join("\n");
    const context = [
      history ? `Retained conversation:\n${history}` : "",
      activePrompt ? `Current user request (still in progress):\n${activePrompt}` : "",
      tasks ? `Current agent task plan:\n${tasks}` : "",
      liveLines ? `Recent live transcript and progress:\n${liveLines}` : "",
    ].filter(Boolean).join("\n\n");
    const luna = config.models.find(model => model.enabled !== false && model.model === "gpt-6-luna");
    const route = luna ? { model: luna.model, effort: luna.efforts.includes("low") ? "low" as const : luna.defaultEffort ?? luna.efforts[0] } : session.route.model ? session.route : config.defaultRoute;
    const controller = new AbortController();
    const sideId = ++turnSequence.current;
    sideAbort.current = controller;
    setSideBusy(true);
    add("you", `/btw ${question}`);
    try {
      const prompt = `Answer the user's side question directly using the conversation context below. Start with the requested format (for example, yes or no when asked a yes/no question), then give only the explanation needed. Treat current progress as evidence about what has happened so far, and be clear if a task is still in progress. Do not edit files or take action. This is separate from the main conversation.\n\nConversation context:\n${context || "(No previous turns)"}\n\nUser's side question (answer this exact question):\n${question}`;
      const result = await runner.run(prompt, session.projectPath, route, undefined, progress => {
        if (sideAbort.current !== controller) return;
        if (progress.kind === "activity") activity({ ...progress, id: `side-${sideId}-${progress.id}` });
        if (progress.kind === "error") add("error", progress.text);
      }, controller.signal, "side");
      if (sideAbort.current === controller) add("side", result.result);
    } catch (error) {
      if (controller.signal.aborted) {
        add("meta", "Side question cancelled");
      } else if (sideAbort.current === controller) {
        add("error", `Side question failed: ${String(error)}`);
      }
    } finally {
      if (sideAbort.current === controller) { sideAbort.current = undefined; setSideBusy(false); }
    }
  };

  const submit = async (raw: string) => {
    if (switchingSession.current) return;
    const text = shellMode ? raw.trim() : normalizeNewCommand(raw);
    if (!text || !session || !config) return;
    setHistory(old => [...old.slice(-99), raw]);
    if (text === "!") {
      add("info", shellMode ? "$ !" : "> !");
      setShellMode((value) => !value);
      setDraft("");
      add(
        "info",
        shellMode
          ? "Bash mode off."
          : "Bash mode on. Type ! to return to Pace.",
      );
      return;
    }
    const shellCommand = oneOffShellCommand(text);
    if (shellCommand !== undefined) {
      setDraft("");
      shell(shellCommand);
      return;
    }
    if (shellMode) {
      setDraft("");
      shell(text);
      return;
    }
    if (text === "/btw" || text.startsWith("/btw ")) {
      setDraft("");
      void askBtw(text.slice(4).trim());
      return;
    }
    if (jobs.current.has(session.id) && !/^\/(?:new|clear|resume|help|exit|usage|stats|compact|context|route|artifacts|models|trust|skills|approval|tasks)(?:\s|$)/.test(text)) {
      if (isRegisteredCommand(text, registeredCommands) && !skillCommand(text, enabledSkills(skills, config))) {
        add("info", "This conversation is working. Use /new or /resume to switch conversations.");
        return;
      }
      const position = promptQueue.current.add(session.id, text);
      setQueueVersion(value => value + 1);
      setDraft("");
      add("info", `Queued prompt ${position}: ${text.replace(/\s+/g, " ").slice(0, 100)}`);
      return;
    }
    setDraft("");
    setSelection(0);
    if (text.startsWith("/") && isRegisteredCommand(text, registeredCommands)) {
      const [command, ...parts] = text.split(/\s+/);
      if (command === "/clear" || command === "/new") {
        if (parts.length) {
          add("error", `Type ${command} without arguments.`);
          return;
        }
        const fresh = newSession(project, session.routingMode, undefined, config.autoLaunchSkills);
        thisPaceIds.current.add(fresh.id);
        if (session.routingMode === "manual") { fresh.route = session.route; fresh.manualWorkflow = session.manualWorkflow; }
        switchingSession.current = true;
        const previousId = activeSessionId.current;
        if (previousId) {
          sessionDrafts.current.set(previousId, "");
          if (session) {
            session.updatedAt = new Date().toISOString();
            void store.save(session).catch(() => {});
          }
        }
        activeSessionId.current = fresh.id;
        try {
          await store.save(fresh);
          stopSideQuestion();
          onClear();
          activeSessionId.current = fresh.id;
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
        } catch (error) {
          activeSessionId.current = previousId;
          if (previousId) setLines(sessionLines.current.get(previousId) ?? []);
          add("error", `Could not create conversation: ${String(error)}`);
        } finally {
          switchingSession.current = false;
        }
        return;
      }
      if (command === "/plan") {
        const promptText = parts.join(" ").trim();
        await startOrTogglePlanning(promptText || undefined);
        return;
      }
      if (command === "/execute" || command === "/run-plan") {
        const extraPrompt = parts.join(" ").trim();
        await handleExecutePlan(extraPrompt || undefined);
        return;
      }
      if (command === "/verify") {
        const arg = parts.join(" ").trim();
        await handleVerifyPlan(arg || undefined);
        return;
      }
      if (command === "/exit") {
        exit();
        return;
      }
      if (command === "/help") {
        add(
          "info",
          "/plan [prompt] · /execute · /verify · /models · /auto · /manual [model] [effort] · /workflow [name|auto] · /approval [full-access|request-approval|limited] · /tasks · /new · /resume · /convo · /undo · /compact · /context · /usage · /retry · /cancelretry · /btw <q> · /artifacts · /trust · /skills [folder|default|off|enable <name>|disable <name>] · /<skill> [request] · /stats · /route · /clear · /exit · Esc cancels automatic retry; Esc twice/Ctrl+C cancels other turns · Ctrl+Z undo · Alt+P/Ctrl+P plan · Alt+E/Ctrl+E execute · ! Bash · Ctrl+O toggle command, diff, and reasoning details · Shift/Ctrl/Alt+Enter or Ctrl+J newline · ↑/↓ history",
        );
        add("info", "With multiple open conversations, press Down from the input to focus the picker. Use arrows and Enter to switch; Esc returns to input. Ctrl+C cancels the selected turn. /exit quits.");
        return;
      }
      if (command === "/auto") {
        // Auto selection uses the enabled model list in the orchestrator.
        const updated = { ...session, routingMode: "auto" as const, manualWorkflow: undefined };
        try {
          await store.save(updated);
          setSession(updated);
          rememberSession(updated);
          add("info", "Auto routing enabled for the next turn.");
        } catch (error) {
          add("error", `Could not save routing mode: ${String(error)}`);
        }
        return;
      }
      if (command === "/workflow") {
        if (parts.length > 1) { add("error", "Type /workflow [name|auto]."); return; }
        if (!enabledModels.length) { add("error", "No models enabled. Open /models and enable one first."); return; }
        if (!parts.length) {
          setWorkflowOnly(true);
          setManualWizard({ step: "workflow", stageIndex: 0, routes: {} });
          setManualMenu(true);
          setMenuIndex(0);
          return;
        }
        const requested = parts[0]!.toLowerCase().replaceAll("-", "_");
        if (requested === "auto" || requested === "vex") {
          const updated = { ...session, routingMode: "auto" as const, manualWorkflow: undefined };
          try {
            await store.save(updated); setSession(updated); rememberSession(updated);
            add("info", "Workflow choice delegated to Vex.");
          } catch (error) { add("error", `Could not save routing mode: ${String(error)}`); }
          return;
        }
        const choice = availableWorkflows.find(item => item.shape === requested);
        if (!choice) {
          add("error", `Unknown or unavailable workflow '${parts[0]}'. Available: ${availableWorkflows.map(item => item.shape).join(", ")}.`);
          return;
        }
        await saveWorkflow(choice.shape, Object.fromEntries(workflowStages(choice.shape).map(stage => [stage, "vex"])));
        return;
      }
      if (command === "/manual") {
        const enabled = (config?.models ?? []).filter((m) => m.enabled !== false);
        if (!enabled.length) {
          add("error", "No models enabled. Open /models and enable one first.");
          return;
        }
        if (!parts.length) {
          setWorkflowOnly(false);
          setManualWizard({ step: "workflow", stageIndex: 0, routes: {} });
          setManualMenu(true);
          setMenuIndex(0);
          return;
        }
        if (parts[0] === "off" || parts[0] === "auto") {
          const updated = { ...session, routingMode: "auto" as const, manualWorkflow: undefined };
          try {
            await store.save(updated);
            setSession(updated);
            rememberSession(updated);
            add("info", "Auto routing enabled for the next turn.");
          } catch (error) {
            add("error", `Could not save routing mode: ${String(error)}`);
          }
          return;
        }
        const query = parts[0]!.toLowerCase();
        const matched = enabled.find((m) => {
          const lower = m.model.toLowerCase();
          return lower === query || lower.endsWith("-" + query) || lower.includes(query);
        });
        if (!matched) {
          add(
            "error",
            `Unknown model '${parts[0]}'. Enabled models: ${enabled.map((m) => m.model.replace(/^gpt-\d+-/, "")).join(", ")}.`,
          );
          return;
        }
        const effortArg = parts[1]?.toLowerCase();
        const effort = effortArg
          ? (matched.efforts.find((e) => e.toLowerCase() === effortArg) as Route["effort"])
          : (matched.defaultEffort ?? matched.efforts[0]);
        if (!effort || !matched.efforts.includes(effort)) {
          add(
            "error",
            `Invalid effort '${parts[1]}' for ${matched.model}. Available: ${matched.efforts.join(", ")}.`,
          );
          return;
        }
        const updated = {
          ...session,
          routingMode: "manual" as const,
          route: { model: matched.model, effort },
          manualWorkflow: undefined,
        };
        try {
          await store.save(updated);
          setSession(updated);
          rememberSession(updated);
          const name = matched.model.replace(
            /^gpt-(\d+)-(.+)$/,
            (_match: string, ver: string, n: string) =>
              `GPT-${ver} ${n[0]!.toUpperCase()}${n.slice(1)}`,
          );
          add("info", `Manual routing enabled: ${name} ${effort[0]!.toUpperCase()}${effort.slice(1)}.`);
        } catch (error) {
          add("error", `Could not save manual route: ${String(error)}`);
        }
        return;
      }
      if (command === "/approval") {
        const mode = parts[0] as ApprovalMode | undefined;
        if (!mode) {
          setApprovalMenu(true);
          setMenuIndex(["request-approval", "limited", "full-access"].indexOf(config.approvalMode ?? "request-approval"));
          return;
        }
        if (parts.length !== 1 || !["full-access", "request-approval", "limited"].includes(mode)) { add("error", "Use /approval full-access, /approval request-approval, or /approval limited."); return; }
        try {
          const updated = { ...config, approvalMode: mode };
          await store.saveConfig(updated);
          setConfig(updated);
          latestConfig.current = updated;
          add("info", `Approval mode: ${mode}. Active turns keep their starting mode.`);
        } catch (error) { add("error", `Could not save approval mode: ${String(error)}`); }
        return;
      }
      if (command === "/tasks") {
        if (parts.length) { add("error", "Type /tasks without arguments."); return; }
        add("info", taskSummary(session.tasks));
        return;
      }
      if (command === "/usage") {
        if (parts.length) { add("error", "Type /usage without arguments."); return; }
        refreshUsage();
        return;
      }
      if (command === "/context") {
        if (parts.length) { add("error", "Type /context without arguments."); return; }
        const reading = measuredContext(session);
        const percent = contextPercent(reading);
        const freshOnNextTurn = session.checkpoint?.threadId === session.threadId &&
          session.turns.some(turn => turn.at === session.checkpoint?.sourceTurnAt);
        add("info", session.threadId
          ? `Current Codex thread: ${session.threadId}. The next turn ${freshOnNextTurn ? "starts a fresh thread from the checkpoint" : "resumes this thread"}.`
          : "No Codex thread is attached. The next turn starts a thread with retained conversation history.");
        add("info", reading && percent !== undefined
          ? `Last model request: ${reading.tokens.toLocaleString()} / ${reading.windowTokens.toLocaleString()} context tokens (${percent}%)${reading.model ? ` on ${reading.model}` : ""}.`
          : "Context occupancy is unavailable for the current thread and model.");
        if (session.checkpoint) add("info", `Saved checkpoint from ${session.checkpoint.createdAt}; original thread ${session.checkpoint.threadId}.`);
        add("info", "Use /compact to compact an idle thread, or /new to begin a separate fresh conversation. /resume returns to a saved conversation.");
        return;
      }
      if (command === "/compact") {
        if (parts.length) { add("error", "Type /compact without arguments."); return; }
        if (!session.threadId) { add("error", "This conversation has no Codex thread to compact."); return; }
        if (jobs.current.has(session.id)) { add("error", "Wait for this conversation to finish before compacting."); return; }
        const target = session;
        const sessionId = target.id;
        const threadId = session.threadId;
        const controller = new AbortController();
        jobs.current.set(sessionId, { session: target, controller, prompt: "/compact" });
        setRunningIds([...jobs.current.keys()]);
        addFor(sessionId, "info", "Compacting Codex context…");
        void (async () => {
          try {
            const result = await runner.compact(threadId, target.projectPath, target.route,
              progress => { if (progress.kind === "status") setStatusFor(sessionId, progress.text); }, controller.signal);
            const record = {
              at: new Date().toISOString(), threadId, route: target.route,
              durationMs: result.durationMs, outcome: result.outcome,
              usage: result.usage, estimatedCostUsd: costForUsage(target.route, result.usage),
              error: result.error,
            };
            target.compactions = [...(target.compactions ?? []), record].slice(-50);
            if (target.contextByThread) delete target.contextByThread[threadId];
            await store.save(target, () => activeSessionId.current === sessionId);
            rememberSession(target);
            if (activeSessionId.current === sessionId) setSession({ ...target });
            const detail = result.outcome === "completed" ? "Context compacted." :
              result.outcome === "cancelled" ? "Compaction cancelled." : `Compaction failed: ${result.error ?? "unknown error"}`;
            addFor(sessionId, result.outcome === "failed" ? "error" : "info", detail);
            setStatusFor(sessionId, result.outcome === "completed" ? "Done" : result.outcome === "cancelled" ? "Cancelled" : "Failed");
          } catch (error) {
            addFor(sessionId, "error", `Could not save compaction: ${String(error)}`);
            setStatusFor(sessionId, "Failed");
          } finally {
            jobs.current.delete(sessionId);
            if (activeSessionId.current !== sessionId) unreadCompletions.current.add(sessionId);
            setRunningIds([...jobs.current.keys()]);
            const next = promptQueue.current.take(sessionId);
            if (next !== undefined) {
              setQueueVersion(value => value + 1);
              void runTurn(next, target, config);
            }
          }
        })();
        return;
      }
      if (command === "/models") {
        if (parts.length) {
          add("error", "Type /models to open the menu.");
          return;
        }
        setModelMenu("models");
        setMenuIndex(0);
        refreshModelCatalog(true);
        return;
      }
      if (command === "/version") {
        const manifest = await refreshVersionManifest(fetch, undefined, true);
        setKnownModels(Object.keys(manifest.pricing.rates));
        add("info", `Pace ${installedVersion}; ${currentManifestSource()} catalog reports ${manifest.pace.latest}${newerPaceVersion(installedVersion, manifest.pace.latest) ? ` · ${manifest.pace.releaseUrl}` : ""}. Prices checked ${manifest.pricing.checkedAt}.`);
        return;
      }
      if (command === "/artifacts") {
        try {
          const files = await artifactSnapshot(artifactDirectory(store, session));
          const legacy = await artifactSnapshot(legacyArtifactDirectory(session.projectPath));
          add(
            "info",
            files.size || legacy.size
              ? [
                  ...[...files.keys()].sort().map(name => artifactPath(store, session, `artifacts/${name}`)),
                  ...[...legacy.keys()].sort().map(name => artifactPath(store, session, `.pace/artifacts/${name}`)),
                ].join("\n")
              : "No Markdown artifacts for this conversation yet.",
          );
        } catch (error) {
          add("error", `Could not list artifacts: ${String(error)}`);
        }
        return;
      }
      if (command === "/stats") {
        const turns = session.turns;
        const compactions = session.compactions ?? [];
        const generations = session.checkpointGenerations ?? [];
        if (!turns.length && !compactions.length && !generations.length) { add("info", "No recorded turns or context actions yet."); return; }
        const total = (key: "input_tokens" | "cached_input_tokens" | "cache_write_input_tokens" | "output_tokens") => turns.reduce((sum, turn) => sum + (turn.usage?.[key] ?? 0), 0);
        const elapsed = turns.reduce((sum, turn) => sum + (turn.durationMs ?? 0), 0);
        const reported = turns.filter(turn => turn.usage).length;
        const cost = turns.reduce((sum, turn) => sum + (turn.estimatedCostUsd ?? 0), 0);
        const priced = turns.filter(turn => turn.estimatedCostUsd !== undefined).length;
        add("info", `Codex usage: ${total("input_tokens")} input (${total("cached_input_tokens")} cached, ${total("cache_write_input_tokens")} cache write), ${total("output_tokens")} output; ${priced ? `~$${cost.toFixed(4)} estimated API equivalent (${priced} priced turns)` : 'API-equivalent cost unavailable'}`);
        add("info", `Current conversation, last ${turns.length} turns · ${turns.filter(turn => turn.failed).length} failed · ${(elapsed / 1000).toFixed(1)}s elapsed · ${total("input_tokens")} input / ${total("output_tokens")} output tokens (${reported} turns reported usage)`);
        if (compactions.length) {
          const input = compactions.reduce((sum, item) => sum + (item.usage?.input_tokens ?? 0), 0);
          const output = compactions.reduce((sum, item) => sum + (item.usage?.output_tokens ?? 0), 0);
          const duration = compactions.reduce((sum, item) => sum + item.durationMs, 0);
          const estimated = compactions.reduce((sum, item) => sum + (item.estimatedCostUsd ?? 0), 0);
          const pricedCount = compactions.filter(item => item.estimatedCostUsd !== undefined).length;
          add("info", `Compactions: ${compactions.length} (${compactions.filter(item => item.outcome === "completed").length} completed, ${compactions.filter(item => item.outcome === "failed").length} failed, ${compactions.filter(item => item.outcome === "cancelled").length} cancelled) · ${input} input / ${output} output tokens (${compactions.filter(item => item.usage).length} reported usage) · ${(duration / 1000).toFixed(1)}s · ${pricedCount ? `~$${estimated.toFixed(4)} estimated API equivalent (${pricedCount} priced)` : "API-equivalent cost unavailable"}`);
        }
        if (generations.length) {
          const input = generations.reduce((sum, item) => sum + (item.usage?.input_tokens ?? 0), 0);
          const output = generations.reduce((sum, item) => sum + (item.usage?.output_tokens ?? 0), 0);
          const duration = generations.reduce((sum, item) => sum + item.durationMs, 0);
          const estimated = generations.reduce((sum, item) => sum + (item.estimatedCostUsd ?? 0), 0);
          const pricedCount = generations.filter(item => item.estimatedCostUsd !== undefined).length;
          add("info", `Checkpoints: ${generations.length} generation attempts (${generations.filter(item => item.outcome === "valid").length} valid) · ${input} input / ${output} output tokens (${generations.filter(item => item.usage).length} reported usage) · ${(duration / 1000).toFixed(1)}s · ${pricedCount ? `~$${estimated.toFixed(4)} estimated API equivalent (${pricedCount} priced)` : "API-equivalent cost unavailable"}`);
        }
        return;
      }
      if (command === "/route") {
        if (parts.length) { add("error", "Type /route without arguments."); return; }
        for (const line of formatLatestRoute(session.turns, config.models)) add("info", line);
        return;
      }
      if (command === "/trust") {
        const action = parts[0];
        const input = folderArgument(parts.slice(1).join(" "));
        if (!action || action === "list") {
          add("info", config.trustedFolders?.length ? config.trustedFolders.join("\n") : "No trusted folders.");
          return;
        }
        if ((action !== "add" && action !== "remove") || !input) {
          add("error", "Use /trust add <folder>, /trust remove <folder>, or /trust list.");
          return;
        }
        try {
          const folder = action === "add" ? await existingFolder(input) : await existingFolder(input).catch(() => resolve(input));
          const folders = action === "add"
            ? [...(config.trustedFolders ?? []).filter(path => !sameFolder(path, folder)), folder]
            : (config.trustedFolders ?? []).filter(path => !sameFolder(path, folder));
          if (action === "remove" && folders.length === (config.trustedFolders ?? []).length) {
            add("error", `Folder is not trusted: ${input}`);
            return;
          }
          const updated = { ...config, trustedFolders: folders };
          await store.saveConfig(updated);
          setConfig(updated);
          add("info", `${action === "add" ? "Trusted" : "Removed"}: ${folder}`);
        } catch (error) { add("error", `Could not update trusted folders: ${String(error)}`); }
        return;
      }
      if (command === "/skills") {
        try {
          if (parts[0] === "auto") {
            if (parts.length !== 2) { add("error", "Use /skills auto <name|off>."); return; }
            if (parts[1] === "off") { await changeAutoLaunch(); return; }
            const found = skills.find(skill => skill.name.toLowerCase() === parts[1]!.toLowerCase());
            if (!found) { add("error", `Unknown skill: ${parts[1]}. Use /skills to refresh discovery.`); return; }
            if (!enabledSkills(skills, config).includes(found)) { add("error", `Skill is disabled: ${found.name}.`); return; }
            if (!validSkillName(found.name)) { add("error", `Skill name cannot be used for ON-LAUNCH: ${found.name}.`); return; }
            await changeAutoLaunch(found.name);
            return;
          }
          if (parts.join(" ") === "off") {
            const updated = { ...config, skillFolder: null };
            await store.saveConfig(updated);
            setConfig(updated);
            setSkills([]);
            add("info", "Skill folder disabled.");
            return;
          }
          if (parts[0] === "enable" || parts[0] === "disable") {
            const name = parts[1];
            const found = skills.find(skill => skill.name === name);
            if (!found || parts.length !== 2) { add("error", "Use /skills enable <name> or /skills disable <name> with a discovered skill."); return; }
            const disabledSkills = parts[0] === "disable"
              ? [...new Set([...(config.disabledSkills ?? []), name!])]
              : (config.disabledSkills ?? []).filter(item => item !== name);
            const updated = { ...config, disabledSkills };
            await store.saveConfig(updated);
            setConfig(updated);
            add("info", `${name} ${parts[0] === "disable" ? "disabled" : "enabled"}.`);
            return;
          }
          const folder = parts.join(" ") === "default" ? undefined
            : parts.length ? await existingFolder(folderArgument(parts.join(" "))) : config.skillFolder;
          const updated = parts.length ? { ...config, skillFolder: folder } : config;
          const found = await configuredSkills(updated);
          if (parts.length) { await store.saveConfig(updated); setConfig(updated); }
          setSkills(found);
          add("info", found.length
            ? found.map(skill => `/${skill.name} ${updated.disabledSkills?.includes(skill.name) ? "(disabled)" : "(enabled)"} · ${skill.description}`).join("\n")
            : `No skills found in ${folder === null ? "the disabled skill folder" : folder ?? defaultSkillFolder()}.`);
        } catch (error) { add("error", `Could not discover skills: ${String(error)}`); }
        return;
      }
      if (command === "/resume") {
        const query = parts.join(" ").trim();
        const loaded = await loadResumeChoices(store, openSessions, [...jobs.current.values()].map(job => job.session));
        if (loaded.sessions.length <= 1) {
          add("info", "No saved conversations.");
          return;
        }
        setOpenSessions(loaded.sessions);
        setMissingProjectPaths(loaded.missingProjectPaths);
        setPickerSearch(query);
        setShowConversationsTab(true);
        setPickerFocused(true);
        setPickerIndex(0);
        return;
      }
      if (command === "/undo") {
        if (!session.turns.length) {
          add("info", "No messages in conversation to undo.");
          return;
        }
        const popped = undoConversationTurn(session)!;
        session.updatedAt = new Date().toISOString();
        try {
          await store.save(session);
        } catch (error) {
          add("error", `Could not save session: ${String(error)}`);
        }
        setSession({ ...session });
        renderSessionTurns(session);
        setDraft(popped.prompt);
        setHistory(session.turns.map((t) => t.prompt));
        add("info", "Undid last turn. Prompt restored to composer.");
        return;
      }
      if (command === "/retry") {
        if (parts.length) { add("error", "Type /retry without arguments."); return; }
        const pending = session.deferredTurn;
        const failed = pending ? undefined : retryableTurn(session);
        if (!pending && !failed) { add("info", "No failed request to retry."); return; }
        add("meta", "Retrying saved request. Existing file changes remain in place.");
        void runTurn(
          pending?.prompt ?? failed!.prompt,
          session,
          config,
          pending?.intent ?? failed?.intent,
          pending?.displayPrompt ?? failed?.displayPrompt,
        );
        return;
      }
      if (command === "/cancelretry") {
        if (parts.length) { add("error", "Type /cancelretry without arguments."); return; }
        if (!session.deferredTurn) { add("info", "No automatic retry is scheduled."); return; }
        await cancelRetry();
        return;
      }
      if (command === "/convo" || command === "/turns") {
        if (!session.turns.length) {
          add("info", "No messages in conversation yet.");
          return;
        }
        setConvoMenu(true);
        setMenuIndex(session.turns.length - 1);
        return;
      }
      if (!skillCommand(text, enabledSkills(skills, config)) || commands.includes(command)) {
        add("error", `Unknown command ${command}. Type / to browse commands.`);
        return;
      }
    }
    const invokedSkill = skillCommand(text, enabledSkills(skills, config));
    const skillArgument = invokedSkill ? skillRequest(text, invokedSkill) : undefined;
    const localSkillCommand = invokedSkill && (!skillArgument || skillArgument === "off" || !!skillOption(invokedSkill, skillArgument));
    const stopCaveman = /^(?:stop caveman|normal mode)$/i.test(text) && session.activeSkills?.includes("caveman");
    if (session.deferredTurn && !localSkillCommand && !stopCaveman) {
      if (text === session.deferredTurn.prompt) {
        add("info", "That request is already saved for automatic retry.");
        return;
      }
      const position = promptQueue.current.add(session.id, text);
      setQueueVersion(value => value + 1);
      add("info", `Queued prompt ${position} until the automatic retry finishes.`);
      return;
    }
    if (vexState !== "connected" && session.routingMode === "auto" && !localSkillCommand && !stopCaveman) {
      add(
        "error",
        "Vex MCP is unavailable. Auto routing is blocked. Choose a model in /models for manual turns, or restart Pace after fixing Vex.",
      );
      return;
    }
    void runTurn(text, session, config);
  };
  const runTurn = createTurnRunner({
    turnSequence, activeSessionId, jobs, promptQueue, titleAborts, pendingApprovals, pendingQuestions, unreadCompletions,
    runner, orchestrator, store, rememberSession, onTurnStart: sessionId => thisPaceIds.current.add(sessionId), setRunningIds, addFor, activityFor,
    recordThoughtUsage, resetThoughtUsage: (sessionId: string) => lastReasoningTokens.current.delete(sessionId),
    getTurnActivities: (sessionId: string, turnId: number) => (sessionLines.current.get(sessionId) ?? [])
      .filter(line => line.sourceId?.startsWith(`turn-${turnId}-`) && line.activity?.completed)
      .slice(-200)
      .map(line => ({
        category: line.activity!.category, text: line.text.slice(0, 2000),
        detail: line.activity!.detail?.slice(0, 12000), outcome: line.activity!.outcome,
        durationMs: line.activity!.durationMs, tokens: line.activity!.tokens,
      })),
    setStatusFor, showApproval, showQuestion, dismissQuestion, setSession, setVexState, refreshUsage, setQueueVersion,
    setProcesses, setLiveUsage, getConfig: () => latestConfig.current ?? config!,
  });
  runTurnRef.current = runTurn;
  useEffect(() => {
    if (!config) return;
    let active = true;
    const checking = new Set<string>();
    const check = () => {
      for (const target of openSessions) {
        const pending = target.deferredTurn;
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
          void runTurn(saved.prompt, full, latestConfig.current ?? config, saved.intent, saved.displayPrompt, true);
        })().catch(error => addFor(target.id, "error", `Could not resume automatic retry: ${String(error)}`))
          .finally(() => checking.delete(target.id));
      }
    };
    check();
    const timer = setInterval(check, 5_000);
    return () => { active = false; clearInterval(timer); };
  }, [config, openSessions, vexState]);
  const { history: settledLines, live: liveLines } = useMemo(() => splitTranscript(lines), [lines]);
  const staticState = staticHistory.current;
  if (session?.id && staticState.sessionId && session.id !== staticState.sessionId) {
    staticState.key++;
    staticState.firstId = lines[0]?.id;
  } else if (staticState.firstId !== undefined && staticState.firstId !== lines[0]?.id) {
    staticState.key++;
    staticState.firstId = lines[0]?.id;
  } else if (staticState.firstId === undefined) {
    staticState.firstId = lines[0]?.id;
  }
  staticState.sessionId = session?.id ?? staticState.sessionId;
  const staticKey = `${staticState.key}-${transcriptRevision}`;
  const staticItems: ({ kind: "logo" } | { kind: "status" } | { kind: "lines"; group: Line[] })[] = [
    ...(showHeader ? [{ kind: "logo" as const }] : []),
    ...(showHeader && vexState !== "connecting" ? [{ kind: "status" as const }] : []),
    ...settledLines.map(group => ({ kind: "lines" as const, group })),
  ];
  const terminalColumns = terminalDimensions.columns;
  const terminalRows = terminalDimensions.rows;
  const contentWidth = Math.max(20, terminalColumns - 2);
  const composerChromeRows = contentWidth < 50 || (contentWidth >= 72 && contentWidth < 112) ? 6 : 5;
  const extraWorkingRows = (busy && session && liveUsage[session.id] ? 1 : 0) + (busy && workingTip ? 1 : 0);
  const maxComposerRows = Math.max(1, terminalRows - composerChromeRows - extraWorkingRows - 1);

  return (
    // Ink clears the terminal on every update when the live frame exceeds the viewport.
    <Box flexDirection="column" paddingX={1} width={terminalColumns} maxHeight={Math.max(1, terminalRows - 1)} overflowY="hidden">
      <Static key={staticKey} items={staticItems} style={{ width: contentWidth }}>
        {item => item.kind === "logo"
          ? <HeaderLogo key="logo" width={contentWidth} />
          : item.kind === "status"
            ? <HeaderStatus project={session?.projectPath ?? project} vexState={vexState} sessionKind={session?.kind} width={contentWidth} />
            : <Transcript key={item.group[0]?.id} lines={item.group} outputsExpanded={outputsExpanded} detailsExpanded={outputsExpanded} width={contentWidth} />}
      </Static>
      <Box flexDirection="column" flexShrink={1} minHeight={0} overflowY="hidden">
      <Box flexDirection="column" flexShrink={1} minHeight={0} overflowY="hidden">
        <Transcript lines={liveLines.slice(-Math.max(1, Math.floor(((terminalRows - 12) / 4))))} outputsExpanded={outputsExpanded} detailsExpanded={outputsExpanded} livePreview width={contentWidth} />
      </Box>
      {modelMenu ? <ModelMenu mode={modelMenu} models={menuModels} availableModels={availableModels.map(model => model.model)} efforts={menuEfforts} catalogStatus={modelCatalogStatus} selectedModel={menuModel} selectedIndex={menuIndex} config={config} /> : null}
      {approvalMenu ? <ApprovalModeMenu selectedIndex={menuIndex} currentMode={config?.approvalMode ?? "request-approval"} /> : null}
      {manualMenu ? <ManualWorkflowMenu title={manualWizard.step === "workflow" ? "Manual workflow" : `${manualWizard.shape} · ${manualStage} · ${manualWizard.step}`} options={manualOptions} selectedIndex={menuIndex} /> : null}
      {convoMenu && session ? <ConvoMenu turns={session.turns} selectedIndex={menuIndex} /> : null}
      {queueMenu && session ? <QueueMenu prompts={queued} selectedIndex={menuIndex} /> : null}
      <WorkingStatus busy={busy} status={status} runningCount={runningIds.length} shellJobs={shellJobs} tick={tick}
        usage={busy && session ? liveUsage[session.id] : undefined} tip={workingTip} />
      {backgroundApprovals.length ? <Text color="#FBBF24" bold>⚠ {backgroundApprovals.length} background approval{backgroundApprovals.length === 1 ? "" : "s"} waiting · ↓ select conversation · Enter open</Text> : null}
      {backgroundQuestions.length ? <Text color="#A5B4FC" bold>◆ {backgroundQuestions.length} background question{backgroundQuestions.length === 1 ? "" : "s"} waiting · {question ? "Shift+Tab" : "↓"} select conversation · Enter open</Text> : null}
      <RunningProcesses processes={processes} now={Date.now()} />
      <TaskPanel tasks={session?.tasks ?? []} />
      {approval ? (
        <Box flexDirection="column" borderStyle="round" borderColor="#FBBF24" paddingX={1}>
          <Text color="#FBBF24" bold>Approval required</Text>
          <Text>{displayCommand(approval.command)}</Text>
          {approval.cwd ? <Text dimColor>in {approval.cwd}</Text> : null}
          {approval.reason ? <Text dimColor>{approval.reason}</Text> : null}
          <Text color="#FBBF24">Y approve once · N decline · Esc twice to cancel turn</Text>
        </Box>
      ) : null}
      {question ? <QuestionPanel key={`${session?.id}-${question.id}`} questions={question.questions} onSubmit={question.respond} isActive={!pickerFocused && !approval} /> : null}
      {cancelArmed ? <Text color="#FBBF24">Press Esc again to cancel the turn</Text> : null}
      {session?.deferredTurn && !busy ? <Text color="#FBBF24">Automatic retry ({session.deferredTurn.reason ?? "usage"}): {session.deferredTurn.reason === "network" ? "checking connection" : `after ${new Date(session.deferredTurn.retryAt).toLocaleString()}`} · Esc cancels</Text> : null}
      </Box>
      <ComposerFrame width={contentWidth} session={session} shellMode={shellMode} approvalMode={config?.approvalMode}>
        <Composer key={session?.id} value={draft} width={contentWidth} maxRows={maxComposerRows} onChange={value => { setDraft(value); setSelection(0); }} onSubmit={value => { void submit(value); }} history={history}
          onImagePaste={async () => {
            try {
              const targetDir = session ? store.conversationDir(session.projectPath, session.id) : join(store.sessionDir(project), "pasted-images");
              const path = await saveClipboardImage(targetDir);
              if (!path) add("info", "No image found in clipboard. On WSL, use Alt+V when terminal handles Ctrl+V.");
              return path ? `[Pace image: ${path}]` : undefined;
            } catch (error) {
              add("error", `Could not paste image: ${String(error)}`);
              return undefined;
            }
          }}
          disabled={!session || !config || !!approval || !!question || !!modelMenu || approvalMenu || resumeMenu || convoMenu || queueMenu || manualMenu || pickerFocused} shellMode={shellMode} registeredCommands={registeredCommands}
          completion={matches[selection] ? (commandArgsWithSkills[matches[selection]!] ? `${matches[selection]} ` : matches[selection]) : matches[0] ? (commandArgsWithSkills[matches[0]!] ? `${matches[0]} ` : matches[0]) : undefined} completionStart={token?.start}
          onComplete={() => {
            const chosen = matches[selection] ?? matches[0];
            const completed = chosen ? (commandArgsWithSkills[chosen] ? `${chosen} ` : chosen) : token?.prefix;
            setDraft(token ? draft.slice(0, token.start) + (completed ?? token.prefix) : draft);
          }}
          onAutoLaunchToggle={matches.length && selectedAutoSkill() ? () => { void changeAutoLaunch(selectedAutoSkill()!.name, true); } : undefined}
          onHistory={direction => {
            if (!matches.length) return false;
            setSelection(value => (value + (direction === "up" ? -1 : 1) + matches.length) % matches.length);
            return true;
          }}
          onMoveDown={focusQueuedOrPicker}
          onQueueEdit={() => handleQueueEdit()}
          onDeleteQueued={handleQueueDelete}
          placeholder={modelMenu || approvalMenu || resumeMenu || convoMenu || queueMenu || manualMenu ? "Close menu to type" : shellMode ? "Bash command; ! returns to Pace" : vexState !== "connected" ? "Vex unavailable; manual turns work" : busy ? "Type next prompt to queue it" : "Ask Pace or type /"}
        />
      </ComposerFrame>
      {usageWarning ? <Text color="#FBBF24">{usageWarning}</Text> : null}
      {!modelMenu && !approvalMenu && !resumeMenu && !convoMenu && !queueMenu && !manualMenu && matches.length > 0 ? (
        <CommandMenu
          matches={matches}
          descriptions={commandDescriptionsWithSkills}
          args={commandArgsWithSkills}
          selectedIndex={selection}
          width={contentWidth}
          skillNames={skillCommands}
          autoLaunchSkills={session?.autoLaunchSkills}
        />
      ) : null}
      <BottomPanel
        width={contentWidth}
        height={terminalRows}
        conversations={{
          choices: pickerChoices,
          missingProjectPaths,
          activeId: activeSessionId.current,
          selectedIndex: pickerIndex,
          focused: pickerFocused,
          searchQuery: pickerSearch,
        }}
        showConversations={showConversationsTab || sortedSessions.length > 1 || pickerFocused}
        queuedPrompts={queued}
        usageLimits={usageLimits}
        usageError={usageError}
      />
    </Box>
  );
}
