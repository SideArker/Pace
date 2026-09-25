import { afterEach, expect, it } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Orchestrator } from '../src/core/orchestrator.js';
import { PaceStore, newSession } from '../src/core/sessions.js';
import { codexOptions, eventProgress, SdkRunner, type CodexRunner } from '../src/integrations/codex.js';
import type { Config, Route } from '../src/types.js';
let dir: string;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });
it('resumes the saved SDK thread and route on follow-up', async () => {
  dir = await mkdtemp(join(tmpdir(), 'pace-test-'));
  const store = new PaceStore(dir);
  const calls: { id?: string; route: Route }[] = [];
  const runner: CodexRunner = { async run(_prompt, _project, route, id, progress) {
    calls.push({ id, route });
    if (!id) await progress({ kind: 'thread', text: 'codex-thread-1' });
    return { threadId: 'codex-thread-1', result: 'done', completed: true };
  } };
  const config: Config = { models: [{ model: 'configured', efforts: ['medium'] }], defaultRoute: { model: 'configured', effort: 'medium' }, routingMode: 'auto' };
  const orchestrator = new Orchestrator(store, runner, { verify: async () => {}, choose: async () => undefined });
  const session = newSession('/example/project', 'auto');
  await orchestrator.turn('first', session, config, () => {});
  const restored = (await store.latest('/example/project'))!;
  await orchestrator.turn('second', restored, config, () => {});
  expect(calls).toEqual([{ id: undefined, route: config.defaultRoute }, { id: 'codex-thread-1', route: config.defaultRoute }]);
  const turns = (await store.latest('/example/project'))?.turns;
  expect(turns).toHaveLength(2);
  expect(turns?.[1]?.routeNote).toContain('Auto needs two configured routes');
  expect(turns?.[1]?.durationMs).toEqual(expect.any(Number));
});
it('exposes SDK activity with stable IDs and the available reasoning summary', () => {
  expect(eventProgress({ type: 'item.started', item: { id: 'x', type: 'command_execution', command: 'test', aggregated_output: '', status: 'in_progress' } })).toEqual({ kind: 'activity', id: 'x', category: 'command', title: 'Running: test', detail: '', completed: false });
  expect(eventProgress({ type: 'item.completed', item: { id: 'x', type: 'command_execution', command: 'test', aggregated_output: 'ok', exit_code: 0, status: 'completed' } })).toMatchObject({ kind: 'activity', id: 'x', detail: 'ok', completed: true });
  expect(eventProgress({ type: 'item.completed', item: { id: 'thought', type: 'reasoning', text: 'Checking files' } })).toEqual({ kind: 'activity', id: 'thought', category: 'thinking', title: 'Thinking', detail: 'Checking files', completed: true });
  expect(eventProgress({ type: 'item.completed', item: { id: 'patch', type: 'file_change', changes: [{ kind: 'update', path: 'src/app.tsx' }], status: 'completed' } })).toMatchObject({ category: 'files', detail: 'update src/app.tsx' });
  expect(eventProgress({ type: 'turn.failed', error: { message: 'bad' } })).toEqual({ kind: 'error', text: 'bad' });
});
it('never routes to a disabled model and saves turn usage', async () => {
  dir = await mkdtemp(join(tmpdir(), 'pace-test-'));
  const store = new PaceStore(dir);
  const seen: Route[] = [];
  const usage = { input_tokens: 12, cached_input_tokens: 2, cache_write_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 1 };
  const runner: CodexRunner = { async run(_prompt, _project, route) {
    seen.push(route);
    return { threadId: 'thread-1', result: 'done', completed: true, usage };
  } };
  const config: Config = { routingMode: 'auto', defaultRoute: { model: 'blocked', effort: 'medium' }, models: [
    { model: 'blocked', efforts: ['medium'], enabled: false },
    { model: 'allowed', efforts: ['high'], enabled: true },
  ] };
  const vex = { choose: async () => { throw new Error('Vex should not run for one enabled route'); } };
  const session = newSession('/example/project', 'auto');
  const outcome = await new Orchestrator(store, runner, vex).turn('work', session, config, () => {});
  expect(seen).toEqual([{ model: 'allowed', effort: 'high' }]);
  expect(outcome.usage).toEqual(usage);
  expect((await store.latest('/example/project'))?.turns[0]?.usage).toEqual(usage);
  await expect(new Orchestrator(store, runner, vex).turn('again', session, { ...config, models: config.models.map(model => ({ ...model, enabled: false })) }, () => {})).rejects.toThrow('No models enabled');
  expect(seen).toHaveLength(1);
  session.routingMode = 'manual';
  session.route = { model: 'blocked', effort: 'medium' };
  await expect(new Orchestrator(store, runner, vex).turn('again', session, config, () => {})).rejects.toThrow('disabled');
  session.route = { model: 'allowed', effort: 'high' };
  await expect(new Orchestrator(store, runner, vex).turn('again', session, { ...config, models: [{ model: 'allowed', efforts: ['low'] }] }, () => {})).rejects.toThrow('no longer enabled');
});
it('routes every auto turn while resuming the same Codex thread', async () => {
  dir = await mkdtemp(join(tmpdir(), 'pace-test-'));
  const calls: { id?: string; route: Route }[] = [];
  const runner: CodexRunner = { async run(_prompt, _project, route, id) {
    calls.push({ id, route });
    return { threadId: 'thread-1', result: 'done', completed: true };
  } };
  const config: Config = { routingMode: 'auto', defaultRoute: { model: 'gpt-6-sol', effort: 'medium' }, models: [
    { model: 'gpt-6-luna', efforts: ['low'] }, { model: 'gpt-6-sol', efforts: ['medium'] },
  ] };
  let choices = 0;
  const vex = { verify: async () => {}, choose: async () => {
    choices++;
    return choices === 1
      ? { contractVersion: '1', choice: '1:medium', abstained: false, confidence: .9, probabilities: { '0:low': .1, '1:medium': .9 } }
      : { contractVersion: '1', abstained: true };
  } };
  const session = newSession('/example/project', 'auto');
  const orchestrator = new Orchestrator(new PaceStore(dir), runner, vex);
  await orchestrator.turn('Build a service', session, config, () => {});
  const hello = await orchestrator.turn('hi', session, config, () => {});
  expect(choices).toBe(2);
  expect(calls).toEqual([
    { id: undefined, route: { model: 'gpt-6-sol', effort: 'medium' } },
    { id: 'thread-1', route: { model: 'gpt-6-luna', effort: 'low' } },
  ]);
  expect(hello.note).toContain('Policy fallback');
  expect(session.turns.map(turn => turn.route)).toEqual(calls.map(call => call.route));
});
it('uses Sol high for sensitive architecture after Vex abstains but keeps greetings and factual questions on Luna low', async () => {
  dir = await mkdtemp(join(tmpdir(), 'pace-test-'));
  const seen: Route[] = [];
  const runner: CodexRunner = { async run(_prompt, _project, route) { seen.push(route); return { result: 'done', completed: true }; } };
  const config: Config = { routingMode: 'auto', defaultRoute: { model: 'gpt-6-luna', effort: 'low' }, models: [
    { model: 'gpt-6-luna', efforts: ['low'] },
    { model: 'gpt-6-sol', efforts: ['high', 'xhigh'] },
  ] };
  const vex = { verify: async () => {}, choose: async () => ({ contractVersion: '1', abstained: true }) };
  const orchestrator = new Orchestrator(new PaceStore(dir), runner, vex);
  const hello = await orchestrator.turn('Hello', newSession('/example/project', 'auto'), config, () => {});
  const factual = await orchestrator.turn('Hey, do you mind telling me what mitochondria is used for?', newSession('/example/project', 'auto'), config, () => {});
  const payment = await orchestrator.turn('Plan and build an advanced payment system', newSession('/example/project', 'auto'), config, () => {});
  expect(seen).toEqual([{ model: 'gpt-6-luna', effort: 'low' }, { model: 'gpt-6-luna', effort: 'low' }, { model: 'gpt-6-sol', effort: 'high' }]);
  expect(hello.note).toContain('Policy fallback');
  expect(factual.note).toContain('Policy fallback');
  expect(payment.note).toContain('Policy fallback');
});
it('reads usage from the SDK turn-completed event', async () => {
  const usage = { input_tokens: 20, cached_input_tokens: 4, cache_write_input_tokens: 0, output_tokens: 8, reasoning_output_tokens: 2 };
  let receivedPrompt = '';
  const thread = { id: 'thread-1', async runStreamed(prompt: string) { receivedPrompt = prompt; return { events: (async function* () {
    yield { type: 'thread.started', thread_id: 'thread-1' };
    yield { type: 'item.completed', item: { type: 'agent_message', id: 'msg-1', text: 'done' } };
    yield { type: 'turn.completed', usage };
  })() }; } };
  const runner = new SdkRunner();
  let options: unknown;
  (runner as unknown as { codex: { startThread: (value: unknown) => typeof thread; resumeThread: (id: string, value: unknown) => typeof thread } }).codex = {
    startThread: value => { options = value; return thread; },
    resumeThread: (id, value) => { expect(id).toBe('thread-1'); options = value; return thread; },
  };
  const savedProjectPath = newSession(process.cwd(), 'auto').projectPath;
  const actualProjectPath = await realpath(savedProjectPath);
  const result = await runner.run('Create a planning artifact', savedProjectPath, { model: 'configured', effort: 'medium' }, undefined, () => {});
  expect(result).toMatchObject({ threadId: 'thread-1', result: 'done', usage });
  expect(receivedPrompt).toContain('.pace/artifacts/');
  expect(options).toMatchObject({ workingDirectory: actualProjectPath, sandboxMode: 'workspace-write', approvalPolicy: 'never', networkAccessEnabled: false, model: 'configured', modelReasoningEffort: 'medium' });
  await runner.run('follow-up', savedProjectPath, { model: 'gpt-6-luna', effort: 'low' }, 'thread-1', () => {});
  expect(options).toMatchObject({ model: 'gpt-6-luna', modelReasoningEffort: 'low' });
});
it('gives Codex an independent Vex MCP launch without exposing the key value', () => {
  expect(codexOptions('/installed/vex/dist/index.js')).toEqual({ config: { mcp_servers: { vex: { command: process.execPath, args: ['/installed/vex/dist/index.js', 'mcp', 'serve'], env_vars: ['OPENROUTER_API_KEY'] } } } });
  expect(codexOptions(undefined)).toEqual({});
});
