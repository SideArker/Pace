import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PaceStore, newSession, normalizeProject, projectKey } from '../src/core/sessions.js';
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
  expect(store.conversationDir('/example/project', session.id)).toBe(join(store.sessionDir('/example/project'), session.id));
});
it('reloads a manual planning and verification workflow', async () => {
  dir = await mkdtemp(join(tmpdir(), 'pace-test-'));
  const store = new PaceStore(dir);
  const session = newSession('/example/project', 'manual');
  session.manualWorkflow = { shape: 'plan_verify', routes: {
    plan: { model: 'gpt-6-luna', effort: 'high' }, final: { model: 'gpt-6-sol' },
  } };
  await store.save(session);
  expect((await store.latest('/example/project'))?.manualWorkflow).toEqual(session.manualWorkflow);
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
  expect(config.defaultRoute).toEqual({ model: 'gpt-6-sol', effort: 'high' });
  expect(config.models.map(model => model.model)).toEqual(['gpt-6-luna', 'gpt-6-sol', 'gpt-6-astra']);
});

it('discovers sessions across projects and marks moved projects missing', async () => {
  dir = await mkdtemp(join(tmpdir(), 'pace-test-'));
  const store = new PaceStore(join(dir, 'storage'));
  const first = join(dir, 'first');
  const second = join(dir, 'second');
  await mkdir(first);
  await mkdir(second);
  await store.save(newSession(first, 'auto'));
  await store.save(newSession(second, 'manual'));
  expect((await store.listProjects()).map(project => project.exists)).toEqual([true, true]);
  await rename(first, join(dir, 'moved'));
  const projects = await store.listProjects();
  expect(projects).toHaveLength(2);
  expect(projects.find(project => project.projectPath === normalizeProject(first))?.exists).toBe(false);
  expect(projects.find(project => project.projectPath === normalizeProject(first))?.sessions).toHaveLength(1);
  expect(projects.find(project => project.projectPath === normalizeProject(second))?.exists).toBe(true);
});

it('reconnects a moved project while preserving sessions, thread and active selection', async () => {
  dir = await mkdtemp(join(tmpdir(), 'pace-test-'));
  const store = new PaceStore(join(dir, 'storage'));
  const oldPath = join(dir, 'original');
  const newPath = join(dir, 'moved');
  await mkdir(oldPath);
  const first = newSession(oldPath, 'manual');
  first.threadId = 'codex-thread-1';
  first.turns.push({ prompt: 'Keep this', result: 'Kept', at: '2026-01-01' });
  const second = newSession(oldPath, 'auto');
  second.threadId = 'codex-thread-2';
  await store.save(first);
  await store.save(second);
  await rename(oldPath, newPath);

  expect(await store.reconnectProject(oldPath, newPath)).toBe(2);
  expect((await store.list(newPath)).map(item => item.id).sort()).toEqual([first.id, second.id].sort());
  expect((await store.latest(newPath))?.id).toBe(second.id);
  expect((await store.list(newPath)).find(item => item.id === first.id)).toMatchObject({
    projectPath: normalizeProject(newPath), threadId: 'codex-thread-1',
    turns: [{ prompt: 'Keep this', result: 'Kept', at: '2026-01-01' }],
  });
  expect(await store.listProjects()).toMatchObject([{ projectPath: normalizeProject(newPath), exists: true }]);
  expect((await readdir(join(dir, 'storage', 'reconnected'))).length).toBe(1);
});

it('refuses reconnect when the destination has saved sessions', async () => {
  dir = await mkdtemp(join(tmpdir(), 'pace-test-'));
  const store = new PaceStore(join(dir, 'storage'));
  const oldPath = join(dir, 'original');
  const newPath = join(dir, 'moved');
  await mkdir(oldPath);
  await mkdir(newPath);
  const oldSession = newSession(oldPath, 'auto');
  const newSessionAtDestination = newSession(newPath, 'auto');
  await store.save(oldSession);
  await store.save(newSessionAtDestination);
  await rm(oldPath, { recursive: true });

  await expect(store.reconnectProject(oldPath, newPath)).rejects.toThrow('already has saved sessions');
  expect((await store.list(oldPath)).map(item => item.id)).toEqual([oldSession.id]);
  expect((await store.list(newPath)).map(item => item.id)).toEqual([newSessionAtDestination.id]);
});

it('leaves the source untouched if a saved session is invalid', async () => {
  dir = await mkdtemp(join(tmpdir(), 'pace-test-'));
  const store = new PaceStore(join(dir, 'storage'));
  const oldPath = join(dir, 'original');
  const newPath = join(dir, 'moved');
  await mkdir(oldPath);
  const session = newSession(oldPath, 'auto');
  await store.save(session);
  await rename(oldPath, newPath);
  await writeFile(join(store.sessionDir(oldPath), 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.json'), '{bad');

  await expect(store.reconnectProject(oldPath, newPath)).rejects.toThrow();
  expect((await readdir(store.sessionDir(oldPath))).length).toBe(3);
  expect(await store.list(newPath)).toEqual([]);
});
