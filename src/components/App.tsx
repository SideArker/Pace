import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import type { ApprovalDecision, Progress } from "../integrations/codex.js";
import type { Config, Session, Route } from "../shared/types.js";
import { PaceStore, newSession, rewindConversation, deleteConversationTurn, undoConversationTurn } from "../core/sessions.js";
import { Orchestrator, VexUnavailableError } from "../core/orchestrator.js";
import { PromptQueue } from "../core/prompt-queue.js";
import { AppServerRunner } from "../integrations/codex.js";
import { VexRouter } from "../core/vex/client.js";
import { EFFORTS, withModels } from "../shared/config.js";
import { artifactSnapshot } from "../core/system/artifacts.js";
import { existingFolder, sameFolder } from "../core/system/folders.js";
import { configuredSkills, defaultSkillFolder, enabledSkills, skillCommand, skillOption, skillRequest, type Skill } from "../core/system/skills.js";
import { formatTurnFooter, modelName } from "./turn-format.js";
import { readUsageLimits } from "../integrations/usage.js";
import type { UsageLimits } from "../integrations/usage.js";
import { Composer, commandToken } from "./Composer.js";
import { Header, Transcript, type Line } from "./Transcript.js";
import { UsageBar } from "./UsageBar.js";
import { CommandMenu, ConversationPicker, ConvoMenu, ModelMenu, ResumeMenu, type ConversationChoice } from "./Menus.js";
import { resolve } from "node:path";
import { createShellRunner, formatCommandActivity } from "./shell-runner.js";
import { createTurnRunner, type PendingApproval, type TurnJob } from "./turn-runner.js";
import { costForUsage } from "../core/routing/pricing.js";
const commands = [
  "/help",
  "/models",
  "/model",
  "/auto",
  "/new",
  "/resume",
  "/convo",
  "/undo",
  "/usage",
  "/btw",
  "/artifacts",
  "/trust",
  "/skills",
  "/route",
  "/stats",
  "/compact",
  "/clear",
  "/exit",
];
const modelCatalog = ["gpt-6-luna", "gpt-6-sol", "gpt-6-astra"];
const spinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
// Words shown beside the animated spinner during agent thinking.
const thinkingWords = [
  "Pondering",
  "Connecting dots",
  "Untangling",
  "Scheming",
  "Percolating",
  "Chasing clues",
  "Cooking",
  "Daydreaming",
] as const;
const folderArgument = (value: string) => value.trim().replace(/^(?:"(.*)"|'(.*)')$/, (_match, double: string | undefined, single: string | undefined) => double ?? single ?? value);
const project = process.cwd();
const store = new PaceStore();
const vex = new VexRouter();
const runner = new AppServerRunner();
const orchestrator = new Orchestrator(store, runner, vex);

export default function App({ onClear }: { onClear: () => void }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [config, setConfig] = useState<Config>();
  const [skills, setSkills] = useState<Skill[]>([]);
  const [session, setSession] = useState<Session>();
  const [openSessions, setOpenSessions] = useState<Session[]>([]);
  const [pickerFocused, setPickerFocused] = useState(false);
  const [pickerIndex, setPickerIndex] = useState(0);
  const [lines, setLines] = useState<Line[]>([]);
  const [status, setStatus] = useState("Loading…");
  const [runningIds, setRunningIds] = useState<string[]>([]);
  const [sideBusy, setSideBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [outputsExpanded, setOutputsExpanded] = useState(false);
  const [usageLimits, setUsageLimits] = useState<UsageLimits>();
  const [usageError, setUsageError] = useState<string>();
  const [showUsage, setShowUsage] = useState(false);
  const [showHeader, setShowHeader] = useState(true);
  const [scrollBack, setScrollBack] = useState(0);
  const [selection, setSelection] = useState(0);
  const [tick, setTick] = useState(0);
  const [shellMode, setShellMode] = useState(false);
  const [shellJobs, setShellJobs] = useState(0);
  const [approval, setApproval] = useState<Extract<Progress, { kind: "approval" }>>();
  const [vexState, setVexState] = useState<
    "connecting" | "connected" | "failed"
  >("connecting");
  const [modelMenu, setModelMenu] = useState<
    "models" | "efforts" | undefined
  >();
  const [resumeMenu, setResumeMenu] = useState(false);
  const [convoMenu, setConvoMenu] = useState(false);
  const [resumeChoices, setResumeChoices] = useState<Session[]>([]);
  const [resumeProcessIds, setResumeProcessIds] = useState<string[]>([]);
  const [missingProjectPaths, setMissingProjectPaths] = useState<string[]>([]);
  const [menuModel, setMenuModel] = useState("");
  const [menuIndex, setMenuIndex] = useState(0);
  const nextId = useRef(0);
  const turnSequence = useRef(0);
  const jobs = useRef(new Map<string, TurnJob>());
  const promptQueue = useRef(new PromptQueue());
  const [, setQueueVersion] = useState(0);
  const activeSessionId = useRef<string | undefined>(undefined);
  const sessionLines = useRef(new Map<string, Line[]>());
  const sessionDrafts = useRef(new Map<string, string>());
  const preSessionLines = useRef<Line[]>([]);
  const sessionStatuses = useRef(new Map<string, string>());
  const unreadCompletions = useRef(new Set<string>());
  const pendingApprovals = useRef(new Map<string, PendingApproval>());
  const sideAbort = useRef<AbortController | undefined>(undefined);
  const titleAborts = useRef(new Map<string, AbortController>());
  const shells = useRef(new Set<{ kill: () => boolean }>());
  const lastInterruptAt = useRef(0);
  const switchingSession = useRef(false);
  const busy = !!session && runningIds.includes(session.id);
  const queued = session ? promptQueue.current.list(session.id) : [];
  const rememberSession = (target: Session) => setOpenSessions(old => {
    const index = old.findIndex(item => item.id === target.id);
    if (index < 0) return [...old, target];
    return old.map((item, at) => at === index ? target : item);
  });
  const forgetViewedSession = (sessionId?: string) => {
    if (!sessionId || jobs.current.has(sessionId) || unreadCompletions.current.has(sessionId)) return;
    setOpenSessions(old => old.filter(item => item.id !== sessionId));
  };
  const pickerChoices: ConversationChoice[] = openSessions.map(item => ({
    id: item.id,
    title: item.title,
    prompt: jobs.current.get(item.id)?.prompt ?? item.turns.at(-1)?.prompt ?? "",
    state: pendingApprovals.current.has(item.id) ? "approval" : runningIds.includes(item.id) ? "running" : unreadCompletions.current.has(item.id) ? "done" : "ready",
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
    const display = event.category === "command" ? formatCommandActivity(event.title, event.detail) : { title: event.title, detail: event.detail };
    const update = { text: display.title, activity: { category: event.category, detail: display.detail, completed: event.completed } };
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
      if (activeSessionId.current === sessionId) setApproval(undefined);
      request.respond(decision);
      addFor(sessionId, "info", decision === "accept" ? "Approved once." : "Declined.");
      setStatusFor(sessionId, decision === "accept" ? "Resuming" : "Stopped command");
    } };
    pendingApprovals.current.set(sessionId, pending);
    if (activeSessionId.current === sessionId) setApproval(pending);
    setStatusFor(sessionId, "Waiting for approval");
  };
  const skillCommands = (config ? enabledSkills(skills, config) : [])
    .flatMap(skill => [`/${skill.name}`, `@${skill.name}`])
    .filter(command => !commands.includes(command));
  const token = shellMode ? undefined : commandToken(draft);
  const matches = token
    ? [...commands, ...skillCommands].filter((command) => command.startsWith(token.prefix))
    : [];
  const refreshUsage = () => {
    void readUsageLimits()
      .then((limits) => { setUsageLimits(limits); setUsageError(limits ? undefined : "Usage unavailable"); })
      .catch(() => setUsageError("Usage unavailable"));
  };
  const menuModels = [
    ...new Set([
      ...modelCatalog,
      ...(config?.models.map((model) => model.model) ?? []),
    ]),
  ];
  useEffect(() => {
    if (!runningIds.length && !sideBusy && shellJobs === 0) return;
    const timer = setInterval(() => setTick((value) => value + 1), 80);
    return () => clearInterval(timer);
  }, [runningIds.length, sideBusy, shellJobs]);
  useEffect(
    () => () => {
      for (const pending of pendingApprovals.current.values()) pending.respond("decline");
      for (const [sessionId, job] of jobs.current) {
        promptQueue.current.clear(sessionId);
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
    refreshUsage();
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
      try { setSkills(await configuredSkills(loaded)); }
      catch (error) { add("error", `Could not discover skills: ${String(error)}`); }
      const fresh = newSession(project, loaded.routingMode);
      activeSessionId.current = fresh.id;
      sessionLines.current.set(fresh.id, preSessionLines.current);
      setSession(fresh);
      rememberSession(fresh);
      for (const notice of notices) add("error", notice);
      setStatus("Ready · /help for commands");
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
    const enabled = found?.enabled === false || !found;
    const models = found
      ? config.models.map((model) =>
          model.model === name ? { ...model, enabled } : model,
        )
      : [
          ...config.models,
          {
            model: name,
            efforts: ["medium" as const],
            defaultEffort: "medium" as const,
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
  const renderSessionTurns = (targetSession: Session) => {
    const newLines: Line[] = [];
    let id = nextId.current;
    for (const turn of targetSession.turns) {
      newLines.push({
        id: id++,
        role: "you",
        text: turn.prompt,
        spaceBefore: newLines.length > 0,
      });
      for (const message of turn.systemMessages ?? []) newLines.push({
        id: id++, role: "system", text: message, spaceBefore: false,
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
          text: artifact,
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
    nextId.current = id;
    sessionLines.current.set(targetSession.id, newLines);
    if (activeSessionId.current === targetSession.id) setLines(newLines);
  };
  const activateSession = async (chosen: Session) => {
    if (switchingSession.current) return;
    switchingSession.current = true;
    const previousId = activeSessionId.current;
    const target = jobs.current.get(chosen.id)?.session ?? chosen;
    if (previousId) sessionDrafts.current.set(previousId, draft);
    activeSessionId.current = target.id;
    try {
      await store.activate(target);
      stopSideQuestion();
      onClear();
      setSession(target);
      unreadCompletions.current.delete(target.id);
      if (previousId !== target.id) forgetViewedSession(previousId);
      rememberSession(target);
      setResumeMenu(false);
      setConvoMenu(false);
      setPickerFocused(false);
      const targetIndex = openSessions.findIndex(item => item.id === target.id);
      setPickerIndex(targetIndex < 0 ? openSessions.length : targetIndex);
      setDraft(sessionDrafts.current.get(target.id) ?? "");
      setShowHeader(true);
      setScrollBack(0);
      if (sessionLines.current.has(target.id)) setLines(sessionLines.current.get(target.id)!);
      else renderSessionTurns(target);
      setApproval(pendingApprovals.current.get(target.id));
      setHistory(target.turns.map(t => t.prompt));
      add(
        "info",
        `Resumed ${chosen.id.slice(0, 8)} · ${chosen.route.model ?? "Codex default"}`,
      );
      setStatus(sessionStatuses.current.get(target.id) ?? "Ready");
    } catch (error) {
      activeSessionId.current = previousId;
      if (previousId) setLines(sessionLines.current.get(previousId) ?? []);
      add("error", `Could not activate conversation: ${String(error)}`);
    } finally {
      switchingSession.current = false;
    }
  };
  const interrupt = () => {
    const now = Date.now();
    if (now - lastInterruptAt.current < 150) return;
    lastInterruptAt.current = now;
    const id = activeSessionId.current;
    const pending = id ? pendingApprovals.current.get(id) : undefined;
    pending?.respond("decline");
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
  const focusPicker = () => {
    if (openSessions.length < 2 || modelMenu || resumeMenu || convoMenu) return false;
    const current = openSessions.findIndex(item => item.id === activeSessionId.current);
    setPickerIndex((current + 1) % openSessions.length);
    setPickerFocused(true);
    return true;
  };
  useInput((input, key) => {
    if (key.ctrl && input === "c") { interrupt(); return; }
    if (pickerFocused) {
      if (key.escape || key.tab) setPickerFocused(false);
      else if (key.upArrow) {
        if (pickerIndex === 0) setPickerFocused(false);
        else setPickerIndex(value => value - 1);
      } else if (key.downArrow) setPickerIndex(value => (value + 1) % openSessions.length);
      else if (key.return) {
        const chosen = openSessions[pickerIndex];
        setPickerFocused(false);
        if (chosen && chosen.id !== activeSessionId.current) void activateSession(chosen);
      }
      return;
    }
    if (approval) {
      if (key.downArrow && focusPicker()) return;
      const pending = activeSessionId.current ? pendingApprovals.current.get(activeSessionId.current) : undefined;
      if (input.toLowerCase() === "y") pending?.respond("accept");
      else if (input.toLowerCase() === "n") pending?.respond("decline");
      else if (key.escape) interrupt();
      return;
    }
    if (key.escape && !modelMenu && !resumeMenu && !convoMenu && !pickerFocused) {
      const job = activeSessionId.current ? jobs.current.get(activeSessionId.current) : undefined;
      if (job || sideAbort.current) {
        if (job && activeSessionId.current) {
          const cleared = promptQueue.current.clear(activeSessionId.current);
          if (cleared) {
            setQueueVersion(value => value + 1);
            addFor(activeSessionId.current, "info", `Cleared ${cleared} queued prompt${cleared === 1 ? "" : "s"}.`);
          }
        }
        job?.controller.abort();
        sideAbort.current?.abort();
        setStatus("Cancelling…");
        return;
      }
    }
    if (key.ctrl && input === "o") setOutputsExpanded(value => !value);
    if (key.pageUp) {
      setScrollBack(value => Math.min(value + Math.max(1, (stdout.rows ?? 24) - 12), lines.length));
      return;
    }
    if (key.pageDown) {
      setScrollBack(value => Math.max(0, value - Math.max(1, (stdout.rows ?? 24) - 12)));
      return;
    }
    if (modelMenu) {
      const size = modelMenu === "models" ? menuModels.length : EFFORTS.length;
      if (key.escape) {
        setModelMenu(modelMenu === "efforts" ? "models" : undefined);
        setMenuIndex(0);
      } else if (key.upArrow || key.downArrow || key.tab)
        setMenuIndex((value) => (value + (key.upArrow ? -1 : 1) + size) % size);
      else if (key.return && modelMenu === "models") {
        setMenuModel(menuModels[menuIndex]!);
        setModelMenu("efforts");
        setMenuIndex(0);
      } else if (input === " " || (key.return && modelMenu === "efforts")) {
        if (modelMenu === "models") toggleModel(menuModels[menuIndex]!);
        else toggleEffort(EFFORTS[menuIndex]!);
      }
      return;
    }
    if (resumeMenu) {
      if (key.escape) setResumeMenu(false);
      else if (key.upArrow || key.downArrow || key.tab)
        setMenuIndex(
          (value) =>
            (value + (key.upArrow ? -1 : 1) + resumeChoices.length) %
            resumeChoices.length,
        );
      else if (key.return) {
        const chosen = resumeChoices[menuIndex];
        if (chosen && missingProjectPaths.includes(chosen.projectPath))
          add("error", `Project folder is missing: ${chosen.projectPath}. Restore it at this path, then reopen /resume.`);
        else if (chosen) void activateSession(chosen);
      }
      return;
    }
    if (convoMenu) {
      const turns = session?.turns ?? [];
      if (key.escape) setConvoMenu(false);
      else if (key.upArrow || key.downArrow || key.tab)
        setMenuIndex(
          (value) =>
            (value + (key.upArrow ? -1 : 1) + Math.max(1, turns.length)) %
            Math.max(1, turns.length),
        );
      else if (key.return) {
        if (!session) return;
        const targetTurn = turns[menuIndex];
        if (!targetTurn) return;
        rewindConversation(session, menuIndex);
        session.updatedAt = new Date().toISOString();
        void store.save(session);
        setSession({ ...session });
        renderSessionTurns(session);
        setDraft(targetTurn.prompt);
        setHistory(session.turns.map((t) => t.prompt));
        setConvoMenu(false);
        add("info", `Rewound to turn ${menuIndex + 1}. Prompt loaded into composer.`);
      } else if (key.delete || key.backspace || input === "d") {
        if (!session) return;
        deleteConversationTurn(session, menuIndex);
        session.updatedAt = new Date().toISOString();
        void store.save(session);
        setSession({ ...session });
        renderSessionTurns(session);
        setHistory(session.turns.map((t) => t.prompt));
        if (session.turns.length === 0) setConvoMenu(false);
        else setMenuIndex(Math.min(menuIndex, session.turns.length - 1));
        add("info", `Deleted turn ${menuIndex + 1}.`);
      }
      return;
    }
    if (key.ctrl && input === "z") {
      if (!jobs.current.has(session?.id ?? "") && session?.turns.length) {
        const popped = undoConversationTurn(session)!;
        session.updatedAt = new Date().toISOString();
        void store.save(session);
        setSession({ ...session });
        renderSessionTurns(session);
        setDraft(popped.prompt);
        setHistory(session.turns.map((t) => t.prompt));
        add("info", "Undid last turn. Prompt restored to composer.");
      }
      return;
    }
  });

const shell = createShellRunner({
    project,
    nextId,
    shells,
    setShellJobs,
    activity,
    add,
    requestApproval: command => new Promise(resolveDecision => {
      showApproval({
        kind: "approval",
        id: `shell-approval-${nextId.current++}`,
        command,
        reason: "This command can publish changes or rewrite Git history.",
        respond: decision => resolveDecision(decision === "accept"),
      });
    }),
  });
  const askBtw = async (question: string) => {
    if (!session || !config) return;
    if (!question.trim()) { add("error", "Type /btw <question> to ask a side question."); return; }
    if (sideBusy) { add("info", "A side question is already running."); return; }
    const activePrompt = jobs.current.get(session.id)?.prompt;
    const context = [session.turns.slice(-4).map(turn => `User: ${turn.prompt}\nPace: ${turn.result}`).join("\n\n"), activePrompt ? `Current user request (still in progress): ${activePrompt}` : ""].filter(Boolean).join("\n\n");
    const luna = config.models.find(model => model.enabled !== false && model.model === "gpt-6-luna");
    const route = luna ? { model: luna.model, effort: luna.efforts.includes("low") ? "low" as const : luna.defaultEffort ?? luna.efforts[0] } : session.route.model ? session.route : config.defaultRoute;
    const controller = new AbortController();
    const sideId = ++turnSequence.current;
    sideAbort.current = controller;
    setSideBusy(true);
    add("you", `/btw ${question}`);
    try {
      const prompt = `Answer this side question using the brief conversation context below. Do not edit files or take action. This is separate from the main conversation.\n\nContext:\n${context || "(No previous turns)"}\n\nSide question: ${question}`;
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
    const text = raw.trim();
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
    if (text.startsWith("! ")) {
      setDraft("");
      shell(text.slice(2));
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
    if (jobs.current.has(session.id) && !/^\/(?:new|clear|resume|help|exit|usage|stats|compact|route|artifacts|models|trust|skills)(?:\s|$)/.test(text)) {
      if (text.startsWith("/") && !skillCommand(text, enabledSkills(skills, config))) {
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
    if (text.startsWith("/")) {
      const [command, ...parts] = text.split(/\s+/);
      if (command === "/clear" || command === "/new") {
        if (parts.length) {
          add("error", `Type ${command} without arguments.`);
          return;
        }
        const fresh = newSession(project, session.routingMode);
        if (session.routingMode === "manual") fresh.route = session.route;
        switchingSession.current = true;
        const previousId = activeSessionId.current;
        if (previousId) sessionDrafts.current.set(previousId, "");
        activeSessionId.current = fresh.id;
        try {
          await store.save(fresh);
          stopSideQuestion();
          onClear();
          activeSessionId.current = fresh.id;
          sessionLines.current.set(fresh.id, []);
          setSession(fresh);
          forgetViewedSession(previousId);
          rememberSession(fresh);
          setLines([]);
          setDraft("");
          setHistory([]);
          setPickerFocused(false);
          setPickerIndex(openSessions.length);
          setShowHeader(true);
          setShowUsage(false);
          setScrollBack(0);
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
      if (command === "/exit") {
        exit();
        return;
      }
      if (command === "/help") {
        add(
          "info",
          "/models · /model <name> [effort] · /auto · /new · /resume · /convo · /undo · /compact · /usage · /btw <q> · /artifacts · /trust · /skills [folder|default|off|enable <name>|disable <name>] · /<skill> [request] · /route · /stats · /clear · /exit · Esc/Ctrl+C cancel · Ctrl+Z undo · ! Bash · Ctrl+O toggle reasoning and command output · Shift/Ctrl/Alt+Enter or Ctrl+J newline · ↑/↓ history",
        );
        add("info", "With multiple open conversations, press Down from the input to focus the picker. Use arrows and Enter to switch; Esc returns to input. Ctrl+C cancels the selected turn. /exit quits.");
        return;
      }
      if (command === "/auto") {
        // Auto selection uses the enabled model list in the orchestrator.
        const updated = { ...session, routingMode: "auto" as const };
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
      if (command === "/usage") {
        setShowUsage(value => !value);
        refreshUsage();
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
        return;
      }
      if (command === "/artifacts") {
        try {
          const files = await artifactSnapshot(project);
          add(
            "info",
            files.size
              ? [...files.keys()]
                  .sort()
                  .map((name) => `.pace/artifacts/${name}`)
                  .join("\n")
              : "No Markdown artifacts in .pace/artifacts yet.",
          );
        } catch (error) {
          add("error", `Could not list artifacts: ${String(error)}`);
        }
        return;
      }
      if (command === "/route") {
        const last = session.turns.at(-1);
        add("info", `${session.routingMode === "manual" ? `Manual: ${session.route.model ?? "Codex default"} ${session.route.effort ?? "default"}` : "Auto: Vex selects each turn"}. ${last?.route ? `Last: ${modelName(last.route)} · ${last.routeNote ?? "Route detail unavailable"}${last.failed ? " · failed" : ""}` : "No completed route yet."}`);
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
        if (parts.length) {
          add("error", "Type /resume to open the conversation picker.");
          return;
        }
        const projects = await store.listProjects();
        const processIds = [...jobs.current.keys()];
        const choices = projects.flatMap(item => item.sessions);
        for (const job of jobs.current.values()) {
          const index = choices.findIndex(choice => choice.id === job.session.id);
          if (index >= 0) choices[index] = job.session;
          else choices.unshift(job.session);
        }
        if (!choices.length) {
          add("info", "No saved conversations.");
          return;
        }
        setResumeProcessIds(processIds);
        setMissingProjectPaths(projects.filter(item => !item.exists).map(item => item.projectPath));
        setResumeChoices(choices);
        setResumeMenu(true);
        setMenuIndex(0);
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
      if (command === "/model") {
        const [modelName, effort, extra] = parts;
        const choice = config.models.find(item => item.model === modelName && item.enabled !== false);
        if (!choice || extra || (effort && !choice.efforts.includes(effort as NonNullable<Route["effort"]>))) {
          add("error", "Use /model <enabled-model> [configured-effort]. See /models for available choices.");
          return;
        }
        const route: Route = { model: choice.model, effort: (effort as Route["effort"]) ?? choice.defaultEffort ?? choice.efforts[0] };
        const changedModel = !!session.threadId && session.route.model !== route.model;
        const updated = { ...session, route, routingMode: "manual" as const };
        try {
          await store.save(updated);
          setSession(updated);
          rememberSession(updated);
          add("info", `Manual route: ${route.model} ${route.effort}.${changedModel ? " Next turn continues the existing thread." : ""}`);
        } catch (error) {
          add("error", `Could not save manual route: ${String(error)}`);
        }
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
        add("error", `Unknown command ${command}. Use /help.`);
        return;
      }
    }
    const invokedSkill = skillCommand(text, enabledSkills(skills, config));
    const skillArgument = invokedSkill ? skillRequest(text, invokedSkill) : undefined;
    const localSkillCommand = invokedSkill && (!skillArgument || skillArgument === "off" || !!skillOption(invokedSkill, skillArgument));
    const stopCaveman = /^(?:stop caveman|normal mode)$/i.test(text) && session.activeSkills?.includes("caveman");
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
    turnSequence, activeSessionId, jobs, promptQueue, titleAborts, pendingApprovals, unreadCompletions,
    runner, orchestrator, store, rememberSession, setRunningIds, addFor, activityFor,
    setStatusFor, showApproval, setSession, setVexState, refreshUsage, setQueueVersion,
  });
  return (
    <Box flexDirection="column" paddingX={1}>
      {showHeader ? <Header project={project} vexState={vexState} width={stdout.columns ?? 80} session={session} /> : null}
      <Transcript lines={lines} outputsExpanded={outputsExpanded} detailsExpanded={outputsExpanded} rows={stdout.rows ?? 24} scrollBack={scrollBack} width={stdout.columns ?? 80} />
      {modelMenu ? <ModelMenu mode={modelMenu} models={menuModels} selectedModel={menuModel} selectedIndex={menuIndex} config={config} /> : null}
      {resumeMenu ? <ResumeMenu choices={resumeChoices} selectedIndex={menuIndex} runningIds={runningIds} processIds={resumeProcessIds} missingProjectPaths={missingProjectPaths} /> : null}
      {convoMenu && session ? <ConvoMenu turns={session.turns} selectedIndex={menuIndex} /> : null}
      {runningIds.length || shellJobs ? (
      <Box gap={1}><Text color="#59E6A7" bold>{spinner[tick % spinner.length]}</Text><Text color="#38BDF8">{busy ? status === "Thinking" ? thinkingWords[Math.floor(tick / 30) % thinkingWords.length] : status : runningIds.length ? `${runningIds.length} background turn${runningIds.length === 1 ? "" : "s"} running` : "Ready"}</Text>{shellJobs ? <Text color="#FBBF24">· ⚡ {shellJobs} Bash command{shellJobs === 1 ? "" : "s"} running</Text> : null}</Box>
      ) : null}
      {approval ? (
        <Box flexDirection="column" borderStyle="round" borderColor="#FBBF24" paddingX={1}>
          <Text color="#FBBF24" bold>Approval required</Text>
          <Text>{approval.command}</Text>
          {approval.cwd ? <Text dimColor>in {approval.cwd}</Text> : null}
          {approval.reason ? <Text dimColor>{approval.reason}</Text> : null}
          <Text color="#FBBF24">Y approve once · N decline · Esc cancel turn</Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Composer key={session?.id} value={draft} onChange={value => { setDraft(value); setSelection(0); }} onSubmit={value => { void submit(value); }} history={history}
          disabled={!session || !config || !!approval || !!modelMenu || resumeMenu || convoMenu || pickerFocused} shellMode={shellMode}
          completion={matches[selection] ?? matches[0]} completionStart={token?.start}
          onComplete={() => setDraft(token ? draft.slice(0, token.start) + (matches[selection] ?? matches[0] ?? token.prefix) : draft)}
          onHistory={direction => {
            if (!matches.length) return false;
            setSelection(value => (value + (direction === "up" ? -1 : 1) + matches.length) % matches.length);
            return true;
          }}
          onMoveDown={focusPicker}
          placeholder={modelMenu || resumeMenu || convoMenu ? "Close menu to type" : shellMode ? "Bash command; ! returns to Pace" : vexState !== "connected" ? "Vex unavailable; manual turns work" : busy ? "Type next prompt to queue it" : "Ask Pace or type /"}
        />
      </Box>
      {queued.map((prompt, index) => <Text key={`${index}-${prompt}`} color="#FBBF24" wrap="truncate">QUEUED: {prompt.replace(/\s+/g, " ")}</Text>)}
      {runningIds.length > 0 && openSessions.length > 1 ? <ConversationPicker choices={pickerChoices} activeId={activeSessionId.current} selectedIndex={pickerIndex} focused={pickerFocused} /> : null}
      {showUsage ? <UsageBar limits={usageLimits} error={usageError} /> : null}
      {!modelMenu && !resumeMenu && !convoMenu && matches.length > 0 ? <CommandMenu matches={matches} selectedIndex={selection} /> : null}
    </Box>
  );
}
