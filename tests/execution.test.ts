import { afterEach, expect, it } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Orchestrator } from '../src/core/orchestrator.js';
import { PaceStore, newSession } from '../src/core/sessions.js';
import { codexOptions, eventProgress, SdkRunner, type CodexRunner } from '../src/integrations/codex.js';
import type { Config, Route } from '../src/shared/types.js';
import type { VexRequest } from '../src/core/vex/client.js';
import { decision } from './routing-fixture.js';

let dir: string;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });
const config: Config = { routingMode: 'auto', defaultRoute: { model: 'gpt-6-sol', effort: 'high' }, models: [
  { model: 'gpt-6-luna', efforts: ['low'] }, { model: 'gpt-6-sol', efforts: ['medium', 'high'] },
] };

it('reroutes each follow-up and resumes its saved main thread', async () => {
  dir = await mkdtemp(join(tmpdir(), 'pace-test-'));
  const calls: { id?: string; route: Route }[] = [];
  const runner: CodexRunner = { async run(_prompt, _project, route, id, progress) {
    calls.push({ id, route });
    if (!id) await progress({ kind: 'thread', text: 'thread-1' });
    return { threadId: 'thread-1', result: 'done', completed: true };
  } };
  const session = newSession('/example/project', 'auto');
  const store = new PaceStore(dir);
  const vex = { choose: async (request: VexRequest) => decision(request, request.options[0]?.id === 'single' ? 'single' : request.context.originalRequest === 'first' ? '1:high' : '0:low') };
  const orchestrator = new Orchestrator(store, runner, vex);
  await orchestrator.turn('first', session, config, () => {});
  await orchestrator.turn('second', session, config, () => {});
  expect(calls).toEqual([{ id: undefined, route: { model: 'gpt-6-sol', effort: 'high' } }, { id: 'thread-1', route: { model: 'gpt-6-luna', effort: 'low' } }]);
  expect((await store.latest('/example/project'))?.turns).toHaveLength(2);
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
  const outcome = await new Orchestrator(new PaceStore(dir), runner, vex).turn('Implement feature', session, config, () => {});
  expect(calls.map(call => call.mode)).toEqual(['side', 'main']);
  expect(calls.map(call => call.id)).toEqual([undefined, 'existing-main-thread']);
  expect(calls[0]?.prompt).toContain('We discussed the parser in src/a.ts');
  expect(calls[0]?.route).toEqual({ model: 'gpt-6-luna', effort: 'low' });
  expect(requests[1]?.options.map(option => option.id)).toEqual(['0:low']);
  expect((requests[1]?.context.availableModels as { id: string }[]).map(model => model.id)).toContain('gpt-6-sol');
  expect(calls[1]?.prompt).toContain('Parser is defined here');
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
  const runner: CodexRunner = { async run(_prompt, _project, _route, _id, _progress, _signal, mode) {
    if (mode === 'side') return { result: JSON.stringify({ summary: 'Found code', files: ['src/a.ts'], checks: [], risks: [] }), completed: true };
    mainRuns++;
    return { result: 'unexpected', completed: true };
  } };
  const vex = { choose: async (request: VexRequest) => decision(request, request.options[0]?.id === 'single' ? 'scout' : '0:low') };
  const session = newSession('/example/project', 'auto');
  await expect(new Orchestrator(new PaceStore(dir), runner, vex).turn('Implement feature', session, config, () => {})).rejects.toThrow('Invalid stage handoff');
  expect(mainRuns).toBe(0);
  expect(session.turns.at(-1)?.failed).toBe(true);
  expect(session.turns.at(-1)?.stages).toHaveLength(1);
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

it('reads usage from SDK completed event and preserves side read-only mode', async () => {
  const usage = { input_tokens: 20, cached_input_tokens: 4, cache_write_input_tokens: 0, output_tokens: 8, reasoning_output_tokens: 2 };
  const thread = { id: 'thread-1', async runStreamed() { return { events: (async function* () {
    yield { type: 'item.completed', item: { type: 'agent_message', id: 'msg-1', text: 'done' } };
    yield { type: 'turn.completed', usage };
  })() }; } };
  const runner = new SdkRunner();
  let options: unknown;
  (runner as unknown as { codex: { startThread: (value: unknown) => typeof thread; resumeThread: (id: string, value: unknown) => typeof thread } }).codex = {
    startThread: value => { options = value; return thread; }, resumeThread: (_id, value) => { options = value; return thread; },
  };
  const path = await realpath(process.cwd());
  expect((await runner.run('work', path, { model: 'gpt-6-sol', effort: 'high' }, undefined, () => {})).usage).toEqual(usage);
  await runner.run('scout', path, { model: 'gpt-6-luna', effort: 'low' }, undefined, () => {}, undefined, 'side');
  expect(options).toMatchObject({ sandboxMode: 'read-only', approvalPolicy: 'never', additionalDirectories: [] });
});

it('gives Codex independent Vex MCP access without key in command arguments', () => {
  expect(codexOptions('/installed/vex/dist/index.js')).toEqual({ config: { mcp_servers: { vex: { command: process.execPath, args: ['/installed/vex/dist/index.js', 'mcp', 'serve'], env_vars: ['OPENROUTER_API_KEY'] } } } });
});
