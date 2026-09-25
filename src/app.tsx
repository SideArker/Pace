import React, { useEffect, useRef, useState } from "react";
import { Box, Static, Text, useApp, useInput } from "ink";
import { TextInput } from "@inkjs/ui";
import type { Config, Session, Route } from "./types.js";
import { PaceStore, newSession } from "./core/sessions.js";
import { Orchestrator } from "./core/orchestrator.js";
import { SdkRunner } from "./integrations/codex.js";
import { EFFORTS, parseConfig, validRoute } from "./config.js";
import { spawn } from "node:child_process";

type Line = {
  id: number;
  role: "you" | "codex" | "info" | "error";
  text: string;
  route?: Route;
};
const commands = ["/help", "/model", "/models", "/auto", "/new", "/resume", "/exit"];
const spinner = ["◐", "◓", "◑", "◒"];
const routeLabel = (route?: Route) => `${route?.model ?? "Codex default"} · reasoning ${route?.effort ?? "Codex default"}`;
const usageLabel = (usage: NonNullable<Awaited<ReturnType<SdkRunner['run']>>['usage']>) =>
  `Turn tokens: input ${usage.input_tokens}, cached input ${usage.cached_input_tokens}, cache write ${usage.cache_write_input_tokens}, output ${usage.output_tokens}, reasoning output ${usage.reasoning_output_tokens}`;
const project = process.cwd();
const store = new PaceStore();
const orchestrator = new Orchestrator(store, new SdkRunner());

export default function App() {
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
  const nextId = useRef(0);
  const abort = useRef<AbortController | undefined>(undefined);
  const shells = useRef(new Set<{ kill: () => boolean }>());
  const add = (role: Line["role"], text: string, route?: Route) =>
    setLines((old) => [...old, { id: nextId.current++, role, text, route }]);
  const matches = !shellMode && draft.startsWith('/') && !draft.includes(' ') ? commands.filter(command => command.startsWith(draft)) : [];
  useEffect(() => {
    if (!busy && shellJobs === 0) return;
    const timer = setInterval(() => setTick(value => value + 1), 250);
    return () => clearInterval(timer);
  }, [busy, shellJobs]);
  useEffect(() => () => { for (const child of shells.current) child.kill(); }, []);
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
        add("you", turn.prompt, turn.route);
        add(turn.failed ? "error" : "codex", turn.result, turn.route);
        if (turn.usage) add("info", usageLabel(turn.usage));
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
  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      if (busy) {
        abort.current?.abort();
        setStatus("Cancelling…");
      } else exit();
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
      add('info', `> ${text}`);
      const [command, ...parts] = text.split(/\s+/);
      if (command === "/exit") {
        exit();
        return;
      }
      if (command === "/help") {
        add(
          "info",
          "/model [name [effort]] · /models [add name effort|name on|off] · /auto · /new · /resume [id] · /exit · ! toggles Bash · ! command runs once · Ctrl+C cancels Codex",
        );
        return;
      }
      if (command === "/model") {
        if (!parts.length) {
          add(
            "info",
            config.models.length
              ? `Configured models:\n${config.models.map((m) => `  ${m.model} · ${m.enabled === false ? 'off' : 'on'} · efforts: ${m.efforts.join(", ")}`).join("\n")}\nCurrent: ${routeLabel(session.route)}. Use /model <name> [effort] or /models <name> on|off.`
              : `No models configured; Codex chooses its default. Add one with /models add gpt-6-sol medium. Other documented IDs include gpt-6-luna and gpt-6-astra; account access varies.`,
          );
          return;
        }
        const selectedModel = config.models.find(item => item.model === parts[0]);
        const route: Route = {
          model: parts[0],
          effort: (parts[1] ?? selectedModel?.defaultEffort ?? selectedModel?.efforts[0]) as Route["effort"],
        };
        if (parts[1] === 'max') { add('error', 'Reasoning effort max is not supported by Pace. Use /model to list configured efforts.'); return; }
        if (selectedModel?.enabled === false) { add('error', `${selectedModel.model} is off. Use /models ${selectedModel.model} on.`); return; }
        if (!validRoute(route, config.models.filter(model => model.enabled !== false)) || !route.model) {
          add("error", "Model or effort is not configured. Use /model to list choices.");
          return;
        }
        if (session.threadId) {
          add(
            "error",
            "Use /new before changing models; the current Codex thread keeps its saved route.",
          );
          return;
        }
        const updated = { ...session, route, routingMode: "manual" as const };
        try {
          await store.save(updated);
          setSession(updated);
          add(
            "info",
            `Manual route: ${route.model}${route.effort ? ` · ${route.effort}` : ""}`,
          );
        } catch (error) {
          add("error", `Could not save route: ${String(error)}`);
        }
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
            session.threadId
              ? "Auto enabled for a new thread; this thread keeps its saved route."
              : "Auto routing enabled.",
          );
        } catch (error) {
          add("error", `Could not save routing mode: ${String(error)}`);
        }
        return;
      }
      if (command === '/models') {
        if (!parts.length) {
          add('info', config.models.length ? config.models.map(model => `${model.model}: ${model.enabled === false ? 'off' : 'on'} (${model.efforts.join(', ')})`).join('\n') + '\nUse /models add <name> <effort> or /models <name> on|off.' : 'No models configured. Use /models add gpt-6-sol medium. Other documented IDs: gpt-6-luna, gpt-6-astra; access varies.');
          return;
        }
        if (parts[0] === 'add') {
          const name = parts[1];
          const effort = parts[2];
          if (parts.length !== 3 || !name || !effort || !EFFORTS.includes(effort as typeof EFFORTS[number])) { add('error', `Use /models add <name> <effort>. Supported efforts: ${EFFORTS.join(', ')}.`); return; }
          const existing = config.models.find(item => item.model === name);
          const models = existing
            ? config.models.map(item => item.model === name ? { ...item, enabled: true, defaultEffort: effort as typeof EFFORTS[number], efforts: [...new Set([...item.efforts, effort as typeof EFFORTS[number]])] } : item)
            : [...config.models, { model: name, efforts: [effort as typeof EFFORTS[number]], defaultEffort: effort as typeof EFFORTS[number], enabled: true }];
          try { const updated = parseConfig({ ...config, models }); await store.saveConfig(updated); setConfig(updated); add('info', `${name} enabled with ${effort} available.`); }
          catch (error) { add('error', `Could not add model: ${String(error)}`); }
          return;
        }
        const model = config.models.find(item => item.model === parts[0]);
        if (!model || !['on', 'off'].includes(parts[1] ?? '') || parts.length !== 2) { add('error', 'Use /models <configured-name> on|off.'); return; }
        const updated: Config = { ...config, models: config.models.map(item => item.model === model.model ? { ...item, enabled: parts[1] === 'on' } : item) };
        try { await store.saveConfig(updated); setConfig(updated); add('info', `${model.model} ${parts[1]}. ${parts[1] === 'off' && session.threadId && session.route.model === model.model ? 'Current thread cannot continue while this model is off; use /new or turn it on.' : ''}`.trim()); }
        catch (error) { add('error', `Could not save models: ${String(error)}`); }
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
      if (command === "/resume") {
        const saved = await store.list(project);
        if (!parts.length) {
          add(
            "info",
            saved.length
              ? saved
                  .map(
                    (s) =>
                      `${s.id.slice(0, 8)} · ${s.updatedAt.slice(0, 16)} · ${s.turns.at(-1)?.prompt ?? "(empty)"}`,
                  )
                  .join("\n")
              : "No saved conversations.",
          );
          return;
        }
        const matches = saved.filter((s) => s.id.startsWith(parts[0]!));
        if (matches.length !== 1) {
          add("error", "Use a unique session ID prefix from /resume.");
          return;
        }
        try {
          await store.activate(matches[0]!);
          setSession(matches[0]);
          add(
            "info",
            `Resumed ${matches[0]!.id.slice(0, 8)} · ${matches[0]!.route.model ?? "Codex default"}`,
          );
          setStatus("Ready");
        } catch (error) {
          add("error", `Could not activate conversation: ${String(error)}`);
        }
        return;
      }
      add("error", `Unknown command ${command}. Use /help.`);
      return;
    }
    setBusy(true);
    setStatus("Starting…");
    const controller = new AbortController();
    abort.current = controller;
    let streamedResult = "";
    let activeRoute: Route | undefined;
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
          if (progress.kind === 'route') { activeRoute = progress.route; add('you', text, activeRoute); }
          if (progress.kind === "error") add("error", progress.text);
          if (progress.kind === "message") {
            streamedResult = progress.text;
            add("codex", progress.text, activeRoute);
          }
        },
        controller.signal,
      );
      setSession({ ...outcome.session });
      if (outcome.result !== streamedResult) add("codex", outcome.result, outcome.route);
      if (outcome.usage) add('info', usageLabel(outcome.usage));
      setStatus("Done");
    } catch (error) {
      if (!activeRoute) add('you', text);
      add("error", String(error));
      setStatus("Failed");
    } finally {
      abort.current = undefined;
      setBusy(false);
    }
  };
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text color="cyan" bold>
        pace
      </Text>
      <Text dimColor>
        {project} · {session?.routingMode ?? "auto"} ·{" "}
        {session?.route.model ?? "Codex default"}
      </Text>
      <Static items={lines}>
        {(line) => (
          <Box key={line.id} flexDirection="column">
            <Text
              color={
                line.role === "error"
                  ? "red"
                  : line.role === "you"
                    ? "cyan"
                    : undefined
              }
            >
              {line.role === "you" ? "> " : line.role === "codex" ? "  " : "· "}
              {line.route && (line.role === 'you' || line.role === 'codex' || line.role === 'error') ? `[${routeLabel(line.route)}] ` : ''}{line.text}
            </Text>
          </Box>
        )}
      </Static>
      <Text dimColor>{busy || shellJobs ? `${spinner[tick % spinner.length]} ` : ''}{status}{shellJobs ? ` · ${shellJobs} Bash command${shellJobs === 1 ? '' : 's'} running` : ''}</Text>
      <Box>
        <Text color="cyan">{shellMode ? '$ ' : '> '}</Text>
        <TextInput
          key={inputKey}
          isDisabled={!session || !config}
          defaultValue={draft}
          suggestions={matches.length ? [matches[selection] ?? matches[0]!, ...matches.filter((_, index) => index !== selection)] : undefined}
          onChange={value => { setDraft(value); setSelection(0); }}
          placeholder={shellMode ? "Bash command; ! returns to Pace" : busy ? "Codex working; use ! for Bash" : "Ask Codex or type /help"}
          onSubmit={(value) => {
            void submit(value);
          }}
        />
      </Box>
      {matches.length > 0 && draft !== matches[selection] ? <Text dimColor>Tab completes · ↑/↓ selects: {matches.map((match, index) => index === selection ? `[${match}]` : match).join('  ')}</Text> : null}
    </Box>
  );
}
