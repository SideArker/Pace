import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import type { ApprovalDecision, Progress } from "../integrations/codex.js";
import type { Config, Session, Route } from "../shared/types.js";
import { PaceStore, newSession } from "../core/sessions.js";
import { Orchestrator, VexUnavailableError } from "../core/orchestrator.js";
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
import { CommandMenu, ConvoMenu, ModelMenu, ResumeMenu } from "./Menus.js";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
const commands = [
  "/help",
  "/models",
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
  "/clear",
  "/exit",
];
const modelCatalog = ["gpt-6-luna", "gpt-6-sol", "gpt-6-astra"];
const spinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const folderArgument = (value: string) => value.trim().replace(/^(?:"(.*)"|'(.*)')$/, (_match, double: string | undefined, single: string | undefined) => double ?? single ?? value);
const manualApprovalCommand = (command: string) => /\bgit\b[^;&|()\n]*\s(?:push|reset)\b/i.test(command);
function displayShellCommand(command: string): string | undefined {
  const invocation = /^(?:&\s*)?(?:"([^"]+)"|'([^']+)'|(\S+))\s+([\s\S]*)$/.exec(command.trim());
  if (!invocation) return undefined;
  const executable = invocation[1] ?? invocation[2] ?? invocation[3] ?? "";
  const args = invocation[4] ?? "";
  const basename = executable.split(/[\\/]+/).at(-1) ?? "";
  const shell = /^(?:powershell|pwsh)(?:\.exe)?$/i.test(basename)
    ? "PS (PowerShell)"
    : /^bash(?:\.exe)?$/i.test(basename)
      ? "Bash"
      : undefined;
  if (!shell) return undefined;
  const commandFlag = shell === "Bash"
    ? /(?:^|\s)-(?:c|lc)\s+/i
    : /(?:^|\s)-(?:command|c)\s+/i;
  const flag = commandFlag.exec(args);
  const body = flag ? args.slice(flag.index + flag[0].length).trim() : args.trim();
  const script = body.length >= 2 && body[0] === body.at(-1) && (body[0] === "'" || body[0] === '"')
    ? body.slice(1, -1)
    : body;
  return `${shell}: ${script || args.trim()}`;
}
function formatCommandActivity(title: string, detail?: string): { title: string; detail?: string } {
  const match = /^(Running|Ran|Failed): ([\s\S]*?)( \(exit [^)]+\))?$/.exec(title);
  if (!match) return { title, detail };
  const display = displayShellCommand(match[2]!);
  if (!display) return { title, detail };
  return {
    title: `${match[1]}: ${display}${match[3] ?? ""}`,
    detail: [`Command line: ${match[2]}`, detail ? `Output:\n${detail}` : undefined].filter(Boolean).join("\n\n"),
  };
}
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
  const [lines, setLines] = useState<Line[]>([]);
  const [status, setStatus] = useState("Loading…");
  const [busy, setBusy] = useState(false);
  const [sideBusy, setSideBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [outputsExpanded, setOutputsExpanded] = useState(false);
  const [detailsExpanded, setDetailsExpanded] = useState(true);
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
  const [menuModel, setMenuModel] = useState("");
  const [menuIndex, setMenuIndex] = useState(0);
  const nextId = useRef(0);
  const turnSequence = useRef(0);
  const abort = useRef<AbortController | undefined>(undefined);
  const pendingApproval = useRef<Extract<Progress, { kind: "approval" }> | undefined>(undefined);
  const activePrompt = useRef<string | undefined>(undefined);
  const sideAbort = useRef<AbortController | undefined>(undefined);
  const shells = useRef(new Set<{ kill: () => boolean }>());
  const stopSideQuestion = () => {
    const pending = sideAbort.current;
    sideAbort.current = undefined;
    pending?.abort();
    setSideBusy(false);
  };
  const add = (role: Line["role"], text: string) =>
    setLines((old) => [
      ...old,
      {
        id: nextId.current++,
        role,
        text,
        spaceBefore: role === "you" && old.length > 0,
      },
    ]);
  const activity = (event: Extract<Progress, { kind: "activity" }>) => setLines(old => {
    const sourceId = event.id;
    const display = event.category === "command" ? formatCommandActivity(event.title, event.detail) : { title: event.title, detail: event.detail };
    const update = { text: display.title, activity: { category: event.category, detail: display.detail, completed: event.completed } };
    const index = old.findIndex(line => line.sourceId === sourceId);
    if (index < 0) return [...old, { id: nextId.current++, role: "activity", sourceId, spaceBefore: false, ...update }];
    return old.map((line, at) => at === index ? { ...line, ...update } : line);
  });
  const showApproval = (request: Extract<Progress, { kind: "approval" }>) => {
    if (pendingApproval.current) {
      request.respond("decline");
      return;
    }
    const pending = { ...request, respond: (decision: ApprovalDecision) => {
      if (pendingApproval.current?.id !== request.id) return;
      pendingApproval.current = undefined;
      setApproval(undefined);
      request.respond(decision);
      add("info", decision === "accept" ? "Approved once." : "Declined.");
      setStatus(decision === "accept" ? "Resuming" : "Stopped command");
    } };
    pendingApproval.current = pending;
    setApproval(pending);
    setStatus("Waiting for approval");
  };
  const skillCommands = (config ? enabledSkills(skills, config) : [])
    .map(skill => `/${skill.name}`)
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
    if (!busy && !sideBusy && shellJobs === 0) return;
    const timer = setInterval(() => setTick((value) => value + 1), 80);
    return () => clearInterval(timer);
  }, [busy, sideBusy, shellJobs]);
  useEffect(
    () => () => {
      pendingApproval.current?.respond("decline");
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
          `Vex MCP connection failed: ${String(error)}. Coding is blocked until Pace restarts with Vex available.`,
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
      setSession(newSession(project, loaded.routingMode));
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
    let id = 0;
    for (const turn of targetSession.turns.slice(-8)) {
      newLines.push({
        id: id++,
        role: "you",
        text: turn.prompt,
        spaceBefore: newLines.length > 0,
      });
      newLines.push({
        id: id++,
        role: turn.failed ? "error" : "codex",
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
    setLines(newLines);
  };
  const activateSession = async (chosen: Session) => {
    try {
      await store.activate(chosen);
      stopSideQuestion();
      onClear();
      setSession(chosen);
      setResumeMenu(false);
      setConvoMenu(false);
      setShowHeader(true);
      setScrollBack(0);
      renderSessionTurns(chosen);
      setHistory(chosen.turns.map(t => t.prompt));
      add(
        "info",
        `Resumed ${chosen.id.slice(0, 8)} · ${chosen.route.model ?? "Codex default"}`,
      );
      setStatus("Ready");
    } catch (error) {
      add("error", `Could not activate conversation: ${String(error)}`);
    }
  };
  useInput((input, key) => {
    if (approval) {
      if (input.toLowerCase() === "y") pendingApproval.current?.respond("accept");
      else if (input.toLowerCase() === "n" || key.escape) pendingApproval.current?.respond("decline");
      else if (key.ctrl && input === "c") {
        abort.current?.abort();
        pendingApproval.current?.respond("decline");
      }
      return;
    }
    if (key.escape || (key.ctrl && input === "c")) {
      if (busy || sideBusy) {
        abort.current?.abort();
        sideAbort.current?.abort();
        setStatus("Cancelling…");
      } else if (key.ctrl && input === "c") exit();
    }
    if (key.ctrl && input === "o") setOutputsExpanded(value => !value);
    if (key.ctrl && input === "e") setDetailsExpanded(value => !value);
    if (key.pageUp) setScrollBack(value => Math.min(value + Math.max(8, (stdout.rows ?? 24) - 12), lines.length));
    if (key.pageDown) setScrollBack(value => Math.max(0, value - Math.max(8, (stdout.rows ?? 24) - 12)));
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
      else if (key.return) void activateSession(resumeChoices[menuIndex]!);
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
        session.turns = session.turns.slice(0, menuIndex);
        if (session.turns.length === 0) session.threadId = undefined;
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
        session.turns.splice(menuIndex, 1);
        if (session.turns.length === 0) session.threadId = undefined;
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
      if (!busy && session?.turns.length) {
        const popped = session.turns.pop()!;
        if (session.turns.length === 0) session.threadId = undefined;
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

  const shell = async (command: string) => {
    if (manualApprovalCommand(command)) {
      const decision = await new Promise<ApprovalDecision>(resolveDecision => {
        showApproval({
          kind: "approval", id: `shell-approval-${nextId.current++}`, command,
          reason: "This command can publish changes or rewrite Git history.",
          respond: resolveDecision,
        });
      });
      if (decision !== "accept") return;
    }
    const id = `shell-${nextId.current++}`;
    activity({ kind: "activity", id, category: "command", title: `Running: Bash: ${command}`, completed: false });
    const executable =
      process.platform === "win32"
        ? "C:\\Program Files\\Git\\bin\\bash.exe"
        : "bash";
    try {
      const child = spawn(
        executable,
        ["--noprofile", "--norc", "-c", command],
        { cwd: project, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
      );
      shells.current.add(child);
      setShellJobs((value) => value + 1);
      let output = "";
      let clipped = false;
      let failed = false;
      const append = (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        const remaining = 32768 - output.length;
        if (text.length > remaining) clipped = true;
        if (remaining > 0) output += text.slice(0, remaining);
      };
      child.stdout.on("data", append);
      child.stderr.on("data", append);
      child.on("error", (error) => {
        failed = true;
        activity({ kind: "activity", id, category: "command", title: `Failed: Bash: ${command}`, detail: String(error), completed: true });
      });
      child.on("close", (code) => {
        shells.current.delete(child);
        setShellJobs((value) => Math.max(0, value - 1));
        if (!failed) activity({ kind: "activity", id, category: "command", title: `${code === 0 ? "Ran" : "Failed"}: Bash: ${command} (exit ${code ?? "unknown"})`, detail: `${output.trimEnd() || "(no output)"}${clipped ? "\n[output truncated]" : ""}`, completed: true });
      });
    } catch (error) {
      add("error", `Shell error: ${String(error)}`);
    }
  };

  const askBtw = async (question: string) => {
    if (!session || !config) return;
    if (!question.trim()) { add("error", "Type /btw <question> to ask a side question."); return; }
    if (sideBusy) { add("info", "A side question is already running."); return; }
    const context = [session.turns.slice(-4).map(turn => `User: ${turn.prompt}\nPace: ${turn.result}`).join("\n\n"), activePrompt.current ? `Current user request (still in progress): ${activePrompt.current}` : ""].filter(Boolean).join("\n\n");
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
    if (busy) {
      add(
        "info",
        "Codex is working. Use ! for Bash or wait; input remains available.",
      );
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
        try {
          await store.save(fresh);
          stopSideQuestion();
          onClear();
          setSession(fresh);
          setLines([]);
          setShowHeader(true);
          setShowUsage(false);
          setScrollBack(0);
          setStatus("Ready");
        } catch (error) {
          add("error", `Could not create conversation: ${String(error)}`);
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
          "/models · /auto · /new · /resume · /convo · /undo · /usage · /btw <q> · /artifacts · /trust · /skills [folder|default|off|enable <name>|disable <name>] · /<skill> [request] · /route · /stats · /clear · /exit · Esc/Ctrl+C cancel · Ctrl+Z undo · ! Bash · Shift/Ctrl/Alt+Enter or Ctrl+J newline · ↑/↓ history",
        );
        return;
      }
      if (command === "/auto") {
        // Auto selection uses the enabled model list in the orchestrator.
        const updated = { ...session, routingMode: "auto" as const };
        try {
          await store.save(updated);
          setSession(updated);
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
        add("info", last?.route ? `${modelName(last.route)} · ${last.routeNote ?? "Route detail unavailable"}${last.failed ? " · failed" : ""}` : "No completed route yet.");
        return;
      }
      if (command === "/stats") {
        const turns = session.turns;
        if (!turns.length) { add("info", "No recorded turns yet."); return; }
        const total = (key: "input_tokens" | "cached_input_tokens" | "cache_write_input_tokens" | "output_tokens") => turns.reduce((sum, turn) => sum + (turn.usage?.[key] ?? 0), 0);
        const elapsed = turns.reduce((sum, turn) => sum + (turn.durationMs ?? 0), 0);
        const reported = turns.filter(turn => turn.usage).length;
        const cost = turns.reduce((sum, turn) => sum + (turn.estimatedCostUsd ?? 0), 0);
        const priced = turns.filter(turn => turn.estimatedCostUsd !== undefined).length;
        add("info", `Codex usage: ${total("input_tokens")} input (${total("cached_input_tokens")} cached, ${total("cache_write_input_tokens")} cache write), ${total("output_tokens")} output; ${priced ? `~$${cost.toFixed(4)} estimated API equivalent (${priced} priced turns)` : 'API-equivalent cost unavailable'}`);
        add("info", `Current conversation, last ${turns.length} turns · ${turns.filter(turn => turn.failed).length} failed · ${(elapsed / 1000).toFixed(1)}s elapsed · ${total("input_tokens")} input / ${total("output_tokens")} output tokens (${reported} turns reported usage)`);
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
        const saved = await store.list(project);
        if (!saved.length) {
          add("info", "No saved conversations.");
          return;
        }
        setResumeChoices(saved);
        setResumeMenu(true);
        setMenuIndex(0);
        return;
      }
      if (command === "/undo") {
        if (!session.turns.length) {
          add("info", "No messages in conversation to undo.");
          return;
        }
        const popped = session.turns.pop()!;
        if (session.turns.length === 0) session.threadId = undefined;
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
    if (vexState !== "connected" && !localSkillCommand && !stopCaveman) {
      add(
        "error",
        "Vex MCP is unavailable. Coding turns are blocked until it reconnects; restart Pace after fixing Vex.",
      );
      return;
    }
    add("you", text);
    setBusy(true);
    activePrompt.current = text;
    setStatus("Starting…");
    const controller = new AbortController();
    const turnId = ++turnSequence.current;
    abort.current = controller;
    try {
      const outcome = await orchestrator.turn(
        text,
        session,
        config,
        (progress) => {
          if (progress.kind === "status") {
            setStatus(progress.text);
            setSession({ ...session });
          }
          if (progress.kind === "route")
            setStatus(`Using ${modelName(progress.route)}…`);
          if (progress.kind === "activity") {
            activity({ ...progress, id: `turn-${turnId}-${progress.id}` });
            setStatus(progress.title);
          }
          if (progress.kind === "approval") showApproval(progress);
          if (progress.kind === "error") add("error", progress.text);
          if (progress.kind === "message") {
            setStatus("Finishing response…");
          }
        },
        controller.signal,
      );
      setSession({ ...outcome.session });
      add("codex", outcome.result);
      if (outcome.stages.length) add(
        "meta",
        formatTurnFooter(
          outcome.route,
          outcome.note,
          outcome.usage,
          outcome.durationMs,
          outcome.estimatedCostUsd,
        ),
      );
      for (const artifact of outcome.artifacts) add("artifact", artifact);
      add("divider", "");
      setStatus("Done");
      refreshUsage();
    } catch (error) {
      if (controller.signal.aborted) { add("meta", "Turn cancelled by user"); setStatus("Cancelled"); } else { add("error", String(error));
      if (error instanceof VexUnavailableError && error.source === "connection") setVexState("failed");
      setStatus("Failed"); }
    } finally {
      pendingApproval.current?.respond("decline");
      abort.current = undefined;
      activePrompt.current = undefined;
      setBusy(false);
    }
  };
  return (
    <Box flexDirection="column" paddingX={1}>
      {showHeader ? <Header project={project} vexState={vexState} width={stdout.columns ?? 80} /> : null}
      <Transcript lines={lines} outputsExpanded={outputsExpanded} detailsExpanded={detailsExpanded} rows={stdout.rows ?? 24} scrollBack={scrollBack} width={stdout.columns ?? 80} />
      {modelMenu ? <ModelMenu mode={modelMenu} models={menuModels} selectedModel={menuModel} selectedIndex={menuIndex} config={config} /> : null}
      {resumeMenu ? <ResumeMenu choices={resumeChoices} selectedIndex={menuIndex} /> : null}
      {convoMenu && session ? <ConvoMenu turns={session.turns} selectedIndex={menuIndex} /> : null}
      {busy || shellJobs ? (
        <Box gap={1}><Text color="#59E6A7" bold>{spinner[tick % spinner.length]}</Text><Text color="#38BDF8">{status}</Text>{shellJobs ? <Text color="#FBBF24">· ⚡ {shellJobs} Bash command{shellJobs === 1 ? "" : "s"} running</Text> : null}</Box>
      ) : null}
      {approval ? (
        <Box flexDirection="column" borderStyle="round" borderColor="#FBBF24" paddingX={1}>
          <Text color="#FBBF24" bold>Approval required</Text>
          <Text>{approval.command}</Text>
          {approval.cwd ? <Text dimColor>in {approval.cwd}</Text> : null}
          {approval.reason ? <Text dimColor>{approval.reason}</Text> : null}
          <Text color="#FBBF24">Y approve once Â· N or Esc decline</Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Composer value={draft} onChange={value => { setDraft(value); setSelection(0); }} onSubmit={value => { void submit(value); }} history={history}
          disabled={!session || !config || !!approval || !!modelMenu || resumeMenu || convoMenu} shellMode={shellMode}
          completion={matches[selection] ?? matches[0]} completionStart={token?.start}
          onComplete={() => setDraft(token ? draft.slice(0, token.start) + (matches[selection] ?? matches[0] ?? token.prefix) : draft)}
          onHistory={direction => {
            if (!matches.length) return false;
            setSelection(value => (value + (direction === "up" ? -1 : 1) + matches.length) % matches.length);
            return true;
          }}
          placeholder={modelMenu || resumeMenu || convoMenu ? "Close menu to type" : shellMode ? "Bash command; ! returns to Pace" : vexState !== "connected" ? "Vex unavailable; commands still work" : busy ? "Pace is working · Esc or Ctrl+C to cancel" : "Ask Pace or type /"}
        />
      </Box>
      {showUsage ? <UsageBar limits={usageLimits} error={usageError} /> : null}
      {!modelMenu && !resumeMenu && !convoMenu && matches.length > 0 ? <CommandMenu matches={matches} selectedIndex={selection} /> : null}
    </Box>
  );
}
