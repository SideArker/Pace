import type { Category, Profile } from './types.js';
export const categories: { id: Category; label: string; unavailable?: string }[] = [
  { id: 'fresh-completion', label: 'Scout → same / fresh completion thread' },
];
export const catalog: readonly Profile[] = [1, 3].map(repeats => ({
  category: 'fresh-completion', name: repeats === 1 ? 'quick' : 'standard', version: 1,
  label: repeats === 1 ? 'quick' : 'standard', driver: 'fresh-completion',
  suite: 'benchmark/suites/fresh-completion.json', args: [], variants: ['same-thread', 'fresh-thread'], repeats,
  route: 'Scout: gpt-6-luna / low; completion: gpt-6.1-sol / medium',
  evaluation: 'Identical real scout, request, prompt, route, fixture and verification; only prior Codex history differs. External checks + manual context/quality review.',
  paid: true, timeoutMinutes: 4, maxUsd: repeats === 1 ? 2 : 6,
}));
export function getProfile(category: string, name: string): Profile {
  const profile = catalog.find(p => p.category === category && p.name === name);
  if (!profile) throw new Error(`Unknown benchmark profile: ${category}/${name}`);
  return structuredClone(profile);
}
