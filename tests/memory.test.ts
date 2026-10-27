import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { candidateMemory, loadMemory, memoryConfigPath, MEMORY_POLICY, saveMemory, setMemoryEnabled } from '../src/core/memory/config.js';
import { MemoryAccess, exportMemory, finishMemoryAttempt, type MemoryScope } from '../src/core/memory/access.js';
import { PaceStore, newSession } from '../src/core/sessions.js';
import { deleteConversationTurn, undoConversationTurn } from '../src/core/session-model.js';
import { basicMemoryEnvironment } from '../src/integrations/basic-memory.js';
import { registerAppServerRequests } from '../src/integrations/app-server-requests.js';

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
it('uses isolated backend env without API secrets or cloud routing', async () => {
  const f = await fixture(); vi.stubEnv('OPENAI_API_KEY', 'secret'); vi.stubEnv('BASIC_MEMORY_FORCE_CLOUD', 'true');
  const env = basicMemoryEnvironment(f.config); expect(env.OPENAI_API_KEY).toBeUndefined(); expect(env.BASIC_MEMORY_FORCE_CLOUD).toBeUndefined(); expect(env.BASIC_MEMORY_MCP_PROJECT).toBe(f.config.backendProject); vi.unstubAllEnvs();
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
