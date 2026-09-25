import React, { useEffect, useRef, useState } from "react";
import { Box, Static, Text, useApp, useInput } from "ink";
import { TextInput } from "@inkjs/ui";
import type { Config, Session, Route } from "./types.js";
import { PaceStore, newSession } from "./core/sessions.js";
import { Orchestrator, VexUnavailableError } from "./core/orchestrator.js";
import { SdkRunner } from "./integrations/codex.js";
import { VexRouter } from './integrations/vex.js';
import { EFFORTS, withModels } from "./config.js";
import { artifactSnapshot } from "./core/artifacts.js";
import { formatTurnFooter, modelName } from "./turn-format.js";
import { spawn } from "node:child_process";
import { basename } from "node:path";

type Line = {
  id: number;
  role: "header" | "you" | "codex" | "info" | "meta" | "error" | "artifact" | "divider";
  text: string;
  spaceBefore: boolean;
};
const commands = ["/help", "/models", "/auto", "/new", "/resume", "/artifacts", "/clear", "/exit"];
const modelCatalog = ["gpt-6-luna", "gpt-6-sol", "gpt-6-astra"];
const spinner = ["|", "/", "-", "\\"];
const project = process.cwd();
const store = new PaceStore();
const vex = new VexRouter();
const orchestrator = new Orchestrator(store, new SdkRunner(), vex);

export default function App({ onClear }: { onClear: () => void }) {
  const { exit } = useApp();
  const [config, setConfig] = useState<Config>();
  const [session, setSession] = useState<Session>();
  const [lines, setLines] = useState<Line[]>([]);
  const [status, setStatus] = useState("Loading…");
  const [busy, setBusy] = useState(false);
  const [inputKey, setInputKey] = useState(0);
  const [draft, setDraft] = useState("");
  const [selection, setSelection] = useState(0);
  const [tick, setTick] = useState(0);
  const [shellMode, setShellMode] = useState(false);
  const [shellJobs, setShellJobs] = useState(0);
  const [vexState, setVexState] = useState<"connecting" | "connected" | "failed">("connecting");
  const [modelMenu, setModelMenu] = useState<"models" | "efforts" | undefined>();
  const [resumeMenu, setResumeMenu] = useState(false);
  const [resumeChoices, setResumeChoices] = useState<Session[]>([]);
  const [menuModel, setMenuModel] = useState("");
  const [menuIndex, setMenuIndex] = useState(0);
  const [clearEpoch, setClearEpoch] = useState(0);
  const nextId = useRef(0);
  const abort = useRef<AbortController | undefined>(undefined);
  const shells = useRef(new Set<{ kill: () => boolean }>());
  const add = (role: Line["role"], text: string) =>
    setLines((old) => [...old, { id: nextId.current++, role, text, spaceBefore: role === "you" && old.length > 0 }]);
  const matches = !shellMode && draft.startsWith('/') && !draft.includes(' ') ? commands.filter(command => command.startsWith(draft)) : [];
  const menuModels = [...new Set([...modelCatalog, ...(config?.models.map(model => model.model) ?? [])])];
  useEffect(() => {
    if (!busy && shellJobs === 0) return;
    const timer = setInterval(() => setTick(value => value + 1), 250);
    return () => clearInterval(timer);
  }, [busy, shellJobs]);
  useEffect(() => () => { for (const child of shells.current) child.kill(); }, []);
  useEffect(() => {
    void vex.start().then(() => setVexState("connected")).catch(error => {
      setVexState("failed");
      add('error', `Vex MCP connection failed: ${String(error)}. Coding is blocked until Pace restarts with Vex available.`);
    });
    return () => { void vex.close(); };
  }, []);
  useEffect(() => {
    let active = true;
    const load = async () => {
      const notices: string[] = [];
      const localStore = new PaceStore(undefined, (message) =>
        notices.push(message),
      );
      const loaded = await localStore.loadConfig();
      const saved = await localStore.latest(project);
      if (!active) return;
      setConfig(loaded);
      setSession(saved ?? newSession(project, loaded.routingMode));
      for (const notice of notices) add("error", notice);
      for (const turn of (saved?.turns ?? []).slice(-6)) {
        add("you", turn.prompt);
        add(turn.failed ? "error" : "codex", turn.result);
        if (!turn.failed) add("meta", formatTurnFooter(turn.route, turn.routeNote, turn.usage, turn.durationMs));
        for (const artifact of turn.artifacts ?? []) add("artifact", artifact);
        add("divider", "");
      }
      setStatus(
        saved?.threadId
          ? `Resumed ${saved.id.slice(0, 8)} · /help for commands`
          : "Ready · /help for commands",
      );
    };
    void load().catch((error) => {
      add("error", `Could not load Pace configuration or sessions: ${String(error)}`);
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
    } catch (error) { add("error", `Could not save models: ${String(error)}`); }
  };
  const toggleModel = (name: string) => {
    if (!config) return;
    const found = config.models.find(model => model.model === name);
    const enabled = found?.enabled === false || !found;
    const models = found
      ? config.models.map(model => model.model === name ? { ...model, enabled } : model)
      : [...config.models, { model: name, efforts: ["medium" as const], defaultEffort: "medium" as const, enabled: true }];
    void saveModels(models, `${name} ${enabled ? "enabled" : "disabled"}.`);
  };
  const toggleEffort = (effort: typeof EFFORTS[number]) => {
    if (!config) return;
    const found = config.models.find(model => model.model === menuModel);
    const present = found?.efforts.includes(effort) ?? false;
    if (present && found?.efforts.length === 1) { add("error", "Keep at least one reasoning level; disable the model from the model list."); return; }
    const models = found
      ? config.models.map(model => model.model === menuModel ? { ...model, efforts: present ? model.efforts.filter(value => value !== effort) : [...model.efforts, effort], defaultEffort: model.defaultEffort === effort && present ? model.efforts.find(value => value !== effort) : model.defaultEffort } : model)
      : [...config.models, { model: menuModel, efforts: [effort], defaultEffort: effort, enabled: true }];
    void saveModels(models, `${menuModel}: ${effort} ${present ? "disabled" : "enabled"}.`);
  };
  const activateSession = async (chosen: Session) => {
    try {
      await store.activate(chosen);
      setSession(chosen);
      setResumeMenu(false);
      add("info", `Resumed ${chosen.id.slice(0, 8)} · ${chosen.route.model ?? "Codex default"}`);
      setStatus("Ready");
    } catch (error) { add("error", `Could not activate conversation: ${String(error)}`); }
  };
  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      if (busy) {
        abort.current?.abort();
        setStatus("Cancelling…");
      } else exit();
    }
    if (modelMenu) {
      const size = modelMenu === "models" ? menuModels.length : EFFORTS.length;
      if (key.escape) { setModelMenu(modelMenu === "efforts" ? "models" : undefined); setMenuIndex(0); }
      else if (key.upArrow || key.downArrow || key.tab) setMenuIndex(value => (value + (key.upArrow ? -1 : 1) + size) % size);
      else if (key.return && modelMenu === "models") { setMenuModel(menuModels[menuIndex]!); setModelMenu("efforts"); setMenuIndex(0); }
      else if (input === " " || (key.return && modelMenu === "efforts")) {
        if (modelMenu === "models") toggleModel(menuModels[menuIndex]!);
        else toggleEffort(EFFORTS[menuIndex]!);
      }
      return;
    }
    if (resumeMenu) {
      if (key.escape) setResumeMenu(false);
      else if (key.upArrow || key.downArrow || key.tab) setMenuIndex(value => (value + (key.upArrow ? -1 : 1) + resumeChoices.length) % resumeChoices.length);
      else if (key.return) void activateSession(resumeChoices[menuIndex]!);
      return;
    }
    if (matches.length && (key.upArrow || key.downArrow)) setSelection(value => (value + (key.downArrow ? 1 : -1) + matches.length) % matches.length);
    if (matches.length && key.tab) {
      setDraft(matches[selection] ?? matches[0]!);
      setInputKey(value => value + 1);
    }
  });

  const shell = (command: string) => {
    add('info', `! ${command}`);
    const executable = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'bash';
    try {
      const child = spawn(executable, ['--noprofile', '--norc', '-c', command], { cwd: project, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      shells.current.add(child);
      setShellJobs(value => value + 1);
      let output = ''; let clipped = false; let failed = false;
      const append = (chunk: Buffer) => { const text = chunk.toString('utf8'); const remaining = 32768 - output.length; if (text.length > remaining) clipped = true; if (remaining > 0) output += text.slice(0, remaining); };
      child.stdout.on('data', append); child.stderr.on('data', append);
      child.on('error', error => { failed = true; add('error', `Shell error: ${String(error)}`); });
      child.on('close', code => {
        shells.current.delete(child);
        setShellJobs(value => Math.max(0, value - 1));
        if (!failed) add(code === 0 ? 'info' : 'error', `${output.trimEnd() || '(no output)'}${clipped ? '\n[output truncated]' : ''}\nShell exit ${code ?? 'unknown'}`);
      });
    } catch (error) { add('error', `Shell error: ${String(error)}`); }
  };

  const submit = async (raw: string) => {
    const text = raw.trim();
    if (!text || !session || !config) return;
    if (text === '!') { add('info', shellMode ? '$ !' : '> !'); setShellMode(value => !value); setDraft(''); setInputKey(key => key + 1); add('info', shellMode ? 'Bash mode off.' : 'Bash mode on. Type ! to return to Pace.'); return; }
    if (text.startsWith('! ')) { setDraft(''); setInputKey(key => key + 1); shell(text.slice(2)); return; }
    if (shellMode) { setDraft(''); setInputKey(key => key + 1); shell(text); return; }
    if (busy) { add('info', 'Codex is working. Use ! for Bash or wait; input remains available.'); return; }
    setDraft(''); setSelection(0); setInputKey((key) => key + 1);
    if (text.startsWith("/")) {
      const [command, ...parts] = text.split(/\s+/);
      if (command === "/clear" && !parts.length) {
        onClear();
        setLines([]);
        setClearEpoch(value => value + 1);
        return;
      }
      if (command === "/exit") {
        exit();
        return;
      }
      if (command === "/help") {
        add(
          "info",
          "/models · /auto · /new · /resume · /artifacts · /clear · /exit · ! toggles Bash · ! command runs once · Ctrl+C cancels Codex",
        );
        return;
      }
      if (command === "/auto") {
        // Auto selection uses the enabled model list in the orchestrator.
        const updated = { ...session, routingMode: "auto" as const };
        try {
          await store.save(updated);
          setSession(updated);
          add(
            "info",
            "Auto routing enabled for the next turn.",
          );
        } catch (error) {
          add("error", `Could not save routing mode: ${String(error)}`);
        }
        return;
      }
      if (command === '/models') {
        if (parts.length) { add("error", "Type /models to open the menu."); return; }
        setModelMenu("models");
        setMenuIndex(0);
        return;
      }
      if (command === "/new") {
        const fresh = newSession(project, session.routingMode);
        if (session.routingMode === "manual") fresh.route = session.route;
        try {
          await store.save(fresh);
          setSession(fresh);
          add("info", `New conversation ${fresh.id.slice(0, 8)}`);
          setStatus("Ready");
        } catch (error) {
          add("error", `Could not create conversation: ${String(error)}`);
        }
        return;
      }
      if (command === "/artifacts") {
        try {
          const files = await artifactSnapshot(project);
          add("info", files.size ? [...files.keys()].sort().map(name => `.pace/artifacts/${name}`).join("\n") : "No Markdown artifacts in .pace/artifacts yet.");
        } catch (error) { add("error", `Could not list artifacts: ${String(error)}`); }
        return;
      }
      if (command === "/resume") {
        if (parts.length) { add("error", "Type /resume to open the conversation picker."); return; }
        const saved = await store.list(project);
        if (!saved.length) { add("info", "No saved conversations."); return; }
        setResumeChoices(saved);
        setResumeMenu(true);
        setMenuIndex(0);
        return;
      }
      add("error", `Unknown command ${command}. Use /help.`);
      return;
    }
    if (vexState !== "connected") {
      add("error", "Vex MCP is unavailable. Coding turns are blocked until it reconnects; restart Pace after fixing Vex.");
      return;
    }
    add("you", text);
    setBusy(true);
    setStatus("Starting…");
    const controller = new AbortController();
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
          if (progress.kind === 'route') setStatus(`Using ${modelName(progress.route)}…`);
          if (progress.kind === "error") add("error", progress.text);
          if (progress.kind === "message") {
            setStatus("Finishing response…");
          }
        },
        controller.signal,
      );
      setSession({ ...outcome.session });
      add("codex", outcome.result);
      add("meta", formatTurnFooter(outcome.route, outcome.note, outcome.usage, outcome.durationMs));
      for (const artifact of outcome.artifacts) add("artifact", artifact);
      add("divider", "");
      setStatus("Done");
    } catch (error) {
      add("error", String(error));
      if (error instanceof VexUnavailableError) setVexState("failed");
      setStatus("Failed");
    } finally {
      abort.current = undefined;
      setBusy(false);
    }
  };
  return (
    <Box flexDirection="column" paddingX={1}>
      {vexState === "connecting" || !session || !config ? <Box gap={1}>
        <Text color="green" bold>pace</Text>
        <Text dimColor>{basename(project)}</Text>
        <Text color="yellow">Vex MCP connecting</Text>
      </Box> : null}
      {vexState !== "connecting" && session && config ? <Static key={clearEpoch} items={[{ id: -1, role: "header" as const, text: "", spaceBefore: false }, ...lines]}>
        {(line) => (
          <Box key={line.id} flexDirection="column" marginTop={line.role === "divider" || line.role === "codex" || line.spaceBefore ? 1 : 0}>
            {line.role === "header" ? <Box gap={1}><Text color="green" bold>pace</Text><Text dimColor>{basename(project)}</Text><Text color={vexState === "connected" ? "green" : "red"}>Vex MCP {vexState === "connected" ? "connected" : "unavailable — coding blocked"}</Text></Box>
              : line.role === "you" ? <><Text bold>You</Text><Text>{line.text}</Text></>
              : line.role === "codex" ? <><Text color="green" bold>Pace</Text><Text>{line.text}</Text></>
              : line.role === "divider" ? <Text dimColor>{"─".repeat(Math.max(12, (process.stdout.columns ?? 80) - 2))}</Text>
              : line.role === "meta" ? <Text dimColor>{line.text}</Text>
              : line.role === "artifact" ? <Text color="magenta">Artifact: {line.text}</Text>
              : line.role === "error" ? <Text color="red">Pace: {line.text}</Text>
              : <Text dimColor>{line.text}</Text>}
          </Box>
        )}
      </Static> : null}
      {modelMenu ? <Box flexDirection="column" borderStyle="round" paddingX={1}>
        <Text bold>{modelMenu === "models" ? "Models" : `${menuModel} reasoning levels`}</Text>
        {(modelMenu === "models" ? menuModels : EFFORTS).map((item, index) => {
          const configured = config?.models.find(model => model.model === (modelMenu === "models" ? item : menuModel));
          const enabled = modelMenu === "models" ? !!configured && configured.enabled !== false : !!configured?.efforts.includes(item as typeof EFFORTS[number]);
          return <Text key={item} color={index === menuIndex ? "cyan" : undefined}>{index === menuIndex ? "› " : "  "}{enabled ? "[x]" : "[ ]"} {item}{modelMenu === "models" && configured ? ` · ${configured.efforts.join(", ")}` : ""}</Text>;
        })}
        <Text dimColor>{modelMenu === "models" ? "↑/↓ or Tab select · Space enable/disable · Enter edit reasoning · Esc close" : "↑/↓ or Tab select · Space/Enter toggle · Esc models"}</Text>
      </Box> : null}
      {resumeMenu ? <Box flexDirection="column" borderStyle="round" paddingX={1}>
        <Text bold>Conversations</Text>
        {resumeChoices.map((choice, index) => <Text key={choice.id} color={index === menuIndex ? "cyan" : undefined}>{index === menuIndex ? "› " : "  "}{choice.id.slice(0, 8)} · {choice.updatedAt.slice(0, 16)} · {choice.turns.at(-1)?.prompt ?? "(empty)"}</Text>)}
        <Text dimColor>↑/↓ or Tab select · Enter resume · Esc close</Text>
      </Box> : null}
      {busy || shellJobs ? <Text dimColor>{spinner[tick % spinner.length]} {status}{shellJobs ? ` · ${shellJobs} Bash command${shellJobs === 1 ? '' : 's'} running` : ''}</Text> : null}
      <Box marginTop={1}>
        <Text color="green">{shellMode ? '! ' : '❯ '}</Text>
        <TextInput
          key={inputKey}
          isDisabled={!session || !config || !!modelMenu || resumeMenu}
          defaultValue={draft}
          suggestions={matches.length ? [matches[selection] ?? matches[0]!, ...matches.filter((_, index) => index !== selection)] : undefined}
          onChange={value => { setDraft(value); setSelection(0); }}
          placeholder={modelMenu || resumeMenu ? "Close menu to type" : shellMode ? "Bash command; ! returns to Pace" : vexState !== "connected" ? "Vex unavailable; commands still work" : busy ? "Pace is working; use ! for Bash" : "Ask Pace or type /"}
          onSubmit={(value) => {
            void submit(value);
          }}
        />
      </Box>
      {!modelMenu && !resumeMenu && matches.length > 0 ? <Box flexDirection="column"><Text dimColor>Commands · ↑/↓ select · Tab complete</Text>{matches.map((match, index) => <Text key={match} color={index === selection ? "cyan" : undefined}>{index === selection ? "› " : "  "}{match}</Text>)}</Box> : null}
    </Box>
  );
}
