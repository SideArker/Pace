import { execFile } from 'node:child_process';
import { mkdir, readFile, mkdtemp, rm, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { z } from 'zod';
import { hash, repositoryRoot, assertDebug } from './storage.js';
import { snapshotSchema } from '../core/memory/snapshot.js';

const exec = promisify(execFile);
const digest = z.string().regex(/^[a-f0-9]{64}$/), sha = z.string().regex(/^[a-f0-9]{40}$/);
export const memoryPinSchema = z.object({ version: z.literal(1), id: z.string().regex(/^[a-z0-9-]+$/), remote: z.url().nullable(), visibility: z.enum(['public', 'private']).nullable(), localRepository: z.string(), commit: sha.nullable(), seedSha256: digest.nullable(), status: z.enum(['preparation-required', 'ready-local', 'published']) });
export type MemoryPin = z.infer<typeof memoryPinSchema>;
export const memoryCaseSchema = z.object({ id: z.string().regex(/^[a-z0-9-]+$/), group: z.enum(['continuity', 'equal-information']), language: z.enum(['en', 'pl']), stage: z.enum(['base', 'rates-v2']), prompt: z.string().min(1), rubric: z.string().min(1), verification: z.string().min(1), severity: z.enum(['minor', 'major', 'critical']) });
export const memorySuiteSchema = z.object({ version: z.literal(1), route: z.object({ model: z.string(), effort: z.literal('medium') }), confirmRepeats: z.number().int().positive().nullable(), maximumQualityRegression: z.literal(0), criticalFailurePolicy: z.string(), preparation: z.array(z.string()).min(1), cases: z.array(memoryCaseSchema).length(6), holdout: z.array(memoryCaseSchema).min(1) });
export type MemoryCase = z.infer<typeof memoryCaseSchema>;
export async function memoryInputs() {
  const [pinText, suiteText] = await Promise.all(['dataset.json', 'scenarios.json'].map(name => readFile(join(repositoryRoot, 'benchmark/memory', name), 'utf8')));
  return { pin: memoryPinSchema.parse(JSON.parse(pinText!)), suite: memorySuiteSchema.parse(JSON.parse(suiteText!)), suiteHash: hash(suiteText!) };
}
export async function fetchMemoryDataset(pin: MemoryPin, offline = false, signal?: AbortSignal, cacheRoot = join(homedir(), '.pace', 'benchmark-datasets')) {
  assertDebug();
  if (!pin.commit || !pin.seedSha256) throw new Error('Memory dataset preparation is incomplete; no fabricated repository URL or seed is configured');
  const target = join(cacheRoot, `${pin.id}-${pin.commit}`);
  const git = async (cwd: string, ...args: string[]) => (await exec('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, signal, timeout: 60_000, maxBuffer: 8_000_000 })).stdout;
  const verify = async () => {
    if ((await git(target, 'rev-parse', '--verify', pin.commit!)).trim() !== pin.commit) throw new Error('Pinned dataset commit mismatch');
    const seedText = await git(target, 'show', `${pin.commit}:seed.json`);
    if (hash(seedText) !== pin.seedSha256) throw new Error('Frozen memory export checksum mismatch');
    return snapshotSchema.parse(JSON.parse(seedText));
  };
  try { return { directory: target, snapshot: await verify() }; }
  catch (error) {
    if (offline) throw new Error(`Pinned Memory dataset unavailable offline: ${String(error)}`);
    await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
    const temporary = await mkdtemp(join(cacheRoot, '.memory-download-'));
    try {
      const origin = pin.remote ?? resolve(repositoryRoot, pin.localRepository);
      if (pin.remote && !pin.remote.startsWith('https://')) throw new Error('Dataset remote must use HTTPS');
      await git(temporary, 'clone', '--no-checkout', '--no-hardlinks', '--', origin, join(temporary, 'repository'));
      const repo = join(temporary, 'repository');
      await git(repo, 'cat-file', '-e', `${pin.commit}^{commit}`);
      const seedText = await git(repo, 'show', `${pin.commit}:seed.json`);
      if (hash(seedText) !== pin.seedSha256) throw new Error('Downloaded memory export checksum mismatch');
      // Keep an existing corrupt cache for inspection instead of deleting user-owned files.
      try { await rename(repo, target); }
      catch (renameError) { if (!['EEXIST', 'ENOTEMPTY'].includes((renameError as NodeJS.ErrnoException).code ?? '')) throw renameError; }
      return { directory: target, snapshot: await verify() };
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }
}
export async function datasetProject(directory: string, commit: string, stage: MemoryCase['stage'], signal?: AbortSignal): Promise<Record<string, string>> {
  const prefix = stage === 'base' ? 'project/' : 'stages/rates-v2/';
  const git = async (...args: string[]) => (await exec('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: directory, signal, timeout: 10_000, maxBuffer: 2_000_000 })).stdout;
  const listing = await git('ls-tree', '-rz', commit, '--', prefix), files: Record<string, string> = {};
  for (const entry of listing.split('\0').filter(Boolean)) {
    const match = /^(100644|100755) blob [a-f0-9]{40}\t(.+)$/.exec(entry);
    if (!match || !match[2]!.startsWith(prefix)) throw new Error('Dataset contains a symlink, submodule or invalid file');
    const path = match[2]!.slice(prefix.length);
    if (!path || path.startsWith('/') || /(^|[\\/])(?:\.\.|\.git)(?:[\\/]|$)/.test(path) || path.includes('\\')) throw new Error('Unsafe dataset working copy path');
    files[path] = await git('show', `${commit}:${match[2]}`);
  }
  if (!files['package.json'] || !files['test.mjs']) throw new Error('Dataset project snapshot is incomplete');
  return files;
}
