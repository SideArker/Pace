import { expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { advanceTask, retainedTask } from '../src/core/active-task.js';
import { PaceStore, newSession } from '../src/core/sessions.js';
import { shapeRequest } from '../src/core/vex/client.js';
import { DEFAULT_CONFIG } from '../src/shared/config.js';

it('keeps the original unfinished task beyond Vex recent conversation', () => {
  const session = newSession('/example/project', 'auto');
  session.activeTask = { originalRequest: 'Implement CSV export and tests', instructions: ['Use the existing writer'], latestOutcome: 'Provider failed before edits', failed: true };
  session.turns = Array.from({ length: 12 }, (_, index) => ({ prompt: `Later turn ${index}`, result: `Response ${index}`, at: '2026-10-05' }));
  const task = retainedTask(session)!;
  const state = { activeTask: task, hasCodexThread: true };
  const shape = shapeRequest('Continue', session.turns, DEFAULT_CONFIG.models, undefined, state);
  expect(shape.context.recentConversation).toHaveLength(10);
  expect(shape.context.conversationState).toMatchObject({ activeTask: task });
  const continued = advanceTask(task, 'continue', 'Add a CLI flag', 'Still working', false)!;
  expect(continued.originalRequest).toBe('Implement CSV export and tests');
  expect(continued.instructions).toEqual(['Use the existing writer', 'Add a CLI flag']);
  expect(advanceTask(continued, 'aside', 'What time is it?', 'Now', false)).toBe(continued);
  expect(advanceTask(continued, 'replace', 'Fix login', 'Done', false)?.originalRequest).toBe('Fix login');
});

it('restores the task brief with a saved conversation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pace-task-'));
  try {
    const session = newSession('/example/project', 'auto');
    session.activeTask = advanceTask(undefined, 'replace', 'Implement CSV export', 'Provider failed', true);
    const store = new PaceStore(dir);
    await store.save(session);
    expect((await store.latest('/example/project'))?.activeTask).toEqual(session.activeTask);
    session.deferredTurn = { prompt: 'Continue the task', retryAt: '2026-10-05T20:21:00.000Z', attempt: 1 };
    await store.save(session);
    expect((await store.latest('/example/project'))?.deferredTurn).toEqual(session.deferredTurn);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('does not infer an original task after a clarification-only start', () => {
  const session = newSession('/example/project', 'auto');
  session.turns = [
    { prompt: 'BRO CONTINUE', result: 'usage limit', failed: true, at: '2026-10-05' },
    { prompt: 'Do you have data of what you have been doing? Quick answer', result: 'Yes', at: '2026-10-05' },
  ];
  expect(retainedTask(session)).toBeUndefined();
  session.turns[0]!.routeNote = 'Vex requested clarification';
  expect(retainedTask(session)).toBeUndefined();
});
