import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { candidateMemory, loadMemory, memoryConfigPath, MEMORY_POLICY, saveMemory, setMemoryEnabled } from '../src/core/memory/config.js';
import { MemoryAccess, exportMemory, finishMemoryAttempt, repairMemoryWriter, memoryWriterLocked, type MemoryScope } from '../src/core/memory/access.js';
import { PaceStore, newSession } from '../src/core/sessions.js';
import { deleteConversationTurn, undoConversationTurn } from '../src/core/session-model.js';
import { basicMemoryEnvironment, verifyBasicMemoryScope } from '../src/integrations/basic-memory.js';
import { registerAppServerRequests } from '../src/integrations/app-server-requests.js';
import * as basicMemory from '../src/integrations/basic-memory.js';
import { captureCheckpoint } from '../src/core/memory/checkpoint.js';
import { AppServerRunner } from '../src/integrations/app-server-runner.js';
import { memorySetupService } from '../src/core/memory/setup.js';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pace-memory-test-')); roots.push(root);
  const project = join(root, 'project'), base = join(root, 'store'); await mkdir(project);
  const config = await candidateMemory(project, join(root, 'notes'), '/fake/basic-memory', base);
  const store = new PaceStore(base), session = newSession(project, 'manual');
  const attempt = { id: randomUUID(), taskId: 'task', generation: 1, role: 'main' as const, stage: 'final', status: 'completed' as const, route: {}, observations: [], startedAt: '2026-01-01T00:00:00.000Z' };
  session.attempts = [attempt]; session.turns = [{ at: 'source-turn', prompt: 'task', result: 'done', memoryAttemptId: attempt.id }]; await store.save(session);
  const scope: MemoryScope = { config, baseDir: base, sessionId: session.id, taskId: 'task', role: 'main', attemptId: attempt.id, startedAt: attempt.startedAt, branch: 'main', commit: 'old-commit' };
  const notes = new Map<string, string>();
  const call = vi.fn(async (tool: string, args: Record<string, unknown>) => {
    if (tool === 'write_note') { notes.set(`pace/${args.title}`, String(args.content)); return { permalink: `pace/${args.title}` }; }
    if (tool === 'read_note') { if (!notes.has(String(args.identifier))) throw new Error('Missing note'); return notes.get(String(args.identifier)); }
    if (tool === 'search_notes') return { results: [...notes.entries()].map(([permalink, content]) => ({ permalink, content })) };
    if (tool === 'list_memory_projects') return { projects: [{ name: config.backendProject }] };
    return {};
  });
  const close = vi.fn(async () => {}), connect = vi.fn(async () => ({ call, close }));
  return { root, project, base, config, store, session, scope, connect, call, close };
}
it('distinguishes absent, incomplete, ready, empty, disabled and degraded config and canonical aliases', async () => {
  const f = await fixture(); expect((await loadMemory(f.project, f.base)).state).toBe('unconfigured');
  const file = await memoryConfigPath(f.project, f.base); await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file + '.pending', '{}'); expect((await loadMemory(f.project, f.base)).state).toBe('configuring');
  await saveMemory(f.config, f.base); expect((await loadMemory(f.project, f.base)).state).toBe('ready');
  await symlink(f.project, join(f.root, 'alias')); expect((await loadMemory(join(f.root, 'alias'), f.base)).config?.id).toBe(f.config.id);
  const disabled = await setMemoryEnabled(f.config, false, f.base); expect((await loadMemory(f.project, f.base)).state).toBe('disabled');
  expect(await exportMemory(disabled)).toEqual({ version: 1, records: [] });
  await writeFile(file, '{broken'); expect((await loadMemory(f.project, f.base)).state).toBe('unavailable');
});
it('captures once, confirms writes, keeps hypotheses typed, and does bounded recall without cascading on no hits', async () => {
  const f = await fixture(), access = new MemoryAccess(f.scope, f.connect);
  const record = await access.remember({ key: 'retry', type: 'hypothesis', content: 'Historical unverified hypothesis about the retry queue.' });
  expect(record.status).toBe('pending'); expect(await access.recall('retry')).toBe('');
  await finishMemoryAttempt(f.scope, true);
  expect(await access.remember({ key: 'retry', type: 'hypothesis', content: record.content })).toMatchObject({ id: record.id });
  expect(f.call.mock.calls.filter(([tool]) => tool === 'write_note')).toHaveLength(1);
  expect(await access.recall('retry')).toContain('hypothesis');
  f.call.mockImplementationOnce(async () => ({ results: [] })); f.call.mockClear();
  expect(await access.recall('unrelated')).toBe(''); expect(f.call).toHaveBeenCalledOnce();
  const events = (await readFile(join(f.config.configDirectory, 'pace-events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  expect(events.every(event => event.backendCostUsd === null)).toBe(true); await access.close();
});
it.each(['aside', 'verifier', 'scout', 'status'] as const)('enforces read/write roles outside prompts: %s cannot write', async role => {
  const f = await fixture(), access = new MemoryAccess({ ...f.scope, role }, f.connect);
  await expect(access.remember({ key: 'forged', type: 'decision', content: 'forged' })).rejects.toThrow('Only the main'); expect(f.connect).not.toHaveBeenCalled();
});
it('rejects forged project arguments, bounds responses and limits tool expansion', async () => {
  const f = await fixture(), access = new MemoryAccess(f.scope, f.connect);
  await expect(access.tool({ operation: 'search', query: 'x', project: 'another' })).rejects.toThrow();
  await expect(access.remember({ key: 'big', type: 'decision', content: 'ą'.repeat(1000) })).rejects.toThrow('bytes');
  for (let i = 1; i < MEMORY_POLICY.toolSteps; i++) await access.tool({ operation: 'search', query: 'x' });
  await expect(access.tool({ operation: 'search', query: 'x' })).rejects.toThrow('budget'); await access.close();
});
it('prevents retracted sources from returning after undo, redo, deletion or branch change', async () => {
  const f = await fixture(), access = new MemoryAccess(f.scope, f.connect);
  const record = await access.remember({ key: 'decision', type: 'decision', content: 'Keep ordering stable.' }); await finishMemoryAttempt(f.scope, true);
  expect(await access.recall('ordering')).toContain(record.id);
  const turn = undoConversationTurn(f.session)!; await f.store.saveChanges(f.session);
  expect(await access.recall('ordering')).toBe('');
  f.session.turns.push(turn); await f.store.saveChanges(f.session); expect(await access.recall('ordering')).toBe('');
  deleteConversationTurn(f.session, 0); await f.store.saveChanges(f.session); expect(await access.recall('ordering')).toBe('');
  const otherBranch = new MemoryAccess({ ...f.scope, branch: 'feature' }, f.connect); expect(await otherBranch.recall('ordering')).toBe('');
  await access.close(); await otherBranch.close();
});
it('serializes writers, prevents an older writer restoring superseded knowledge, and isolates projects', async () => {
  const f = await fixture(), first = new MemoryAccess(f.scope, f.connect);
  const record = await first.remember({ key: 'policy', type: 'decision', content: 'Old policy' }); await finishMemoryAttempt(f.scope, true);
  const nextId = randomUUID(), newerScope = { ...f.scope, attemptId: nextId, startedAt: '2099-01-01T00:00:00.000Z' };
  f.session.attempts!.push({ ...f.session.attempts![0]!, id: nextId }); await f.store.saveChanges(f.session);
  const newer = new MemoryAccess(newerScope, f.connect);
  await newer.remember({ key: 'policy', type: 'decision', content: 'New policy', supersedes: [record.id] }); await finishMemoryAttempt(newerScope, true);
  await expect(first.remember({ key: 'policy', type: 'decision', content: 'Old policy' })).rejects.toThrow('stale');
  const second = await fixture(), foreign = new MemoryAccess(second.scope, f.connect);
  expect(await foreign.recall('policy')).toBe(''); await first.close(); await newer.close(); await foreign.close();
});
it('reports refused writes as failures and records degraded health with unknown costs', async () => {
  const f = await fixture(); f.call.mockRejectedValue(new Error('backend unavailable'));
  const access = new MemoryAccess(f.scope, f.connect);
  await expect(access.remember({ key: 'broken', type: 'observation', content: 'test' })).rejects.toThrow('backend unavailable');
  expect((await exportMemory(f.config)).records).toEqual([]);
  const health = JSON.parse(await readFile(join(f.config.configDirectory, 'pace-health.json'), 'utf8')); expect(health.degraded).toBe(true); await access.close();
});
it('rejects stale settings and keeps parallel branch decisions separate', async () => {
  const f = await fixture(); await saveMemory(f.config, f.base);
  await setMemoryEnabled(f.config, false, f.base);
  await expect(setMemoryEnabled(f.config, true, f.base)).rejects.toThrow('changed during');
  const main = new MemoryAccess(f.scope, f.connect), feature = new MemoryAccess({ ...f.scope, branch: 'feature', attemptId: randomUUID() }, f.connect);
  f.session.attempts!.push({ ...f.session.attempts![0]!, id: feature.scope.attemptId }); await f.store.saveChanges(f.session);
  await Promise.all([main.remember({ key: 'policy', type: 'decision', content: 'Main branch decision' }), feature.remember({ key: 'policy', type: 'decision', content: 'Feature branch decision' })]);
  await Promise.all([finishMemoryAttempt(main.scope, true), finishMemoryAttempt(feature.scope, true)]);
  expect(await main.recall('policy')).toContain('Main branch decision'); expect(await main.recall('policy')).not.toContain('Feature branch decision');
  expect(await feature.recall('policy')).toContain('Feature branch decision');
  await main.close(); await feature.close();
});
it('recovers a lost write acknowledgement idempotently and rejects externally edited content', async () => {
  const f = await fixture(), implementation = f.call.getMockImplementation()!;
  f.call.mockImplementation(async (tool, args) => { const result = await implementation(tool, args); if (tool === 'write_note') throw Error('lost acknowledgement'); return result; });
  const access = new MemoryAccess(f.scope, f.connect), record = await access.remember({ key: 'lost', type: 'observation', content: 'Confirmed despite lost acknowledgement' });
  await finishMemoryAttempt(f.scope, true); expect(await access.read(record.id)).toMatchObject({ id: record.id });
  f.call.mockImplementation(async (tool, args) => tool === 'read_note' ? `${record.id} externally edited` : implementation(tool, args));
  await expect(access.read(record.id)).rejects.toThrow('changed outside Pace'); await access.close();
});
it('expands an existing external note graph only on an explicit request', async () => {
  const f = await fixture(); f.call.mockImplementation(async (name, args) => {
    if (name === 'search_notes') return { results: [{ permalink: 'notes/start', title: 'Historical entry' }] };
    if (name === 'build_context') return { results: [{ related_results: [{ permalink: 'notes/related', title: 'Related historical entry' }] }] };
    if (name === 'read_note') return { content: 'External historical content' };
    return {};
  });
  const access = new MemoryAccess(f.scope, f.connect), [note] = await access.search('history');
  expect(f.call).not.toHaveBeenCalledWith('build_context', expect.anything(), expect.anything());
  const related = await access.relations(note!.id); expect(related[0]?.status).toBe('historical');
  expect(await access.read(related[0]!.id)).toMatchObject({ content: 'External historical content' });
  await access.close();
});
it('repairs only a provably dead owned writer and preserves a live writer lock', async () => {
  const f = await fixture(), lock = join(f.config.configDirectory, '.pace-writer'); await mkdir(lock, { recursive: true });
  await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, nonce: randomUUID() }));
  await expect(repairMemoryWriter(f.config)).rejects.toThrow('still running'); expect(await memoryWriterLocked(f.config)).toBe(true);
  await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: 99_999_999, nonce: randomUUID() }));
  await repairMemoryWriter(f.config); expect(await memoryWriterLocked(f.config)).toBe(false);
});
it('resolves equal-timestamp writers deterministically when the earlier writer finishes last', async () => {
  const f = await fixture(), early = { ...f.scope, attemptId: '00000000-0000-4000-8000-000000000001' }, later = { ...f.scope, attemptId: '00000000-0000-4000-8000-000000000002' };
  f.session.attempts = [early, later].map(scope => ({ ...f.session.attempts![0]!, id: scope.attemptId })); await f.store.saveChanges(f.session);
  const a = new MemoryAccess(early, f.connect), b = new MemoryAccess(later, f.connect);
  await a.remember({ key: 'tie', type: 'decision', content: 'Earlier tie' }); await b.remember({ key: 'tie', type: 'decision', content: 'Deterministic winner' });
  await finishMemoryAttempt(later, true); await finishMemoryAttempt(early, true);
  expect(await a.recall('tie')).toContain('Deterministic winner'); expect(await a.recall('tie')).not.toContain('Earlier tie'); await a.close(); await b.close();
});
it('uses isolated backend env without API secrets or cloud routing', async () => {
  const f = await fixture(); vi.stubEnv('OPENAI_API_KEY', 'secret'); vi.stubEnv('BASIC_MEMORY_FORCE_CLOUD', 'true');
  const env = basicMemoryEnvironment(f.config); expect(env.OPENAI_API_KEY).toBeUndefined(); expect(env.BASIC_MEMORY_FORCE_CLOUD).toBeUndefined(); expect(env.BASIC_MEMORY_MCP_PROJECT).toBe(f.config.backendProject); vi.unstubAllEnvs();
});
it('checks the real backend configuration before claiming a local provider or allowing project access', async () => {
  const f = await fixture(); await mkdir(f.config.configDirectory, { recursive: true });
  const backend = { projects: { [f.config.backendProject]: { path: f.config.dataDirectory, mode: 'local' } }, default_project: f.config.backendProject,
    auto_update: false, database_backend: 'sqlite', semantic_embedding_provider: 'fastembed', semantic_embedding_model: 'bge-small-en-v1.5', reranker_enabled: false };
  const file = join(f.config.configDirectory, 'config.json'); await writeFile(file, JSON.stringify(backend)); await verifyBasicMemoryScope(f.config);
  await writeFile(file, JSON.stringify({ ...backend, projects: { ...backend.projects, foreign: { path: f.project, mode: 'local' } } }));
  await expect(verifyBasicMemoryScope(f.config)).rejects.toThrow('scope/provider');
});
it('preserves ready settings after failed setup and repairs a moved runtime without changing the namespace', async () => {
  const f = await fixture(); await saveMemory(f.config, f.base);
  vi.spyOn(basicMemory, 'configureBasicMemory').mockResolvedValue();
  const check = vi.spyOn(memorySetupService, 'check').mockRejectedValue(new Error('cancelled probe'));
  await expect(memorySetupService.setup(f.project, join(f.root, 'candidate-notes'), '/candidate/basic-memory', f.base)).rejects.toThrow('cancelled probe');
  expect((await loadMemory(f.project, f.base)).config).toEqual(f.config);
  const broken = { ...f.config, executable: '/missing/basic-memory' }; await saveMemory(broken, f.base);
  vi.spyOn(basicMemory, 'detectBasicMemory').mockResolvedValue({ executable: f.config.executable });
  check.mockRejectedValueOnce(new Error('runtime moved')).mockResolvedValueOnce();
  const repaired = await memorySetupService.repair(broken, f.base);
  expect(repaired).toMatchObject({ id: f.config.id, backendProject: f.config.backendProject, dataDirectory: f.config.dataDirectory, executable: f.config.executable });
  expect(repaired.revision).not.toBe(f.config.revision);
});
it('denies dynamic memory writes from the App Server side path and confirms errors in the protocol', async () => {
  const f = await fixture(), access = new MemoryAccess({ ...f.scope, role: 'aside' }, f.connect);
  let handler: (message: any) => void = () => {}; const respond = vi.fn();
  const server = { setRequestHandler: (value: typeof handler) => { handler = value; }, respond, request: vi.fn(), notify: vi.fn(), kill: vi.fn() };
  registerAppServerRequests(server, 'side', () => {}, new Map(), new Map(), access);
  handler({ id: 1, method: 'item/tool/call', params: { tool: 'pace_memory', arguments: { operation: 'remember', key: 'x', type: 'decision', content: 'no' } } });
  await vi.waitFor(() => expect(respond).toHaveBeenCalledWith(1, expect.objectContaining({ success: false })));
  expect(f.connect).not.toHaveBeenCalled(); await access.close();
});
it('captures an existing validated checkpoint once and retracts all source stages on undo', async () => {
  const f = await fixture(); await saveMemory(f.config, f.base);
  vi.spyOn(basicMemory, 'connectBasicMemory').mockImplementation(f.connect);
  f.session.attempts![0]!.memoryProvenance = { projectId: f.config.id, branch: 'main' };
  f.session.checkpoint = { createdAt: '2026-01-02', sourceTurnAt: 'source-turn', threadId: 'thread', route: {}, durationMs: 1,
    note: { complete: true, goal: 'Preserve ordering', constraints: [], findings: [{ file: 'queue.ts', detail: 'Ordering was verified in the source turn' }], changes: [], checks: [], unfinished: [], questions: [], risks: [] } };
  await f.store.saveChanges(f.session);
  await captureCheckpoint(f.store, f.session); await captureCheckpoint(f.store, f.session);
  expect(f.call.mock.calls.filter(([name]) => name === 'write_note')).toHaveLength(1);
  const access = new MemoryAccess(f.scope, f.connect); expect(await access.recall('ordering')).toContain('Historical validated checkpoint');
  const earlier = randomUUID(); f.session.turns[0]!.memoryAttemptIds = [earlier, f.scope.attemptId]; undoConversationTurn(f.session); await f.store.saveChanges(f.session);
  expect(f.session.memoryRetractedAttempts).toEqual(expect.arrayContaining([earlier, f.scope.attemptId])); expect(await access.recall('ordering')).toBe(''); await access.close();
});
it('recalls through App Server only when requested and disables raw backend MCP while preserving other servers', async () => {
  const f = await fixture(); vi.spyOn(basicMemory, 'connectBasicMemory').mockImplementation(f.connect);
  const seed = new MemoryAccess(f.scope, f.connect); await seed.remember({ key: 'ordering', type: 'decision', content: 'Preserve queue ordering' }); await finishMemoryAttempt(f.scope, true); await seed.close();
  const requests: { method: string; params: any }[] = [];
  const runner = new AppServerRunner(onMessage => ({
    setRequestHandler() {}, notify() {}, kill() {}, respond() {},
    async request(method, params) {
      requests.push({ method, params });
      if (method === 'mcpServerStatus/list') return { data: [{ name: 'basic-memory', tools: { write_note: {}, search_notes: {} } }, { name: 'other', tools: { harmless: {} } }] };
      if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: 'thread' } };
      if (method === 'turn/start') {
        queueMicrotask(() => onMessage({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status: 'completed' } } }));
        return { turn: { id: 'turn' } };
      }
      return {};
    },
  }));
  await runner.run('New task', f.project, {}, undefined, () => {}, undefined, 'main', [], 'request-approval', undefined, { scope: f.scope, recallQuery: 'ordering' });
  expect(JSON.stringify(requests.find(item => item.method === 'turn/start')?.params.input)).toContain('Preserve queue ordering');
  expect(requests.find(item => item.method === 'thread/start')?.params.config).toEqual({ 'mcp_servers."basic-memory".enabled': false });
  expect(requests.find(item => item.method === 'thread/start')?.params.dynamicTools[0].name).toBe('pace_memory');
  f.call.mockClear();
  await runner.run('Continue', f.project, {}, 'thread', () => {}, undefined, 'main', [], 'request-approval', undefined, { scope: f.scope });
  expect(f.call.mock.calls.some(([name]) => name === 'search_notes')).toBe(false);
});
