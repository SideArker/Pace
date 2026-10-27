import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const paths = vi.hoisted(() => ({ home: '', repository: '' }));
vi.mock('node:os', async importOriginal => ({ ...await importOriginal<typeof import('node:os')>(), homedir: () => paths.home }));
vi.mock('../src/benchmark/storage.js', async importOriginal => ({ ...await importOriginal<typeof import('../src/benchmark/storage.js')>(), get repositoryRoot() { return paths.repository; } }));

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pace-benchmark-preferences-'));
  paths.home = join(root, 'home');
  paths.repository = join(root, 'checkouts', 'current');
  vi.resetModules();
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it('treats absent or interrupted preference files as no previous selection', async () => {
  const { loadPreferences } = await import('../src/benchmark/preferences.js');
  expect(await loadPreferences()).toBeUndefined();
  await mkdir(join(paths.home, '.pace'), { recursive: true });
  await writeFile(join(paths.home, '.pace/benchmark-center.json'), '{interrupted');
  expect(await loadPreferences()).toBeUndefined();
});

it('atomically stores concurrent selections outside the repository and preserves global config', async () => {
  const { loadPreferences, savePreferences } = await import('../src/benchmark/preferences.js');
  const directory = join(paths.home, '.pace');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'config.json'), 'existing user config');
  const choices = [{ category: 'fresh-completion', profile: 'quick' }, { category: 'fresh-completion', profile: 'standard' }];
  await Promise.all(choices.map(savePreferences));
  expect(choices).toContainEqual(await loadPreferences());
  expect(await readdir(directory)).toEqual(['benchmark-center.json', 'config.json']);
  expect(await readFile(join(directory, 'config.json'), 'utf8')).toBe('existing user config');
  if (process.platform !== 'win32') expect((await stat(join(directory, 'benchmark-center.json'))).mode & 0o777).toBe(0o600);
  await expect(stat(paths.repository)).rejects.toThrow();
});
