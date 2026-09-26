import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverSkills, skillPrompt } from '../src/core/system/skills.js';
import { existingFolder } from '../src/core/system/folders.js';
import { parseConfig, DEFAULT_CONFIG } from '../src/config.js';
import { Orchestrator } from '../src/core/orchestrator.js';
import { PaceStore, newSession } from '../src/core/sessions.js';
import type { CodexRunner } from '../src/integrations/codex.js';
import { singleVex } from './routing-fixture.js';

let dir: string;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

it('discovers only direct skills in the selected folder and handles folded descriptions', async () => {
  dir = await mkdtemp(join(tmpdir(), 'pace-skills-'));
  await mkdir(join(dir, 'review'));
  await mkdir(join(dir, 'invalid'));
  await writeFile(join(dir, 'review', 'SKILL.md'), '---\nname: review\ndescription: >\n  Review changes\n  before release.\n---\nInstructions');
  await writeFile(join(dir, 'invalid', 'SKILL.md'), 'No frontmatter');
  const skills = await discoverSkills(dir);
  expect(skills).toMatchObject([{ name: 'review', description: 'Review changes before release.' }]);
  expect(skillPrompt('Work', skills)).toContain(skills[0]!.path);
  expect(skillPrompt('Work', [])).toBe('Work');
});

it('validates trusted folders before execution and passes skill names to the runner', async () => {
  dir = await mkdtemp(join(tmpdir(), 'pace-skills-'));
  const trusted = await existingFolder(dir);
  const skillFolder = join(dir, 'skills');
  await mkdir(join(skillFolder, 'review'), { recursive: true });
  await writeFile(join(skillFolder, 'review', 'SKILL.md'), '---\nname: review\ndescription: Review code changes.\n---\nInstructions');
  const config = parseConfig({ ...DEFAULT_CONFIG, models: [{ model: 'gpt-6-sol', efforts: ['medium'] }], defaultRoute: { model: 'gpt-6-sol', effort: 'medium' }, trustedFolders: [trusted], skillFolder });
  let received = '';
  let folders: string[] = [];
  const runner: CodexRunner = { async run(prompt, _project, _route, _thread, _progress, _signal, _mode, trustedFolders) {
    received = prompt; folders = trustedFolders ?? [];
    return { result: 'done', completed: true };
  } };
  const orchestrator = new Orchestrator(new PaceStore(join(dir, 'store')), runner, singleVex('0:medium'));
  await orchestrator.turn('Check this', newSession(dir, 'auto'), config, () => {});
  expect(folders).toEqual([trusted]);
  expect(received).toContain('review: Review code changes.');
  await expect(orchestrator.turn('Check this', newSession(dir, 'auto'), { ...config, trustedFolders: [join(dir, 'missing')] }, () => {})).rejects.toThrow();
});

it('rejects invalid folder settings', () => {
  expect(() => parseConfig({ ...DEFAULT_CONFIG, trustedFolders: 'all' })).toThrow('trustedFolders');
  expect(() => parseConfig({ ...DEFAULT_CONFIG, skillFolder: 42 })).toThrow('skillFolder');
});
