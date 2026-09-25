import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
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
  expect((await store.latest('/example/project'))?.turns).toHaveLength(2);
});
it('renders real event statuses but never reasoning', () => {
  expect(eventProgress({ type: 'item.started', item: { id: 'x', type: 'command_execution', command: 'test', aggregated_output: '', status: 'in_progress' } })).toEqual({ kind: 'status', text: 'Running command…' });
  expect(eventProgress({ type: 'item.completed', item: { id: 'x', type: 'reasoning', text: 'hidden' } })).toBeUndefined();
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
  session.route = { model: 'blocked', effort: 'medium' };
  await expect(new Orchestrator(store, runner, vex).turn('again', session, config, () => {})).rejects.toThrow('disabled');
});
it('reads usage from the SDK turn-completed event', async () => {
  const usage = { input_tokens: 20, cached_input_tokens: 4, cache_write_input_tokens: 0, output_tokens: 8, reasoning_output_tokens: 2 };
  const thread = { id: 'thread-1', async runStreamed() { return { events: (async function* () {
    yield { type: 'thread.started', thread_id: 'thread-1' };
    yield { type: 'item.completed', item: { type: 'agent_message', id: 'msg-1', text: 'done' } };
    yield { type: 'turn.completed', usage };
  })() }; } };
  const runner = new SdkRunner();
  let options: unknown;
  (runner as unknown as { codex: { startThread: (value: unknown) => typeof thread } }).codex = { startThread: value => { options = value; return thread; } };
  const result = await runner.run('work', '/example/project', { model: 'configured', effort: 'medium' }, undefined, () => {});
  expect(result).toMatchObject({ threadId: 'thread-1', result: 'done', usage });
  expect(options).toMatchObject({ workingDirectory: '/example/project', sandboxMode: 'workspace-write', approvalPolicy: 'never', networkAccessEnabled: false, model: 'configured', modelReasoningEffort: 'medium' });
});
it('gives Codex an independent Vex MCP launch without exposing the key value', () => {
  expect(codexOptions('/installed/vex/dist/index.js')).toEqual({ config: { mcp_servers: { vex: { command: process.execPath, args: ['/installed/vex/dist/index.js', 'mcp', 'serve'], env_vars: ['OPENROUTER_API_KEY'] } } } });
  expect(codexOptions(undefined)).toEqual({});
});
