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
  const choices = [{ category: 'routing', profile: 'holdout' }, { category: 'task-control', profile: 'quick', baseline: '/existing/baseline' }];
  await Promise.all(choices.map(savePreferences));
  expect(choices).toContainEqual(await loadPreferences());
  expect(await readdir(directory)).toEqual(['benchmark-center.json', 'config.json']);
  expect(await readFile(join(directory, 'config.json'), 'utf8')).toBe('existing user config');
  if (process.platform !== 'win32') expect((await stat(join(directory, 'benchmark-center.json'))).mode & 0o777).toBe(0o600);
  await expect(stat(paths.repository)).rejects.toThrow();
});

it('offers built sibling checkouts and excludes current, incomplete, and symlinked checkouts', async () => {
  const { baselineChoices } = await import('../src/benchmark/preferences.js');
  const parent = join(root, 'checkouts');
  for (const name of ['current', 'baseline', 'build-only', 'prompts-only']) await mkdir(join(parent, name, 'dist/core'), { recursive: true });
  for (const name of ['current', 'baseline', 'build-only']) await writeFile(join(parent, name, 'dist/core/orchestrator.js'), 'built');
  for (const name of ['current', 'baseline', 'prompts-only']) await writeFile(join(parent, name, 'routing-prompts.default.json'), '{}');
  await writeFile(join(parent, 'ordinary-file'), 'not a checkout');
  const { symlink } = await import('node:fs/promises');
  await symlink(join(parent, 'baseline'), join(parent, 'linked'));
  expect(await baselineChoices()).toEqual([join(parent, 'baseline')]);
});
