import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Orchestrator } from '../src/core/orchestrator.js';
import { PaceStore, newSession } from '../src/core/sessions.js';
import { eventProgress, type CodexRunner } from '../src/integrations/codex.js';
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
  const orchestrator = new Orchestrator(store, runner);
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
