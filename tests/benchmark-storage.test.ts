import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock, inside, inventory, resourceIsLive, runDirectory } from '../src/benchmark/storage.js';
import { readResultFile, resultFiles } from '../src/benchmark/results.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'pace-benchmark-storage-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it.each(['', '.', '..', '../outside', '/outside'])('rejects paths outside the run or its root: %j', path => {
  expect(() => inside(root, path)).toThrow('Unsafe benchmark path');
});

it.each(['', '.', '..', '../outside', 'nested/run', 'nested\\run', 'run\0suffix'])('rejects invalid run IDs: %j', async id => {
  await expect(runDirectory(id, root)).rejects.toThrow('Invalid benchmark run ID');
});

it('does not expose symlinks, scratch workspaces, stores, or worker inputs in results', async () => {
  const dir = join(root, 'run'), outside = join(root, 'private');
  await mkdir(dir);
  await mkdir(outside);
  await writeFile(join(outside, 'grader.md'), 'excluded evidence');
  await symlink(outside, join(dir, 'grader'));
  await symlink(join(outside, 'grader.md'), join(dir, 'memory.md'));
  await symlink(dir, join(root, 'linked-run'));
  for (const path of ['scratch-1/workspace', 'segment-1/store']) await mkdir(join(dir, path), { recursive: true });
  for (const path of ['answer.md', 'scratch-1/workspace/secret.md', 'segment-1/store/session.json', 'segment-1-input.json']) await writeFile(join(dir, path), path);
  expect(await inventory(dir)).not.toContain(join(dir, 'memory.md'));
  expect(await resultFiles('run', root)).toEqual(['answer.md']);
  expect(await readResultFile('run', 'answer.md', root)).toBe('answer.md');
  for (const path of ['../private/grader.md', 'grader/grader.md', 'memory.md', 'scratch-1/workspace/secret.md', 'segment-1/store/session.json', 'segment-1-input.json']) {
    await expect(readResultFile('run', path, root)).rejects.toThrow('not in this run');
  }
  await expect(runDirectory('linked-run', root)).rejects.toThrow('symlink');
});

it('preserves foreign or malformed locks instead of guessing ownership', async () => {
  const path = join(root, '.benchmark-lock');
  for (const contents of [JSON.stringify({ pid: 2147483647, host: `${hostname()}-other`, nonce: 'foreign' }), '{torn', JSON.stringify({ pid: -1, host: hostname(), nonce: 'invalid' })]) {
    await writeFile(path, contents);
    await expect(acquireLock(root)).rejects.toThrow();
    expect(await readFile(path, 'utf8')).toBe(contents);
    expect(await readdir(root)).toEqual(['.benchmark-lock']);
  }
});

it('keeps a surviving owned worker locked even when its supervisor is dead', async () => {
  const path = join(root, '.benchmark-lock');
  const contents = JSON.stringify({ pid: 2147483647, host: hostname(), nonce: 'dead-parent', runId: 'run', child: { pid: process.pid } });
  await writeFile(path, contents);
  expect(await resourceIsLive(root, 'run')).toBe(true);
  expect(await resourceIsLive(root, 'another-run')).toBe(false);
  await expect(acquireLock(root)).rejects.toThrow('worker still owned');
  expect(await readFile(path, 'utf8')).toBe(contents);
});

it('does not let an old release remove a replacement owner lock', async () => {
  const release = await acquireLock(root), path = join(root, '.benchmark-lock');
  const replacement = { pid: process.pid, host: hostname(), nonce: 'replacement' };
  await writeFile(path, JSON.stringify(replacement));
  await release();
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(replacement);
  expect(await resourceIsLive(root)).toBe(true);
});
