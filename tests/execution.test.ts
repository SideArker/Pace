import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Orchestrator } from '../src/core/orchestrator.js';
import { PaceStore, newSession, undoConversationTurn } from '../src/core/sessions.js';
import { AppServerRunner, appServerThreadParams, appServerTurnParams, appUsage, codexOptions, eventProgress, SdkRunner, type CodexRunner, type Progress } from '../src/integrations/codex.js';
import type { Config, Route } from '../src/shared/types.js';
import type { VexRequest } from '../src/core/vex/client.js';
import { decision } from './routing-fixture.js';

let dir: string;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });
const config: Config = { routingMode: 'auto', defaultRoute: { model: 'gpt-6-sol', effort: 'high' }, models: [
  { model: 'gpt-6-luna', efforts: ['low'] }, { model: 'gpt-6-sol', efforts: ['medium', 'high'] },
] };

it('starts a fresh thread with retained history when routing changes model', async () => {
  dir = await mkdtemp(join(tmpdir(), 'pace-test-'));
  const calls: { id?: string; route: Route; prompt: string }[] = [];
  const runner: CodexRunner = { async run(prompt, _project, route, id, progress) {
    calls.push({ id, route, prompt });
    if (!id) await progress({ kind: 'thread', text: 'thread-1' });
    return { threadId: 'thread-1', result: 'done', completed: true };
  } };
  const session = newSession('/example/project', 'auto');
  const store = new PaceStore(dir);
  const vex = { choose: async (request: VexRequest) => decision(request, request.options[0]?.id === 'single' ? 'single' : request.context.originalRequest === 'first' ? '1:high' : '0:low') };
  const orchestrator = new Orchestrator(store, runner, vex);
  await orchestrator.turn('first', session, config, () => {});
  await orchestrator.turn('second', session, config, () => {});
  expect(calls[0]).toMatchObject({ id: undefined, route: { model: 'gpt-6-sol', effort: 'high' } });
  expect(calls[1]).toMatchObject({ id: undefined, route: { model: 'gpt-6-luna', effort: 'low' } });
  expect(calls[1]?.prompt).toContain('"user":"first"');
  expect((await store.latest('/example/project'))?.turns).toHaveLength(2);
});

it('replays only retained turns after undo starts a new Codex thread', async () => {
  dir = await mkdtemp(join(tmpdir(), 'pace-test-'));
  const session = newSession('/example/project', 'auto');
  session.threadId = 'old-thread';
  session.turns = [
    { prompt: 'Keep this request', result: 'Kept answer', at: '2026-01-01' },
    { prompt: 'Remove this request', result: 'Removed answer', at: '2026-01-02' },
  ];
  undoConversationTurn(session);
  let sentPrompt = '';
  let sentThread: string | undefined;
  const runner: CodexRunner = { async run(prompt, _project, _route, threadId) {
    sentPrompt = prompt;
    sentThread = threadId;
    return { threadId: 'new-thread', result: 'done', completed: true };
  } };
  const vex = { choose: async (request: VexRequest) => decision(request, request.options[0]?.id === 'single' ? 'single' : '1:high') };
  await new Orchestrator(new PaceStore(dir), runner, vex).turn('Current request', session, config, () => {});
  expect(sentThread).toBeUndefined();
  expect(sentPrompt).toContain('Keep this request');
  expect(sentPrompt).toContain('Kept answer');
  expect(sentPrompt).not.toContain('Remove this request');
  expect(sentPrompt).not.toContain('Removed answer');
  expect(sentPrompt).toContain('Current request');
  expect(session.threadId).toBe('new-thread');
});

it('runs a read-only scout, reroutes after handoff, and sums stage costs', async () => {
  dir = await mkdtemp(join(tmpdir(), 'pace-test-'));
  const calls: { route: Route; mode?: string; prompt: string; id?: string }[] = [];
  const scoutUsage = { input_tokens: 100, cached_input_tokens: 20, cache_write_input_tokens: 10, output_tokens: 5, reasoning_output_tokens: 3 };
  const mainUsage = { input_tokens: 200, cached_input_tokens: 100, cache_write_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 10 };
  const runner: CodexRunner = { async run(prompt, _project, route, id, _progress, _signal, mode) {
    calls.push({ route, mode, prompt, id });
    return mode === 'side'
      ? { result: JSON.stringify({ summary: 'Edit src/a.ts', findings: [{ path: 'src/a.ts', line: 12, finding: 'Parser is defined here', relevance: 'Target for edit' }], nextSteps: ['Update parser'], checks: ['npm test'], risks: [], privateTrace: 'unshared scout history' }), completed: true, usage: scoutUsage }
      : { result: 'done', completed: true, usage: mainUsage };
  } };
  const requests: VexRequest[] = [];
  const vex = { choose: async (request: VexRequest) => {
    requests.push(request);
    return decision(request, request.options[0]?.id === 'single' ? 'scout' : request.context.stageObjective === 'Read-only repository scout' ? '0:low' : '1:high');
  } };
  const session = newSession('/example/project', 'auto');
  session.threadId = 'existing-main-thread';
  session.turns.push({ prompt: 'We discussed the parser in src/a.ts', result: 'The parser needs an update.', at: new Date().toISOString() });
  const notices: string[] = [];
  const outcome = await new Orchestrator(new PaceStore(dir), runner, vex).turn('Implement feature', session, config, progress => {
    if (progress.kind === 'system') notices.push(progress.text);
  });
  expect(notices).toEqual([
    'Vex routed the scout to GPT-6 Luna Low.',
    'This task will split into two stages: a read-only scout, then completion.',
    'Model changed. Starting a fresh Codex thread with saved successful turns.',
    'Vex routed completion to GPT-6 Sol High.',
    'No skills are active for this conversation.',
  ]);
  expect(session.turns.at(-1)?.systemMessages).toEqual(notices);
  expect(calls.map(call => call.mode)).toEqual(['side', 'main']);
  expect(calls.map(call => call.id)).toEqual([undefined, undefined]);
  expect(calls[0]?.prompt).toContain('We discussed the parser in src/a.ts');
  expect(calls[0]?.route).toEqual({ model: 'gpt-6-luna', effort: 'low' });
  expect(requests[1]?.options.map(option => option.id)).toEqual(['0:low']);
  expect((requests[1]?.context.availableModels as { id: string }[]).map(model => model.id)).toContain('gpt-6-sol');
  expect(calls[1]?.prompt).toContain('Parser is defined here');
  expect(calls[1]?.prompt).toContain('We discussed the parser in src/a.ts');
  expect(calls[1]?.prompt).not.toContain('unshared scout history');
  expect(requests[2]?.context.priorStageHandoff).toContain('src/a.ts');
  expect(requests[2]?.context.priorStageHandoff).not.toContain('unshared scout history');
  expect(outcome.stages[0]?.handoff).toContain('Parser is defined here');
  expect((await new PaceStore(dir).latest('/example/project'))?.turns.at(-1)?.stages?.[0]?.handoff).toContain('Parser is defined here');
  expect(outcome.usage).toMatchObject({ input_tokens: 300, output_tokens: 25 });
  expect(outcome.estimatedCostUsd).toBeCloseTo(outcome.stages[0]!.estimatedCostUsd! + outcome.stages[1]!.estimatedCostUsd!, 12);
  expect(outcome.routing).toHaveLength(3);
});

it('asks for clarification without starting Codex', async () => {
  dir = await mkdtemp(join(tmpdir(), 'pace-test-'));
  const runner: CodexRunner = { async run() { throw new Error('Codex must not run'); } };
  const vex = { choose: async (request: VexRequest) => decision(request, 'clarify') };
  const outcome = await new Orchestrator(new PaceStore(dir), runner, vex).turn('Something', newSession('/example/project', 'auto'), config, () => {});
  expect(outcome.result).toContain('What outcome');
  expect(outcome.stages).toHaveLength(0);
});

it('stops before completion when scout report lacks verifiable findings schema', async () => {
  dir = await mkdtemp(join(tmpdir(), 'pace-test-'));
  let mainRuns = 0;
  const sidePrompts: string[] = [];
  const runner: CodexRunner = { async run(prompt, _project, _route, _id, _progress, _signal, mode) {
    if (mode === 'side') {
      sidePrompts.push(prompt);
      return { result: JSON.stringify({ summary: 'Found code', files: ['src/a.ts'], checks: [], risks: [] }), completed: true };
    }
    mainRuns++;
    return { result: 'unexpected', completed: true };
  } };
  const vex = { choose: async (request: VexRequest) => decision(request, request.options[0]?.id === 'single' ? 'scout' : '0:low') };
  const session = newSession('/example/project', 'auto');
  await expect(new Orchestrator(new PaceStore(dir), runner, vex).turn('Implement feature', session, config, () => {})).rejects.toThrow('Invalid stage handoff');
  expect(mainRuns).toBe(0);
  expect(sidePrompts).toHaveLength(2);
  expect(sidePrompts[1]).toContain('Your previous report was rejected');
  expect(session.turns.at(-1)?.failed).toBe(true);
  expect(session.turns.at(-1)?.stages).toHaveLength(2);
});

it('uses a corrected scout report for the completion stage', async () => {
  dir = await mkdtemp(join(tmpdir(), 'pace-test-'));
  let sideRuns = 0;
  const runner: CodexRunner = { async run(prompt, _project, _route, _id, _progress, _signal, mode) {
    if (mode === 'side') {
      sideRuns++;
      return { result: sideRuns === 1
        ? JSON.stringify({ summary: 'Found code', files: ['src/a.ts'] })
        : JSON.stringify({ summary: 'Found code', findings: [{ path: 'src/a.ts', finding: 'Parser lives here', relevance: 'Edit target' }], nextSteps: ['Edit parser'], checks: [], risks: [] }), completed: true };
    }
    expect(prompt).toContain('Parser lives here');
    return { result: 'done', completed: true };
  } };
  const vex = { choose: async (request: VexRequest) => decision(request, request.options[0]?.id === 'single' ? 'scout' : '0:low') };
  const outcome = await new Orchestrator(new PaceStore(dir), runner, vex).turn('Implement feature', newSession('/example/project', 'auto'), config, () => {});
  expect(sideRuns).toBe(2);
  expect(outcome.stages).toHaveLength(3);
  expect(outcome.stages[1]?.handoff).toContain('Parser lives here');
});

it('passes an actionable read-only plan into the execution stage', async () => {
  dir = await mkdtemp(join(tmpdir(), 'pace-test-'));
  const calls: { mode?: string; prompt: string; route: Route }[] = [];
  const runner: CodexRunner = { async run(prompt, _project, route, _id, _progress, _signal, mode) {
    calls.push({ prompt, route, mode });
    return mode === 'side'
      ? { result: JSON.stringify({ summary: 'Implement parser', findings: [{ path: 'src/parser.ts', line: 4, finding: 'Parser entry point', relevance: 'Change target' }], nextSteps: ['Update parser'], checks: ['npm test'], risks: [] }), completed: true }
      : { result: 'implemented', completed: true };
  } };
  const vex = { choose: async (request: VexRequest) => decision(request, request.options[0]?.id === 'single' ? 'plan_execute' : request.context.stageObjective === 'Read-only implementation plan' ? '0:low' : '1:high') };
  const outcome = await new Orchestrator(new PaceStore(dir), runner, vex).turn('Plan and implement parser', newSession('/example/project', 'auto'), config, () => {});
  expect(calls.map(call => call.mode)).toEqual(['side', 'main']);
  expect(calls[1]?.prompt).toContain('Implement parser');
  expect(outcome.stages.map(stage => stage.route)).toEqual([{ model: 'gpt-6-luna', effort: 'low' }, { model: 'gpt-6-sol', effort: 'high' }]);
});

it('retries invalid decisions once, then exposes error without model fallback', async () => {
  dir = await mkdtemp(join(tmpdir(), 'pace-test-'));
  let calls = 0;
  const runner: CodexRunner = { async run() { throw new Error('Codex must not run'); } };
  const vex = { choose: async () => { calls++; return { choice: 'invalid' }; } };
  await expect(new Orchestrator(new PaceStore(dir), runner, vex).turn('Work', newSession('/example/project', 'auto'), config, () => {})).rejects.toThrow('Invalid Vex routing decision');
  expect(calls).toBe(2);
});

it('records cancellation during routing and never starts Codex', async () => {
  dir = await mkdtemp(join(tmpdir(), 'pace-test-'));
  const controller = new AbortController();
  let started!: () => void;
  const routingStarted = new Promise<void>(resolve => { started = resolve; });
  const routingReleased = new Promise<void>(() => {});
  const runner: CodexRunner = { async run() { throw new Error('Codex must not run'); } };
  const session = newSession('/example/project', 'auto');
  const store = new PaceStore(dir);
  const vex = { choose: async (request: VexRequest) => {
    started();
    await routingReleased;
    return decision(request, 'single');
  } };
  const turn = new Orchestrator(store, runner, vex).turn('work', session, config, () => {}, controller.signal);
  await routingStarted;
  controller.abort();
  await expect(turn).rejects.toMatchObject({ name: 'AbortError' });
  expect(session.turns.at(-1)).toMatchObject({ prompt: 'work', failed: true });
  expect((await store.latest('/example/project'))?.turns.at(-1)?.failed).toBe(true);
});

it('saves cancellation while Vex is connecting before routing begins', async () => {
  dir = await mkdtemp(join(tmpdir(), 'pace-test-'));
  const controller = new AbortController();
  let started!: () => void;
  const connecting = new Promise<void>(resolve => { started = resolve; });
  const session = newSession('/example/project', 'auto');
  const store = new PaceStore(dir);
  const runner: CodexRunner = { async run() { throw new Error('Codex must not run'); } };
  const vex = {
    async verify() { started(); await new Promise<void>(() => {}); },
    async choose() { throw new Error('Routing must not start'); },
  };
  const turn = new Orchestrator(store, runner, vex).turn('work', session, config, () => {}, controller.signal);
  await connecting;
  controller.abort();
  await expect(turn).rejects.toMatchObject({ name: 'AbortError' });
  expect((await store.latest('/example/project'))?.turns.at(-1)).toMatchObject({
    prompt: 'work', result: 'Turn cancelled by user', failed: true, cancelled: true,
  });
});

it('runs a saved manual route when Vex is unavailable', async () => {
  dir = await mkdtemp(join(tmpdir(), 'pace-test-'));
  const session = newSession('/example/project', 'manual');
  session.route = { model: 'gpt-6-sol', effort: 'high' };
  const routes: Route[] = [];
  const runner: CodexRunner = { async run(_prompt, _project, route) {
    routes.push(route);
    return { result: 'done', completed: true };
  } };
  const vex = {
    async verify() { throw new Error('Vex offline'); },
    async choose() { throw new Error('Vex offline'); },
  };
  const result = await new Orchestrator(new PaceStore(dir), runner, vex).turn('work', session, config, () => {});
  expect(result.result).toBe('done');
  expect(routes).toEqual([session.route]);
});

it('rejects disabled models and lets manual mode keep its route', async () => {
  dir = await mkdtemp(join(tmpdir(), 'pace-test-'));
  const routes: Route[] = [];
  const runner: CodexRunner = { async run(_prompt, _project, route) { routes.push(route); return { result: 'done', completed: true }; } };
  const session = newSession('/example/project', 'manual');
  session.route = { model: 'gpt-6-sol', effort: 'high' };
  const orchestrator = new Orchestrator(new PaceStore(dir), runner, { choose: async () => { throw new Error('No Vex routing in manual mode'); } });
  await orchestrator.turn('work', session, config, () => {});
  expect(routes).toEqual([session.route]);
  await expect(orchestrator.turn('work', session, { ...config, models: [{ model: 'gpt-6-luna', efforts: ['low'] }] }, () => {})).rejects.toThrow('no longer enabled');
});

it('exposes SDK activity with stable IDs and the available reasoning summary', () => {
  expect(eventProgress({ type: 'item.started', item: { id: 'x', type: 'command_execution', command: 'test', aggregated_output: '', status: 'in_progress' } })).toMatchObject({ kind: 'activity', id: 'x', completed: false });
  expect(eventProgress({ type: 'item.completed', item: { id: 'thought', type: 'reasoning', text: 'Checking files' } })).toMatchObject({ category: 'thinking', detail: 'Checking files' });
});

it('uses Codex app-server sandbox values for threads and turns', () => {
  const usage = { input_tokens: 20, cached_input_tokens: 4, cache_write_input_tokens: 0, output_tokens: 8, reasoning_output_tokens: 2 };
  expect(appUsage({ last: { inputTokens: 20, cachedInputTokens: 4, outputTokens: 8, reasoningOutputTokens: 2 } })).toEqual(usage);
  expect(appServerThreadParams('/project', { model: 'gpt-6-luna', effort: 'low' }, undefined, 'side')).toMatchObject({ approvalPolicy: 'never', sandbox: 'read-only' });
  expect(appServerThreadParams('/project', { model: 'gpt-6-sol', effort: 'high' }, 'thread-1', 'main')).toMatchObject({ threadId: 'thread-1', approvalPolicy: 'on-request', sandbox: 'workspace-write' });
  const side = appServerTurnParams('scout', '/project', { model: 'gpt-6-luna', effort: 'low' }, 'thread-1', 'side', ['/trusted']);
  expect(side).toMatchObject({ approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly', networkAccess: false }, input: [{ type: 'text', text: 'scout' }] });
  expect(JSON.stringify(side)).not.toContain('/trusted');
  const main = appServerTurnParams('work', '/project', { model: 'gpt-6-sol', effort: 'high' }, 'thread-1', 'main', ['/trusted']);
  expect(main).toMatchObject({ approvalPolicy: 'on-request', sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['/project', '/trusted'], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false } });
});

it('ends an active turn when Codex app-server exits', async () => {
  let exit!: (error: Error) => void;
  const server = {
    setRequestHandler() {},
    notify() {},
    respond() {},
    kill() {},
    async request(method: string) {
      if (method === 'thread/start') return { thread: { id: 'thread-1' } };
      if (method === 'turn/start') queueMicrotask(() => exit(new Error('App Server exited')));
      return {};
    },
  };
  const runner = new AppServerRunner((_message, onExit) => {
    exit = onExit;
    return server;
  });
  await expect(runner.run('work', process.cwd(), { model: 'gpt-6-sol', effort: 'high' }, undefined, () => {}))
    .rejects.toThrow('App Server exited');
});

it('shows file path and diff as soon as app-server updates the patch', async () => {
  const changes = [{ path: join(process.cwd(), 'src', 'example.ts'), kind: 'update', diff: '@@ -1 +1 @@\n-old\n+new' }];
  const progress: Progress[] = [];
  const runner = new AppServerRunner((onMessage) => ({
    setRequestHandler() {}, notify() {}, respond() {}, kill() {},
    async request(method: string) {
      if (method === 'thread/start') return { thread: { id: 'thread-1' } };
      if (method === 'turn/start') queueMicrotask(() => {
        onMessage({ method: 'item/fileChange/patchUpdated', params: { itemId: 'edit-1', changes } });
        onMessage({ method: 'item/completed', params: { item: { type: 'fileChange', id: 'edit-1', changes, status: 'completed' } } });
        onMessage({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
      });
      return {};
    },
  }));
  await runner.run('edit', process.cwd(), { model: 'gpt-6-sol', effort: 'high' }, undefined, event => { progress.push(event); });
  const edits = progress.filter(event => event.kind === 'activity' && event.category === 'files');
  expect(edits).toHaveLength(2);
  expect(edits[0]).toMatchObject({ title: `Edited ${join('src', 'example.ts')}`, detail: '@@ -1 +1 @@\n-old\n+new', completed: false });
  expect(edits[1]).toMatchObject({ title: `Edited ${join('src', 'example.ts')}`, completed: true });
});

it('gives Codex independent Vex MCP access without key in command arguments', () => {
  expect(codexOptions('/installed/vex/dist/index.js')).toEqual({ config: { mcp_servers: { vex: { command: process.execPath, args: ['/installed/vex/dist/index.js', 'mcp', 'serve'], env_vars: ['OPENROUTER_API_KEY'] } } } });
});

it('delivers every streamed SDK event to benchmark observer', async () => {
  const seen: string[] = [];
  const runner = new SdkRunner({}, async event => { seen.push(event.type); });
  const thread = { id: 'thread-1', async runStreamed() { return { events: (async function* () {
    yield { type: 'item.completed', item: { type: 'agent_message', id: 'message-1', text: 'done' } };
    yield { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } };
  })() }; } };
  (runner as unknown as { codex: { startThread: () => typeof thread } }).codex = { startThread: () => thread };
  await runner.run('work', process.cwd(), { model: 'gpt-6-sol', effort: 'high' }, undefined, () => {});
  expect(seen).toEqual(['item.completed', 'turn.completed']);
});
