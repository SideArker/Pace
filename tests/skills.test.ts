import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configuredSkills, defaultSkillFolder, discoverSkills, enabledSkills, skillCommand, skillPrompt } from '../src/core/system/skills.js';
import { existingFolder } from '../src/core/system/folders.js';
import { parseConfig, DEFAULT_CONFIG } from '../src/shared/config.js';
import { Orchestrator } from '../src/core/orchestrator.js';
import { PaceStore, newSession } from '../src/core/sessions.js';
import type { CodexRunner } from '../src/integrations/codex.js';
import { singleVex } from './routing-fixture.js';
import type { VexRequest } from '../src/core/vex/client.js';

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
  expect(folders[0]).toBe(trusted);
  expect(folders[1]).toMatch(/\/artifacts$/);
  expect(received).toContain('review: Review code changes.');
  await orchestrator.turn('/review inspect this', newSession(dir, 'auto'), config, () => {});
  expect(received).toContain(`/review (${join(skillFolder, 'review', 'SKILL.md')})`);
  await orchestrator.turn('Check this', newSession(dir, 'auto'), { ...config, disabledSkills: ['review'] }, () => {});
  expect(received).not.toContain('review: Review code changes.');
  await expect(orchestrator.turn('Check this', newSession(dir, 'auto'), { ...config, trustedFolders: [join(dir, 'missing')] }, () => {})).rejects.toThrow();
});

it('rejects invalid folder settings', () => {
  expect(() => parseConfig({ ...DEFAULT_CONFIG, trustedFolders: 'all' })).toThrow('trustedFolders');
  expect(() => parseConfig({ ...DEFAULT_CONFIG, skillFolder: 42 })).toThrow('skillFolder');
  expect(() => parseConfig({ ...DEFAULT_CONFIG, disabledSkills: ['/bad'] })).toThrow('disabledSkills');
});

it('uses the home skills folder by default and allows disabling it', async () => {
  expect(defaultSkillFolder()).toBe(join((await import('node:os')).homedir(), '.agents', 'skills'));
  expect(await configuredSkills({ ...DEFAULT_CONFIG, skillFolder: null })).toEqual([]);
  expect(parseConfig({ ...DEFAULT_CONFIG, skillFolder: null }).skillFolder).toBeNull();
});

it('bundles grill-me, allows disabling it, and prefers a user copy', async () => {
  dir = await mkdtemp(join(tmpdir(), 'pace-bundled-skill-'));
  const bundled = await configuredSkills({ ...DEFAULT_CONFIG, skillFolder: dir });
  expect(bundled.some(skill => skill.name === 'grill-me')).toBe(true);
  expect(skillCommand('/grill-me review this idea', bundled)?.name).toBe('grill-me');
  expect(skillCommand('/grill-me', enabledSkills(bundled, { ...DEFAULT_CONFIG, disabledSkills: ['grill-me'] }))).toBeUndefined();
  await mkdir(join(dir, 'grill-me'));
  await writeFile(join(dir, 'grill-me', 'SKILL.md'), '---\nname: grill-me\ndescription: User interview.\n---\nAsk questions.');
  const overridden = await configuredSkills({ ...DEFAULT_CONFIG, skillFolder: dir });
  expect(overridden.filter(skill => skill.name === 'grill-me')).toHaveLength(1);
  expect(overridden.find(skill => skill.name === 'grill-me')?.path).toBe(join(dir, 'grill-me', 'SKILL.md'));
});

it('invokes enabled skill commands with their file path and user arguments', async () => {
  dir = await mkdtemp(join(tmpdir(), 'pace-skills-'));
  await mkdir(join(dir, 'caveman'));
  await writeFile(join(dir, 'caveman', 'SKILL.md'), '---\nname: caveman\ndescription: Respond briefly.\n---\nInstructions');
  const config = parseConfig({ ...DEFAULT_CONFIG, skillFolder: dir });
  const skills = enabledSkills(await configuredSkills(config), config);
  expect(skillCommand('/caveman explain this', skills)?.name).toBe('caveman');
  expect(skillPrompt('/caveman explain this', skills)).toContain(`/${skills[0]!.name} (${skills[0]!.path})`);
  expect(skillPrompt('/caveman explain this', skills)).toMatch(/^explain this\n/);
  expect(enabledSkills(skills, { ...config, disabledSkills: ['caveman'] }).some(skill => skill.name === 'caveman')).toBe(false);
  expect(skillCommand('/caveman', enabledSkills(skills, { ...config, disabledSkills: ['caveman'] }))).toBeUndefined();
});

it('keeps a skill active across turns and routes only user requests', async () => {
  dir = await mkdtemp(join(tmpdir(), 'pace-skills-'));
  await mkdir(join(dir, 'caveman'));
  await writeFile(join(dir, 'caveman', 'SKILL.md'), '---\nname: caveman\ndescription: Respond briefly.\n---\nInstructions');
  const config = parseConfig({ ...DEFAULT_CONFIG, skillFolder: dir });
  const store = new PaceStore(join(dir, 'store'));
  const session = newSession(dir, 'auto');
  const requests: string[] = [];
  const prompts: string[] = [];
  const baseVex = singleVex('0:medium');
  const vex = { verify: async () => {}, choose: async (request: VexRequest) => {
    if (request.context.originalRequest) requests.push(String(request.context.originalRequest));
    return baseVex.choose(request);
  } };
  const runner: CodexRunner = { async run(prompt) { prompts.push(prompt); return { result: 'done', completed: true }; } };
  const orchestrator = new Orchestrator(store, runner, vex);
  await orchestrator.turn('/caveman lite', session, config, () => {});
  expect(requests).toEqual([]);
  expect(prompts).toEqual([]);
  expect(session.activeSkills).toEqual(['caveman']);
  expect(session.skillOptions).toEqual({ caveman: 'lite' });
  await orchestrator.turn('/caveman explain this', session, config, () => {});
  expect(requests).toEqual(['explain this', 'explain this']);
  expect(prompts[0]).toContain('/caveman lite');
  expect(prompts[0]).toMatch(/^explain this\n/);
  const restored = (await store.latest(dir))!;
  await orchestrator.turn('Another question', restored, config, () => {});
  expect(prompts[1]).toContain('/caveman lite');
  await orchestrator.turn('/caveman off', restored, config, () => {});
  await orchestrator.turn('Normal question', restored, config, () => {});
  expect(prompts[2]).toContain('No skills are active for this conversation');
});

it('routes an @skill mention unchanged and applies the skill for that turn', async () => {
  dir = await mkdtemp(join(tmpdir(), 'pace-mentions-'));
  await mkdir(join(dir, 'rigorous-code-review'));
  await writeFile(join(dir, 'rigorous-code-review', 'SKILL.md'), '---\nname: rigorous-code-review\ndescription: Review Git changes.\n---\nReview instructions');
  const config = parseConfig({ ...DEFAULT_CONFIG, skillFolder: dir });
  const skill = (await configuredSkills(config))[0]!;
  const requests: VexRequest[] = [];
  const prompts: string[] = [];
  const baseVex = singleVex('0:medium');
  const vex = { verify: async () => {}, choose: async (request: VexRequest) => {
    if (request.context.originalRequest) requests.push(request);
    return baseVex.choose(request);
  } };
  const runner: CodexRunner = { async run(prompt) { prompts.push(prompt); return { result: 'done', completed: true }; } };
  const session = newSession(dir, 'auto');
  const orchestrator = new Orchestrator(new PaceStore(join(dir, 'store')), runner, vex);
  await orchestrator.turn('@rigorous-code-review', session, config, () => {});
  expect(requests[0]?.context.originalRequest).toBe('@rigorous-code-review');
  expect(prompts[0]).toMatch(/^@rigorous-code-review\n/);
  expect(prompts[0]).toContain(`/rigorous-code-review (${skill.path})`);
  expect(session.activeSkills).toEqual([]);
  await orchestrator.turn('Next question', session, config, () => {});
  expect(prompts[1]).toContain('No skills are active for this conversation');
  expect(requests[2]?.context.recentConversation).toEqual([{ user: '@rigorous-code-review', assistant: 'done' }]);
  await orchestrator.turn('Please @rigorous-code-review inspect staged changes', session, config, () => {});
  expect(requests[4]?.context.originalRequest).toBe('Please @rigorous-code-review inspect staged changes');
  expect(prompts[2]).toContain('Current user request:\nPlease @rigorous-code-review inspect staged changes\n');
  expect(prompts[2]).toContain(`/rigorous-code-review (${skill.path})`);
  expect(session.activeSkills).toEqual([]);
});
