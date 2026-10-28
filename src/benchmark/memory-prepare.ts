import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { assertDebug, hash, repositoryRoot, atomicJson } from './storage.js';
import { memoryInputs } from './memory-dataset.js';
import { isolatedAppServer, isolatedCommand } from './isolation.js';
import { AppServer } from '../integrations/app-server-process.js';
import { AppServerRunner } from './transports.js';
import { runMemoryAgent } from './memory-agent.js';
import { memorySetupService } from '../core/memory/setup.js';
import { freezeMemory } from '../core/memory/snapshot.js';
import { exportMemory } from '../core/memory/access.js';
import { PaceStore } from '../core/sessions.js';
import { costForUsage } from '../core/routing/pricing.js';
import { redactTrace } from '../core/prompt-trace.js';

export async function writeFixture(workspace: string, files: Record<string, string>, branch = 'main') {
  await mkdir(workspace, { recursive: true });
  for (const [path, text] of Object.entries(files)) {
    if (!path || path.startsWith('/') || /(^|[\\/])(?:\.\.|\.git)(?:[\\/]|$)/.test(path) || path.includes('\\')) throw new Error('Unsafe fixture path');
    await mkdir(dirname(join(workspace, path)), { recursive: true }); await writeFile(join(workspace, path), text);
  }
  const git = async (...args: string[]) => (await isolatedCommand(workspace, '/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', ...args])).stdout.trim();
  await git('init', '-q', '-b', branch); await git('add', '.'); await git('-c', 'user.name=Pace dataset', '-c', 'user.email=dataset@localhost', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Frozen fictional project');
  return { commit: await git('rev-parse', 'HEAD'), git };
}
export async function prepareMemoryDataset(executable: string, signal?: AbortSignal): Promise<{ repository: string; commit: string; seedSha256: string }> {
  assertDebug();
  const { pin, suite } = await memoryInputs(), repository = resolve(repositoryRoot, pin.localRepository);
  if (await stat(repository).catch(() => undefined)) throw new Error(`Dataset directory already exists: ${repository}. Preserve it; create a new dataset version instead of replacing frozen history.`);
  const root = await mkdtemp(join(tmpdir(), 'pace-memory-prepare-')), workspace = join(root, 'workspace'), base = join(root, 'store');
  const started = performance.now();
  await mkdir(repository, { recursive: true }); await mkdir(join(repository, 'history'));
  try {
    const files = JSON.parse(await readFile(join(repositoryRoot, 'benchmark/memory/project.json'), 'utf8')) as Record<string, string>;
    const fixture = await writeFixture(workspace, files);
    const config = await memorySetupService.setup(workspace, join(root, 'notes'), executable, base, signal);
    const calls = [];
    for (let i = 0; i < suite.preparation.length; i++) {
      signal?.throwIfAborted();
      const launch = await isolatedAppServer(workspace, join(root, `agent-${i}`));
      const runner = new AppServerRunner((message, exit) => new AppServer(message, exit, false, launch), undefined, false, 'pace-memory-history');
      const callStart = performance.now();
      const result = await runMemoryAgent({ prompt: suite.preparation[i]!, workspace, baseDir: base, route: suite.route, runner, memory: true, signal });
      const call = redactTrace({ prompt: suite.preparation[i], ...result.execution, durationMs: Math.round(performance.now() - callStart), costUsd: costForUsage(suite.route, result.execution.usage) ?? null });
      calls.push(call); await atomicJson(join(repository, 'history', `${i + 1}.json`), call);
      const changes = (await fixture.git('status', '--porcelain')).trim();
      if (changes) {
        await fixture.git('add', '-N', '.'); await writeFile(join(repository, 'history', `${i + 1}-unexpected.patch`), await fixture.git('diff', '--binary', 'HEAD'));
        throw new Error(`Historical preparation changed frozen project code: ${changes}`);
      }
    }
    const records = (await exportMemory(config)).records;
    if (records.filter(record => record.status === 'active').length < 3 || !records.some(record => record.relations.length)) throw new Error('Previous agent did not produce enough confirmed linked memories; preparation remains incomplete');
    const preparation = { model: suite.route.model, effort: suite.route.effort, usage: calls.map(call => call.usage ?? null), costUsd: calls.every(call => call.costUsd !== null) ? calls.reduce((sum, call) => sum + call.costUsd!, 0) : null, durationMs: Math.round(performance.now() - started) };
    const snapshot = await freezeMemory(config, new PaceStore(base), preparation), seed = JSON.stringify(snapshot, null, 2) + '\n';
    await writeFile(join(repository, 'seed.json'), seed);
    const stages = { base: files, 'rates-v2': { ...files, 'src/quotes.mjs': files['src/quotes.mjs']!.replace('national: 500', 'national: 700') } };
    for (const [stage, entries] of Object.entries(stages)) for (const [path, content] of Object.entries(entries)) {
      const target = join(repository, stage === 'base' ? 'project' : `stages/${stage}`, path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, content);
    }
    await atomicJson(join(repository, 'dataset-manifest.json'), { version: 1, id: pin.id, sourceCommit: fixture.commit, stages: Object.fromEntries(Object.entries(stages).map(([name, entries]) => [name, hash(JSON.stringify(entries))])), preparation, seedSha256: hash(seed), notes: records.length, evaluatorsIncluded: false });
    await writeFile(join(repository, 'README.md'), '# Parcel Desk memory dataset\n\nFictional code and confirmed memory from earlier Pace agents. Evaluation prompts and graders are held separately. Publication owner and visibility are pending. Do not edit a frozen seed; prepare a new dataset version.\n');
    const { commit } = await writeFixture(repository, {});
    await atomicJson(join(repositoryRoot, 'benchmark/memory/dataset.json'), { ...pin, commit, seedSha256: hash(seed), status: 'ready-local' });
    return { repository, commit, seedSha256: hash(seed) };
  } catch (error) {
    await atomicJson(join(repository, 'preparation-failure.json'), { at: new Date().toISOString(), error: String(error), durationMs: Math.round(performance.now() - started), completedHistory: 'See history/ for every completed call; incomplete accounting remains unknown' });
    throw error;
  } finally { await rm(root, { recursive: true, force: true }); }
}
