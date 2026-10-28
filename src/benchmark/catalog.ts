import type { Category, Profile } from './types.js';
export const categories: { id: Category; label: string; unavailable?: string }[] = [
  { id: 'fresh-completion', label: 'Scout → same / fresh completion thread' },
  { id: 'memory', label: 'Project memory · Basic Memory / baseline' },
];
export const catalog: readonly Profile[] = [...[1, 3].map(repeats => ({
  category: 'fresh-completion' as const, name: repeats === 1 ? 'quick' : 'standard', version: 1 as const,
  label: repeats === 1 ? 'quick' : 'standard', driver: 'fresh-completion',
  suite: 'benchmark/suites/fresh-completion.json', args: [], variants: ['same-thread', 'fresh-thread'], repeats,
  route: 'Scout: gpt-6-luna / low; completion: gpt-6.1-sol / medium',
  evaluation: 'Identical real scout, request, prompt, route, fixture and verification; only prior Codex history differs. External checks + manual context/quality review.',
  paid: true, timeoutMinutes: 4, maxUsd: repeats === 1 ? 2 : 6,
})), ...['quick', 'standard', 'confirm', 'full-cycle', 'prepare'].map(name => ({
  category: 'memory' as const, name, label: name, version: 1 as const, driver: 'memory', suite: 'benchmark/memory/scenarios.json', args: [], variants: ['baseline', 'memory'], repeats: name === 'standard' ? 3 : 1,
  route: 'gpt-6.1-sol / medium · identical fixed route in both arms',
  evaluation: name === 'prepare' ? 'Paid historical agent work only; freeze fictional code, linked memory and source provenance into a separate local dataset repository. No evaluation prompts are exposed.' : name === 'full-cycle' ? 'Earlier tasks in both arms, capture in B, then six distinct new tasks; complete preparation/current accounting.' : name === 'confirm' ? 'Independent frozen holdout; choose repetitions from pilot variance before Start.' : 'Frozen earlier-agent memory; quality, severity, current cost, preparation/import cost and time. Continuity reported separately.',
  paid: true, timeoutMinutes: 4, maxUsd: name === 'quick' ? 2 : 12,
}))];
export function getProfile(category: string, name: string): Profile {
  const profile = catalog.find(p => p.category === category && p.name === name);
  if (!profile) throw new Error(`Unknown benchmark profile: ${category}/${name}`);
  return structuredClone(profile);
}
