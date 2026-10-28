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
  if (profile.category === 'memory') {
    const [{ memoryInputs }, { detectBasicMemory, validateBasicMemory }, { MEMORY_POLICY, BASIC_MEMORY_VERSION }, { checkMemoryIsolation }] = await Promise.all([
      import('./memory-dataset.js'), import('../integrations/basic-memory.js'), import('../core/memory/config.js'), import('./isolation.js'),
    ]);
    if (selection.baseline || selection.source || selection.dataset) throw new Error('Memory uses its pinned dataset and production policy; baseline/source/dataset overrides are not permitted');
    for (const [key, value] of [['maxUsd', selection.maxUsd], ['maxTurns', selection.maxTurns], ['repeats', selection.repeats]] as const)
      if (value !== undefined && (!Number.isFinite(value) || value <= 0 || key !== 'maxUsd' && !Number.isSafeInteger(value))) throw new Error(`${key} must be positive`);
    const { pin, suite, suiteHash } = await memoryInputs(), blockedReasons: string[] = [];
    if (profile.name === 'confirm') {
      const repeats = selection.repeats ?? suite.confirmRepeats;
      if (!repeats) blockedReasons.push('Confirm requires repetitions chosen from pilot variance before Start: --repeats N');
      else profile.repeats = repeats;
    } else if (selection.repeats) throw new Error('Only Confirm accepts a repetition override; Standard is fixed at three');
    if (profile.name !== 'prepare' && (!pin.commit || !pin.seedSha256)) blockedReasons.push('Prepare the local frozen dataset first with benchmark run memory --profile prepare; publication still requires owner/URL and visibility');
    let executable = process.env.PACE_MEMORY_EXECUTABLE;
    if (executable) { try { await validateBasicMemory(executable); } catch (error) { blockedReasons.push(String(error)); executable = undefined; } }
    else executable = (await detectBasicMemory()).executable;
    if (!executable) blockedReasons.push('Basic Memory is missing. Open /memory setup, or use Memory setup in Benchmark Center. No automatic installation occurs on Start.');
    try { await checkMemoryIsolation(); } catch (error) { blockedReasons.push(String(error)); }
    const cases = profile.name === 'quick' ? suite.cases.filter(task => task.id === 'similar-bug') : profile.name === 'confirm' ? suite.holdout : suite.cases;
    const plan = profile.name === 'prepare' ? [{ key: 'preparation/1', description: `${suite.preparation.length} historical agent calls; freeze linked memory without exposing future tasks or graders` }]
      : profile.name === 'full-cycle' ? [{ key: 'cycle/1', description: `${suite.preparation.length * 2} earlier agent calls, followed by ${cases.length} distinct matched A/B tasks (${cases.length * 2} calls)` }]
      : cases.flatMap(task => Array.from({ length: profile.repeats }, (_, i) => ({ key: `${task.id}/${i + 1}`, description: `${task.id} / ${task.group} / ${task.stage}: baseline + fresh memory import (${i + 1})` })));
    const maximumModelTurns = selection.maxTurns ?? (profile.name === 'prepare' ? suite.preparation.length : profile.name === 'full-cycle' ? suite.preparation.length * 2 + cases.length * 2 : plan.length * 2);
    return { selection: { category: 'memory', profile: profile.name, maxTurns: maximumModelTurns, maxUsd: selection.maxUsd ?? profile.maxUsd, controlled: true, offline: !!selection.offline, ...(selection.repeats ? { repeats: selection.repeats } : {}) },
      profile, suiteHash, plan, maximumModelTurns, datasetHash: pin.seedSha256 ?? undefined, datasetManifest: pin, resolvedCommits: pin.commit ? { dataset: pin.commit } : {}, blockedReasons,
      dependencies: ['Linux bubblewrap; host filesystem isolation and shell network sandbox', `Basic Memory ${BASIC_MEMORY_VERSION}`, 'Existing Codex auth.json', ...(pin.remote ? ['Pinned dataset HTTPS download'] : ['Prepared local dataset repository; remote publication pending'])],
      effectiveConfig: { executable, route: suite.route, policy: MEMORY_POLICY, backendVersion: BASIC_MEMORY_VERSION, maximumQualityRegression: suite.maximumQualityRegression, criticalFailurePolicy: suite.criticalFailurePolicy },
      estimate: `At most ${maximumModelTurns} Codex calls, ${profile.timeoutMinutes} minutes/call, threshold $${selection.maxUsd ?? profile.maxUsd}. Preparation/import and backend costs reported separately; unknown stays unknown. No Vex calls.`,
      baselineScope: 'Same code snapshot, request and fixed model/effort; isolated copies, sessions, Git history and memory namespaces. B uses the production memory adapter. Continuity is separate from equal-information quality.' };
  }
  if (selection.repeats !== undefined) throw new Error('Repetition override does not apply to fresh completion');
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
