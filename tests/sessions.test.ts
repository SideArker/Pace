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
it('saves a standalone feedback snapshot and optional comment in the local inbox', async () => {
  dir = await mkdtemp(join(tmpdir(), 'pace-test-'));
  const store = new PaceStore(dir);
  const session = newSession('/example/project', 'auto');
  session.turns.push({ prompt: 'Why did this fail?', result: 'It failed.', at: '2026-01-01' });

  const path = await store.saveFeedback(session, 'Please review this turn.');
  const report = JSON.parse(await readFile(path, 'utf8'));
  expect(path).toContain(join(dir, 'feedback', 'inbox'));
  expect(report).toMatchObject({
    version: 1,
    comment: 'Please review this turn.',
    projectPath: '/example/project',
    session: { id: session.id, turns: session.turns },
  });
  expect(session.turns).toHaveLength(1);
});
it('persists multiple ON-LAUNCH skills while loading older sessions without them', async () => {
  dir = await mkdtemp(join(tmpdir(), 'pace-test-'));
  const store = new PaceStore(dir);
  const session = newSession('/example/project', 'manual');
  await store.save(session);
  expect((await store.load(session.projectPath, session.id))?.autoLaunchSkills).toBeUndefined();
  session.autoLaunchSkills = ['review', 'format'];
  session.autoLaunchThreadId = 'thread-1';
  await store.save(session);
  expect(await store.load(session.projectPath, session.id)).toMatchObject({ autoLaunchSkills: ['review', 'format'], autoLaunchThreadId: 'thread-1' });
  await writeFile(join(store.sessionDir(session.projectPath), `${session.id}.json`), JSON.stringify({ ...session, autoLaunchSkills: ['/invalid'] }));
  expect(await store.load(session.projectPath, session.id)).toBeUndefined();
});
it('restores queued prompts from full sessions and startup summaries', async () => {
  dir = await mkdtemp(join(tmpdir(), 'pace-test-'));
  const store = new PaceStore(dir);
  const session = newSession('/example/project', 'auto');
  session.queuedPrompts = ['first', 'second'];
  await store.save(session);
  const restarted = new PaceStore(dir);
  expect((await restarted.load(session.projectPath, session.id))?.queuedPrompts).toMatchObject([{ text: 'first', role: 'main' }, { text: 'second', role: 'main' }]);
  expect((await restarted.listSummaries(session.projectPath))[0]?.queuedPrompts).toMatchObject([{ text: 'first', role: 'main' }, { text: 'second', role: 'main' }]);
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
  expect(config.defaultRoute).toEqual({ model: 'gpt-6.2-sol', effort: 'high' });
  expect(config.models.map(model => model.model)).toEqual(['gpt-6-luna', 'gpt-6.2-sol', 'gpt-6.1-terra', 'gpt-6.2-astra']);
});

it('removes pre-GPT-6 models from saved routing and repairs an obsolete default', async () => {
  dir = await mkdtemp(join(tmpdir(), 'pace-test-'));
  const store = new PaceStore(dir);
  await store.saveConfig({ ...structuredClone((await store.loadConfig())), models: [
    { model: 'gpt-5.6-sol', efforts: ['high'] },
    { model: 'gpt-6.1-terra', efforts: ['medium'], defaultEffort: 'medium' },
  ], defaultRoute: { model: 'gpt-5.6-sol', effort: 'high' } });
  const config = await store.loadConfig();
  expect(config.models.map(model => model.model)).toEqual(['gpt-6.1-terra']);
  expect(config.defaultRoute).toEqual({ model: 'gpt-6.1-terra', effort: 'medium' });
  expect(JSON.parse(await readFile(join(dir, 'config.json'), 'utf8')).models.map((model: { model: string }) => model.model)).toEqual(['gpt-6.1-terra']);
  await store.saveConfig({ ...config, models: [{ model: 'gpt-5.6-sol', efforts: ['high'] }], defaultRoute: { model: 'gpt-5.6-sol', effort: 'high' } });
  const migrated = await store.loadConfig();
  expect(migrated.models.map(model => model.model)).toEqual(['gpt-6-luna', 'gpt-6.2-sol', 'gpt-6.1-terra', 'gpt-6.2-astra']);
  expect(migrated.defaultRoute).toEqual({ model: 'gpt-6.2-sol', effort: 'high' });
  await store.saveConfig({ ...config, models: [
    { model: 'gpt-5.6-sol', efforts: ['high'] },
    { model: 'gpt-6-luna', efforts: ['low'], enabled: false },
    { model: 'gpt-6.2-sol', efforts: ['high'], defaultEffort: 'high' },
  ], defaultRoute: { model: 'gpt-5.6-sol', effort: 'high' } });
  expect((await store.loadConfig()).defaultRoute).toEqual({ model: 'gpt-6.2-sol', effort: 'high' });
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
  first.planArtifact = 'artifacts/plan.pace-plan.md';
  await store.save(first);
  await store.save(second);
  await mkdir(join(store.conversationDir(oldPath, first.id), 'artifacts'), { recursive: true });
  await writeFile(join(store.conversationDir(oldPath, first.id), first.planArtifact), '# Plan\n');
  await rename(oldPath, newPath);

  expect(await store.reconnectProject(oldPath, newPath)).toBe(2);
  expect((await store.list(newPath)).map(item => item.id).sort()).toEqual([first.id, second.id].sort());
  expect((await store.latest(newPath))?.id).toBe(second.id);
  expect((await store.list(newPath)).find(item => item.id === first.id)).toMatchObject({
    projectPath: normalizeProject(newPath), threadId: 'codex-thread-1', planArtifact: 'artifacts/plan.pace-plan.md',
    turns: [{ prompt: 'Keep this', result: 'Kept', at: '2026-01-01' }],
  });
  expect(await readFile(join(store.conversationDir(newPath, first.id), first.planArtifact), 'utf8')).toBe('# Plan\n');
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

it('validates saved review decisions and the last decision used by Undo', async () => {
  const { parseSession } = await import('../src/core/session-record.js');
  const session = newSession('/review-project', 'manual');
  const id = '11111111-1111-4111-8111-111111111111';
  session.fileReviews = { [id]: { 'a.txt': 'rejected' } };
  session.lastFileReview = { fileEdits: id, previous: [{ path: 'a.txt' }], restoredPaths: ['a.txt'] };
  expect(parseSession(structuredClone(session), session.projectPath)?.lastFileReview).toEqual(session.lastFileReview);
  for (const fields of [
    { fileReviews: { invalid: { 'a.txt': 'accepted' } } },
    { fileReviews: { [id]: { 'a.txt': 'unknown' } } },
    { lastFileReview: { ...session.lastFileReview, restoredPaths: ['different.txt'] } },
    { lastFileReview: { ...session.lastFileReview, previous: [{ path: 'a.txt', decision: 'unknown' }] } },
  ]) expect(parseSession({ ...session, ...fields }, session.projectPath)).toBeUndefined();
});

it('validates multi-snapshot review undo while retaining legacy single-snapshot undo', async () => {
  const { parseSession } = await import('../src/core/session-record.js');
  const session = newSession('/review-project', 'manual');
  const record = { fileEdits: '11111111-1111-4111-8111-111111111111', previous: [{ path: 'a.txt' }], restoredPaths: ['a.txt'] };
  const second = { ...record, fileEdits: '22222222-2222-4222-8222-222222222222' };
  for (const lastFileReview of [record, { records: [record, second] }])
    expect(parseSession({ ...session, lastFileReview }, session.projectPath)?.lastFileReview).toEqual(lastFileReview);
  for (const records of [[], [record, record], [record, { ...second, restoredPaths: ['missing.txt'] }]])
    expect(parseSession({ ...session, lastFileReview: { records } }, session.projectPath)).toBeUndefined();
});
