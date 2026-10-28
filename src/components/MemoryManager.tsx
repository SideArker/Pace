import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { TextInput } from '@inkjs/ui';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { BASIC_MEMORY_VERSION, memoryRoot, type MemoryState } from '../core/memory/config.js';
import { memorySetupService, type MemorySetupService } from '../core/memory/setup.js';

type Screen = 'loading' | 'intro' | 'installation' | 'location' | 'path' | 'review' | 'panel';
export function MemoryManager({ project, baseDir, width, height, onClose, service = memorySetupService }: {
  project: string; baseDir: string; width: number; height: number; onClose: () => void; service?: MemorySetupService;
}) {
  const [state, setState] = useState<MemoryState>({ state: 'unconfigured' });
  const [screen, setScreen] = useState<Screen>('loading'), [index, setIndex] = useState(0);
  const [detected, setDetected] = useState<Awaited<ReturnType<MemorySetupService['detect']>>>({});
  const [directory, setDirectory] = useState(''), [existing, setExisting] = useState(false);
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [output, setOutput] = useState('');
  const [message, setMessage] = useState('');
  const mounted = useRef(false), operation = useRef<AbortController | undefined>(undefined);
  const go = (next: Screen) => { setScreen(next); setIndex(0); setError(''); };
  const perform = async (label: string, action: (signal: AbortSignal) => Promise<void>) => {
    if (operation.current) return;
    const controller = new AbortController(); operation.current = controller; setBusy(label); setError('');
    try { await action(controller.signal); }
    catch (failure) { if (mounted.current) setError(String(failure)); }
    finally { if (operation.current === controller) operation.current = undefined; if (mounted.current) setBusy(''); }
  };
  const log = (text: string) => { if (mounted.current) setOutput(value => (value + text).slice(-3000)); };
  const detect = async (signal: AbortSignal) => {
    const result = await service.detect(baseDir, signal);
    if (!mounted.current) return;
    setDetected(result); go(result.executable ? 'location' : 'installation');
  };
  useEffect(() => {
    mounted.current = true;
    void perform('Checking project memory…', async signal => {
      const loaded = await service.load(project, baseDir);
      if (!mounted.current) return;
      setState(loaded);
      if (loaded.config && loaded.state === 'ready') {
        try { await service.check(loaded.config, signal); }
        catch (failure) { if (!signal.aborted) setState({ ...loaded, state: 'unavailable', error: String(failure) }); }
      }
      if (mounted.current) go(loaded.state === 'unconfigured' || loaded.state === 'configuring' ? 'intro' : 'panel');
    });
    return () => { mounted.current = false; operation.current?.abort(); };
  }, [project, baseDir, service]);
  const choices = screen === 'intro' ? ['Set up project memory', 'Cancel']
    : screen === 'installation' ? ['Use isolated Basic Memory installation (uv)', 'Check installation again', 'Cancel']
    : screen === 'location' ? ['Create a new memory directory', 'Use an existing notes directory', 'Cancel']
    : screen === 'review' ? ['Configure and check connection', 'Back', 'Cancel']
    : screen === 'panel' ? [state.config?.enabled ? 'Disable memory' : 'Enable memory', 'Repair / check existing connection', 'Reconfigure memory', 'Close'] : [];
  useInput((input, key) => {
    if (key.escape || key.ctrl && input === 'c') {
      if (operation.current) { operation.current.abort(); setMessage('Cancelled. Existing notes/configuration and any installed runtime are preserved. An incomplete setup may leave files under ~/.pace/memory.'); }
      else onClose();
      return;
    }
    if (busy || !choices.length) return;
    if (key.upArrow || key.downArrow || key.tab) { setIndex(value => (value + (key.upArrow || key.shift ? -1 : 1) + choices.length) % choices.length); return; }
    if (!key.return) return;
    if (screen === 'intro') { if (index) onClose(); else void perform('Detecting Basic Memory and runtime…', detect); }
    else if (screen === 'installation') {
      if (index === 2) onClose();
      else if (index === 1) void perform('Detecting installation…', detect);
      else if (!detected.uv) setError('uv is not installed. Install uv using its official instructions, then select Check installation again. No sudo is needed.');
      else go('location');
    } else if (screen === 'location') {
      if (index === 2) onClose();
      else { setExisting(index === 1); setDirectory(index ? '' : join(memoryRoot(baseDir), 'notes', randomUUID())); go('path'); }
    } else if (screen === 'review') {
      if (index === 2) onClose(); else if (index === 1) go('location');
      else void perform('Configuring and checking project…', async signal => {
        const executable = detected.executable ?? await service.install(detected.uv!, baseDir, signal, log);
        if (!detected.executable && mounted.current) setMessage(`Installed runtime remains at ${executable} if setup is cancelled.`);
        const config = await service.setup(project, directory, executable, baseDir, signal, log);
        if (mounted.current) { setState({ state: 'ready', config }); setMessage('Saved. Changes apply to the next agent launch; active agents keep their starting scope.'); go('panel'); }
      });
    } else if (screen === 'panel') {
      if (index === 3) onClose();
      else if (index === 2) go('intro');
      else if (!state.config) setError('Configuration is invalid. Reconfigure explicitly; existing notes will be preserved.');
      else if (index === 0) void perform('Saving setting…', async () => {
        const config = await service.toggle(state.config!, !state.config!.enabled, baseDir);
        if (mounted.current) { setState({ state: config.enabled ? 'ready' : 'disabled', config }); setMessage('Saved for the next agent launch. Notes are preserved.'); }
      });
      else void perform('Checking existing project…', async signal => {
        const config = await service.repair(state.config!, baseDir, signal);
        if (mounted.current) { setState({ state: config.enabled ? 'ready' : 'disabled', config }); setMessage('Existing project connection verified.'); }
      });
    }
  });
  return <Box flexDirection="column" width={width} height={Math.max(10, height)} paddingX={1} overflowY="hidden">
    <Text bold color="#A5B4FC">Project memory · {screen === 'panel' ? state.state : 'setup'}</Text>
    {screen === 'intro' ? <><Text>Optional local Basic Memory for this project. Pace controls project scope, agent roles and provenance.</Text><Text>Notes remain yours. Cancel and disable preserve them. Current code and user instructions take precedence over historical memory.</Text>{state.state === 'configuring' ? <Text color="yellow">Previous setup is incomplete; it is not an empty ready database.</Text> : null}</> : null}
    {screen === 'installation' ? <><Text>Basic Memory {BASIC_MEMORY_VERSION} requires Python ≥3.12 and is licensed AGPL-3.0-or-later.</Text><Text>Installation uses uv in {memoryRoot(baseDir)}/runtime. It may download Python, packages and a local embedding model. Ordinary npm install never does this.</Text><Text>uv: {detected.uv ?? 'missing'} · Python: {detected.python ?? 'not detected'}</Text></> : null}
    {screen === 'path' ? <><Text>{existing ? 'Existing notes directory (must exist)' : 'New notes directory'} · Enter empty for {directory || 'no default'}</Text><TextInput key={String(existing)} onSubmit={value => {
      const chosen = value.trim() ? resolve(value.trim()) : directory;
      if (!chosen) { setError('Enter a directory path'); return; }
      void perform('Checking directory…', async () => {
        if (existing && !await stat(chosen).then(info => info.isDirectory()).catch(() => false)) throw new Error('The existing notes directory must exist');
        if (mounted.current) { setDirectory(chosen); go('review'); }
      });
    }} /></> : null}
    {screen === 'review' ? <><Text>Project: {project}</Text><Text>Notes: {directory}</Text><Text>Backend: {detected.executable ?? `Install Basic Memory ${BASIC_MEMORY_VERSION} with uv under ${memoryRoot(baseDir)}/runtime`}</Text><Text>Pace will create a separate backend configuration and index this directory. A uniquely named temporary write/read probe is deleted after checking. Previous ready settings remain until success.</Text></> : null}
    {screen === 'panel' ? <><Text>Backend: Basic Memory {BASIC_MEMORY_VERSION}</Text><Text>Project: {state.config?.backendProject ?? 'configuration unavailable'}</Text><Text>Location: {state.config?.dataDirectory ?? 'unknown'}</Text><Text>{state.error ?? 'Zero notes is a valid ready database. Enable/disable preserves all notes.'}</Text></> : null}
    {busy ? <Text color="yellow">{busy} · Esc cancels</Text> : choices.map((choice, i) => <Text key={choice} color={index === i ? '#59E6A7' : undefined}>{index === i ? '❯' : ' '} {choice}</Text>)}
    {error ? <Text color="red">{error}</Text> : null}{message ? <Text>{message}</Text> : null}
    {output ? <Text dimColor>{output.split('\n').slice(-Math.max(1, Math.min(4, height - 14))).join('\n')}</Text> : null}
    <Box flexGrow={1}/><Text dimColor>↑/↓ select · Enter choose · Esc {busy ? 'cancel operation' : 'close'}</Text>
  </Box>;
}
