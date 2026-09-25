import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PaceStore, newSession, projectKey } from '../src/core/sessions.js';
let dir: string;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });
it('stores a session atomically under a hashed project key and reloads it', async () => {
  dir = await mkdtemp(join(tmpdir(), 'pace-test-'));
  const store = new PaceStore(dir);
  const session = newSession('/example/project', 'auto'); session.threadId = 'thread-123';
  await store.save(session);
  expect((await store.latest('/example/project'))?.threadId).toBe('thread-123');
  expect(projectKey('/example/project')).toMatch(/^[a-f0-9]{64}$/);
  expect((await readdir(store.sessionDir('/example/project'))).sort()).toEqual([`${session.id}.json`, 'active.json'].sort());
  expect((await readFile(join(store.sessionDir('/example/project'), `${session.id}.json`), 'utf8'))).toContain('thread-123');
});
it('skips corrupted session files', async () => {
  dir = await mkdtemp(join(tmpdir(), 'pace-test-'));
  const notices: string[] = []; const store = new PaceStore(dir, text => notices.push(text));
  const session = newSession('/example/project', 'auto'); await store.save(session);
  await writeFile(join(store.sessionDir('/example/project'), 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.json'), '{bad');
  expect((await store.list('/example/project')).map(item => item.id)).toEqual([session.id]);
  expect(notices.length).toBe(1);
});
it('does not use the SDK default when an explicit model config is corrupt', async () => {
  dir = await mkdtemp(join(tmpdir(), 'pace-test-'));
  const store = new PaceStore(dir);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'config.json'), '{bad');
  await expect(store.loadConfig()).rejects.toThrow();
});
it('loads definitive routes for an untouched legacy automatic config', async () => {
  dir = await mkdtemp(join(tmpdir(), 'pace-test-'));
  const store = new PaceStore(dir);
  await writeFile(join(dir, 'config.json'), JSON.stringify({ models: [], defaultRoute: {}, routingMode: 'auto' }));
  const config = await store.loadConfig();
  expect(config.defaultRoute).toEqual({ model: 'gpt-6-sol', effort: 'medium' });
  expect(config.models.map(model => model.model)).toEqual(['gpt-6-luna', 'gpt-6-sol', 'gpt-6-astra']);
});
