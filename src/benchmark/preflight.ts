import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getProfile } from './catalog.js';
import { assertDebug, hash, repositoryRoot } from './storage.js';
import { parseFreshSuite } from './drivers/fresh-completion.js';
import { DEFAULT_ROUTING_PROMPTS } from '../core/routing/routing-prompts.js';
import type { Preview, Selection } from './types.js';
export async function preflight(selection: Selection): Promise<Preview> {
  assertDebug();
  const profile = getProfile(selection.category, selection.profile);
  if (selection.controlled) throw new Error('Filesystem/network isolation is unavailable; this is an uncontrolled local benchmark');
  if (selection.baseline || selection.source || selection.dataset || selection.offline) throw new Error('Baseline/source/dataset/offline options do not apply to fresh completion');
  for (const [key, value] of [['maxUsd', selection.maxUsd], ['maxTurns', selection.maxTurns]] as const)
    if (value !== undefined && (!Number.isFinite(value) || value <= 0 || (key === 'maxTurns' && !Number.isSafeInteger(value)))) throw new Error(`${key} must be positive${key === 'maxTurns' ? ' integer' : ''}`);
  const text = await readFile(join(repositoryRoot, profile.suite!), 'utf8');
  const suite = parseFreshSuite(JSON.parse(text));
  const plan = suite.cases.flatMap(task => Array.from({ length: profile.repeats }, (_, i) => ({ key: `${task.id}/${i + 1}`, description: `${task.id}: shared history + real scout, both completion arms (${i + 1})` })));
  const normalized = { category: profile.category, profile: profile.name, maxTurns: selection.maxTurns ?? plan.length * 4, maxUsd: selection.maxUsd ?? profile.maxUsd };
  return { selection: normalized, profile, suiteHash: hash(text), plan, maximumModelTurns: normalized.maxTurns,
    estimate: `At most ${normalized.maxTurns} Codex calls, ${profile.timeoutMinutes} minutes/call, estimated API threshold $${normalized.maxUsd}. Current call can exceed dollar threshold; unknown billing stays unknown. No Vex calls.`,
    resolvedCommits: {}, dependencies: ['Node', 'Git', 'Existing Codex login (access checked on Start)'],
    effectiveConfig: { scout: suite.scout, completion: suite.completion, prompts: DEFAULT_ROUTING_PROMPTS },
  };
}
