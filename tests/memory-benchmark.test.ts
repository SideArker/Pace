import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { memorySetupService } from '../src/core/memory/setup.js';
import { candidateMemory, saveMemory, MEMORY_POLICY } from '../src/core/memory/config.js';
import { MemoryAccess, finishMemoryAttempt } from '../src/core/memory/access.js';
import { freezeMemory, importMemory } from '../src/core/memory/snapshot.js';
import { PaceStore, newSession } from '../src/core/sessions.js';
import * as dataset from '../src/benchmark/memory-dataset.js';
import { writeFixture } from '../src/benchmark/memory-prepare.js';
import { runMemoryBenchmark } from '../src/benchmark/drivers/memory.js';
import { checkMemoryIsolation, isolatedCommand, isolatedAppServer } from '../src/benchmark/isolation.js';
import { preflight } from '../src/benchmark/preflight.js';
import { hash, inventory } from '../src/benchmark/storage.js';
import { familyComparisons, memorySummary } from '../src/benchmark/results.js';
import type { CodexRunner } from '../src/integrations/codex-types.js';

const backend = vi.hoisted(() => new Map<string, Map<string, string>>());
vi.mock('../src/integrations/basic-memory.js', async original => ({ ...await original<typeof import('../src/integrations/basic-memory.js')>(),
  detectBasicMemory: vi.fn(async () => ({ executable: '/mock/basic-memory' })), validateBasicMemory: vi.fn(async () => {}),
  connectBasicMemory: vi.fn(async (config: { id: string; backendProject: string }) => {
    const notes = backend.get(config.id) ?? new Map<string, string>(); backend.set(config.id, notes);
    return { close: async () => {}, call: async (name: string, args: Record<string, any>) => {
      if (name === 'write_note') { notes.set(`pace/${args.title}`, args.content); return {}; }
      if (name === 'read_note') return { content: notes.get(args.identifier) ?? '' };
      if (name === 'search_notes') return { results: [...notes].map(([permalink, content]) => ({ permalink, content })) };
      if (name === 'list_memory_projects') return { projects: [{ name: config.backendProject }] };
      return {};
    } };
  }),
}));
let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'pace-memory-bench-test-')); backend.clear(); });
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
it('previews Quick, Standard, Confirm and full-cycle with exact model counts without inference', async () => {
  const { pin, suite, suiteHash } = await dataset.memoryInputs();
  vi.spyOn(dataset, 'memoryInputs').mockResolvedValue({ pin: { ...pin, commit: 'a'.repeat(40), seedSha256: 'b'.repeat(64), status: 'ready-local' }, suite, suiteHash });
  expect((await preflight({ category: 'memory', profile: 'quick' })).maximumModelTurns).toBe(2);
  const standard = await preflight({ category: 'memory', profile: 'standard' }); expect(standard.plan).toHaveLength(18); expect(standard.maximumModelTurns).toBe(36);
  expect((await preflight({ category: 'memory', profile: 'confirm' })).blockedReasons?.join()).toContain('repetitions');
  expect((await preflight({ category: 'memory', profile: 'confirm', repeats: 7 })).maximumModelTurns).toBe(14);
  expect((await preflight({ category: 'memory', profile: 'full-cycle' })).maximumModelTurns).toBe(18);
  await expect(preflight({ category: 'memory', profile: 'standard', repeats: 5 })).rejects.toThrow('Only Confirm');
});
it('freezes and imports sources into a fresh namespace, preserving relations and retractions', async () => {
  const sourcePath = join(root, 'source'), targetPath = join(root, 'target'); await mkdir(sourcePath); await mkdir(targetPath);
  const sourceConfig = await candidateMemory(sourcePath, join(root, 'source-notes'), '/mock/basic-memory', join(root, 'source-store'));
  const store = new PaceStore(join(root, 'source-store')), session = newSession(sourcePath, 'manual'), attemptId = randomUUID();
  session.attempts = [{ id: attemptId, taskId: 'history', generation: 1, role: 'main', stage: 'final', status: 'completed', route: {}, observations: [], startedAt: '2026-01-01T00:00:00.000Z' }]; await store.save(session);
  const scope = { config: sourceConfig, baseDir: store.baseDir, sessionId: session.id, taskId: 'history', attemptId, role: 'main' as const, startedAt: session.attempts[0]!.startedAt, branch: 'main' };
  const access = new MemoryAccess(scope);
  const first = await access.remember({ key: 'first', type: 'observation', content: 'Earlier fictional module observation' }); await finishMemoryAttempt(scope, true);
  await access.remember({ key: 'decision', type: 'decision', content: 'Earlier private fictional decision', relations: [first.id] }); await finishMemoryAttempt(scope, true); await access.close();
  const snapshot = await freezeMemory(sourceConfig, store, { model: 'mock', effort: 'medium', usage: null, costUsd: null, durationMs: 1 });
  const targetConfig = await candidateMemory(targetPath, join(root, 'target-notes'), '/mock/basic-memory', join(root, 'target-store')), targetStore = new PaceStore(join(root, 'target-store'));
  await importMemory(snapshot, targetConfig, targetStore);
  const recalled = new MemoryAccess({ ...scope, config: targetConfig, baseDir: targetStore.baseDir }); expect(await recalled.recall('decision')).toContain('fictional'); await recalled.close();
  await expect(importMemory(snapshot, targetConfig, targetStore)).rejects.toThrow('fresh');
  const invalid = structuredClone(snapshot); invalid.sources = [];
  const fresh = await candidateMemory(targetPath, join(root, 'other-notes'), '/mock/basic-memory', join(root, 'other-store'));
  await expect(importMemory(invalid, fresh, targetStore)).rejects.toThrow('completed main source');
});
it.skipIf(process.platform !== 'linux')('blocks host, Git and network leakage and runs matched A/B via the shared production policy', async () => {
  await checkMemoryIsolation();
  const { suite, pin, suiteHash } = await dataset.memoryInputs(), repo = join(root, 'dataset');
  const files = JSON.parse(await readFile('benchmark/memory/project.json', 'utf8')) as Record<string, string>;
  const snapshot = { version: 1 as const, backendVersion: '0.24.1' as const, policy: MEMORY_POLICY, records: [], sources: [], preparation: { model: 'mock', effort: 'medium', usage: null, costUsd: null, durationMs: 1 } };
  const seed = JSON.stringify(snapshot), entries: Record<string, string> = { 'seed.json': seed };
  for (const [path, content] of Object.entries(files)) entries[`project/${path}`] = content;
  const { commit } = await writeFixture(repo, entries);
  const frozen = { ...pin, localRepository: repo, commit, seedSha256: hash(seed), status: 'ready-local' as const };
  const downloaded = await dataset.fetchMemoryDataset(frozen, false, undefined, join(root, 'cache'));
  expect((await dataset.fetchMemoryDataset(frozen, true, undefined, join(root, 'cache'))).snapshot).toEqual(snapshot);
  await expect(dataset.fetchMemoryDataset({ ...frozen, seedSha256: '0'.repeat(64) }, true, undefined, join(root, 'cache'))).rejects.toThrow('checksum');
  vi.spyOn(dataset, 'memoryInputs').mockResolvedValue({ pin: frozen, suite, suiteHash }); vi.spyOn(dataset, 'fetchMemoryDataset').mockResolvedValue(downloaded);
  vi.spyOn(memorySetupService, 'setup').mockImplementation(async (project, notes, executable, base) => { const config = await candidateMemory(project, notes, executable, base); await saveMemory(config, base); return config; });
  const workspace = join(root, 'probe'); await writeFixture(workspace, files); const secret = join(root, 'outside-secret'); await writeFile(secret, 'grader answers');
  const probe = await isolatedCommand(workspace, process.execPath, ['--input-type=module', '-e', `import{existsSync}from'node:fs';if(existsSync(${JSON.stringify(secret)}))throw Error('host leak');if(existsSync(${JSON.stringify(repo)}))throw Error('Git/seed leak');console.log('isolated')`]); expect(probe.stdout).toContain('isolated');
  const authHome = join(root, 'auth'); await mkdir(authHome); await writeFile(join(authHome, 'auth.json'), '{}'); vi.stubEnv('CODEX_HOME', authHome);
  // Runs real command/exec probes (no model): host, auth, symlink, network denial and workspace writes.
  const launch = await isolatedAppServer(workspace, join(root, 'agent-probe')); expect(launch.cwd).toBe(workspace);
  const modes: boolean[] = [], usage = { input_tokens: 100, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 0 };
  const fake: CodexRunner = { run: vi.fn(async (prompt, cwd, route, _thread, progress, _signal, _mode, _folders, _approval, _artifacts, memory) => {
    modes.push(!!memory?.scope); await progress({ kind: 'prompt', threadId: randomUUID(), input: [{ type: 'text', text: prompt }] });
    await writeFile(join(cwd, 'src/queue.mjs'), "export async function deliver(tasks,retries=0){const r=[];for(const task of tasks){let a=0;for(;;){try{r.push(await task());break}catch(e){if(a++>=retries)throw e}}}return r}");
    return { threadId: randomUUID(), completed: true, route, usage, result: 'Fixed independent retry counts' };
  }) };
  await runMemoryBenchmark({ preview: await preflight({ category: 'memory', profile: 'quick' }), out: join(root, 'out'), runnerFactory: async () => fake });
  expect(modes).toEqual([false, true]);
  const runs = await Promise.all((await inventory(join(root, 'out'))).filter(path => path.endsWith('/run.json')).map(async path => JSON.parse(await readFile(path, 'utf8'))));
  expect(runs).toHaveLength(2); expect(runs.every(run => run.checksPassed)).toBe(true); expect(runs[0].commit).toBe(runs[1].commit);
  const reviewed = runs.map((run, i) => ({ run, path: String(i), sha256: 'hash', label: 'case', review: { pass: true, preservedContext: true, severity: 'minor' as const, notes: 'checked', evidence: 'external verification', affectedBehavior: 'independent retry budgets' } }));
  expect(familyComparisons(reviewed)[0]?.compatible).toBe(true); expect(memorySummary(reviewed).completeSavings).toBeNull();
}, 30_000);
