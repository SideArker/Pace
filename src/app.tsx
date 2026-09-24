import React, { useEffect, useRef, useState } from 'react';
import { Box, Static, Text, useApp, useInput } from 'ink';
import { TextInput } from '@inkjs/ui';
import type { Config, Session, Route } from './types.js';
import { PaceStore, newSession } from './core/sessions.js';
import { Orchestrator } from './core/orchestrator.js';
import { SdkRunner } from './integrations/codex.js';
import { validRoute } from './config.js';

type Line = { id: number; role: 'you' | 'codex' | 'info' | 'error'; text: string };
const project = process.cwd();
const store = new PaceStore();
const orchestrator = new Orchestrator(store, new SdkRunner());

export default function App() {
  const { exit } = useApp();
  const [config, setConfig] = useState<Config>();
  const [session, setSession] = useState<Session>();
  const [lines, setLines] = useState<Line[]>([]);
  const [status, setStatus] = useState('Loading…');
  const [busy, setBusy] = useState(false);
  const [inputKey, setInputKey] = useState(0);
  const nextId = useRef(0);
  const abort = useRef<AbortController | undefined>(undefined);
  const add = (role: Line['role'], text: string) => setLines(old => [...old, { id: nextId.current++, role, text }]);
  useEffect(() => {
    let active = true;
    const load = async () => {
      const notices: string[] = [];
      const localStore = new PaceStore(undefined, message => notices.push(message));
      const loaded = await localStore.loadConfig();
      const saved = await localStore.latest(project);
      if (!active) return;
      setConfig(loaded); setSession(saved ?? newSession(project, loaded.routingMode));
      for (const notice of notices) add('error', notice);
      for (const turn of (saved?.turns ?? []).slice(-6)) { add('you', turn.prompt); add(turn.failed ? 'error' : 'codex', turn.result); }
      setStatus(saved?.threadId ? `Resumed ${saved.id.slice(0, 8)} · /help for commands` : 'Ready · /help for commands');
    };
    void load().catch(error => { add('error', String(error)); setStatus('Storage unavailable'); });
    return () => { active = false; };
  }, []);
  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      if (busy) { abort.current?.abort(); setStatus('Cancelling…'); }
      else exit();
    }
  });

  const submit = async (raw: string) => {
    const text = raw.trim();
    setInputKey(key => key + 1);
    if (!text || busy || !session || !config) return;
    if (text.startsWith('/')) {
      const [command, ...parts] = text.split(/\s+/);
      if (command === '/exit') { exit(); return; }
      if (command === '/help') { add('info', '/model [name [effort]] · /auto · /new · /resume [id] · /exit · Ctrl+C cancels a running turn'); return; }
      if (command === '/model') {
        if (!parts.length) {
          add('info', config.models.length ? `Configured: ${config.models.map(m => `${m.model} (${m.efforts.join(', ')})`).join('; ')}. Current: ${session.route.model ?? 'Codex default'}` : `No models configured. Edit ${store.baseDir}/config.json; SDK default is active.`);
          return;
        }
        const route: Route = { model: parts[0], effort: parts[1] as Route['effort'] };
        if (!validRoute(route, config.models) || !route.model) { add('error', 'Model or effort is not in config.json'); return; }
        if (session.threadId) { add('error', 'Use /new before changing models; the current Codex thread keeps its saved route.'); return; }
        const updated = { ...session, route, routingMode: 'manual' as const };
        try { await store.save(updated); setSession(updated); add('info', `Manual route: ${route.model}${route.effort ? ` · ${route.effort}` : ''}`); }
        catch (error) { add('error', `Could not save route: ${String(error)}`); }
        return;
      }
      if (command === '/auto') {
        const updated = { ...session, routingMode: 'auto' as const };
        try { await store.save(updated); setSession(updated); add('info', session.threadId ? 'Auto enabled for a new thread; this thread keeps its saved route.' : 'Auto routing enabled.'); }
        catch (error) { add('error', `Could not save routing mode: ${String(error)}`); }
        return;
      }
      if (command === '/new') {
        const fresh = newSession(project, session.routingMode);
        if (session.routingMode === 'manual') fresh.route = session.route;
        try { await store.save(fresh); setSession(fresh); add('info', `New conversation ${fresh.id.slice(0, 8)}`); setStatus('Ready'); }
        catch (error) { add('error', `Could not create conversation: ${String(error)}`); }
        return;
      }
      if (command === '/resume') {
        const saved = await store.list(project);
        if (!parts.length) { add('info', saved.length ? saved.map(s => `${s.id.slice(0, 8)} · ${s.updatedAt.slice(0, 16)} · ${s.turns.at(-1)?.prompt ?? '(empty)'}`).join('\n') : 'No saved conversations.'); return; }
        const matches = saved.filter(s => s.id.startsWith(parts[0]!));
        if (matches.length !== 1) { add('error', 'Use a unique session ID prefix from /resume.'); return; }
        try { await store.activate(matches[0]!); setSession(matches[0]); add('info', `Resumed ${matches[0]!.id.slice(0, 8)} · ${matches[0]!.route.model ?? 'Codex default'}`); setStatus('Ready'); }
        catch (error) { add('error', `Could not activate conversation: ${String(error)}`); }
        return;
      }
      add('error', `Unknown command ${command}. Use /help.`); return;
    }
    setBusy(true); add('you', text); setStatus('Starting…');
    const controller = new AbortController(); abort.current = controller;
    let streamedResult = '';
    try {
      const outcome = await orchestrator.turn(text, session, config, progress => {
        if (progress.kind === 'status') { setStatus(progress.text); setSession({ ...session }); }
        if (progress.kind === 'error') add('error', progress.text);
        if (progress.kind === 'message') { streamedResult = progress.text; add('codex', progress.text); }
      }, controller.signal);
      setSession({ ...outcome.session }); if (outcome.result !== streamedResult) add('codex', outcome.result); setStatus('Done');
    } catch (error) { add('error', String(error)); setStatus('Failed'); }
    finally { abort.current = undefined; setBusy(false); }
  };
  return <Box flexDirection="column" paddingX={1}>
    <Text color="cyan" bold>pace</Text><Text dimColor>{project} · {session?.routingMode ?? 'auto'} · {session?.route.model ?? 'Codex default'}</Text>
    <Static items={lines}>{line => <Box key={line.id} flexDirection="column"><Text color={line.role === 'error' ? 'red' : line.role === 'you' ? 'cyan' : undefined}>{line.role === 'you' ? '> ' : line.role === 'codex' ? '  ' : '· '}{line.text}</Text></Box>}</Static>
    <Text dimColor>{status}</Text>
    <Box><Text color="cyan">&gt; </Text><TextInput key={inputKey} isDisabled={busy || !session || !config} placeholder={busy ? 'Working…' : 'Ask Codex or type /help'} onSubmit={value => { void submit(value); }} /></Box>
  </Box>;
}
