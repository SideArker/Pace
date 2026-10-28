import { readFile, readdir, lstat } from 'node:fs/promises';
import { join, relative, dirname } from 'node:path';
import { assertDebug, acquireLock, atomicJson, hash, inside, inventory, json, repositoryRoot, resultsRoot, runDirectory, resourceIsLive } from './storage.js';
import { account, readEvents } from './service.js';
import type { RunManifest, RunState } from './types.js';
export async function listResults(root=resultsRoot) {
  assertDebug();
  const entries=await readdir(root,{withFileTypes:true}).catch(error=>{if(error.code==='ENOENT')return [];throw error;});
  return Promise.all(entries.filter(e=>!e.name.startsWith('.')&&!e.isSymbolicLink()).map(async entry=>{
    const dir=join(root,entry.name);
    if(!entry.isDirectory())return {id:entry.name,label:`${entry.name} · historical file`,version:'historical',execution:'read-only'};
    const manifest=await json<RunManifest>(join(dir,'center-manifest.json')).catch(()=>undefined), state=await json<RunState>(join(dir,'state.json')).catch(()=>undefined);
    if(state?.execution==='running'&&!await resourceIsLive(root,entry.name))state.execution='interrupted';
    const legacy=await json<any>(join(dir,'manifest.json')).catch(()=>undefined);
    return {id:entry.name,label:`${entry.name} · ${state?.execution??'historical'} · ${state?.quality??'review unknown'}`,version:manifest?.schemaVersion??legacy?.version??'unknown',execution:state?.execution??'historical',category:manifest?.preview?.profile?.category,profile:manifest?.preview?.profile?.name};
  }));
}
export async function resultFiles(id:string,root=resultsRoot) {
  assertDebug();
  if((await listResults(root)).some(r=>r.id===id&&r.execution==='read-only'))return [id];
  const dir=await runDirectory(id,root);
  return (await inventory(dir)).map(file=>relative(dir,file)).filter(file=>!file.startsWith('scratch-')&&!file.includes('/store/')&&!file.endsWith('-input.json'));
}
export async function readResultFile(id:string,path:string,root=resultsRoot) {
  assertDebug(); const files=await resultFiles(id,root);
  if(files.length===1&&files[0]===id&&path===id)return readFile(inside(root,id),'utf8');
  const dir=await runDirectory(id,root);
  if(!files.includes(path))throw new Error('Result file not in this run');
  const full=inside(dir,path);if((await lstat(full)).size>2_000_000) return 'Large artifact; inspect locally: '+full;
  return readFile(full,'utf8');
}
export type Review = { pass: boolean; notes: string; severity: 'minor'|'major'|'critical'; evidence: string; affectedBehavior: string; preservedContext?: boolean;  };
export type ReviewItem = { path: string; sha256: string; label: string; run: any; review?: Review };
type Reviews = { version: 1; items: Record<string, Review & { sha256: string; at: string }> };
export async function reviewItems(id: string, root = resultsRoot): Promise<ReviewItem[]> {
  assertDebug(); const dir = await runDirectory(id, root);
  const saved = await json<Reviews>(join(dir, 'reviews.json')).catch(error => { if (error.code === 'ENOENT') return { version: 1 as const, items: {} as Reviews['items'] }; throw error; });
  if (saved.version !== 1 || !saved.items) throw new Error('Unsupported review schema');
  const items: ReviewItem[] = [];
  for (const file of await inventory(dir)) {
    if (!file.endsWith('/run.json')) continue;
    const run = await json<any>(file);
    if (!['fresh-completion', 'memory'].includes(run.benchmark)) continue;
    const path = relative(dir, file), sha256 = hash(await readFile(file)), review = saved.items[path];
    if (review && review.sha256 !== sha256) throw new Error(`Reviewed artifact identity changed: ${path}`);
    items.push({ path, sha256, run, review, label: `${run.id} / ${run.repetition} / ${run.arm} · ${run.error ? 'failed' : run.checksPassed ? 'checks passed; manual review required' : 'checks failed'}` });
  }
  return items;
}
export const qualityPass = (item: ReviewItem) => item.review?.pass === true && item.review.preservedContext === true && !item.run.error && item.run.completed === true && item.run.checksPassed === true;
export async function saveReview(id: string, item: Pick<ReviewItem, 'path'|'sha256'>, review: Review, root = resultsRoot) {
  assertDebug(); const dir = await runDirectory(id, root), release = await acquireLock(dir);
  try {
    const found = (await reviewItems(id, root)).find(row => row.path === item.path);
    if (!found || found.sha256 !== item.sha256) throw new Error('Review artifact identity changed');
    if (typeof review.pass !== 'boolean' || typeof review.preservedContext !== 'boolean' || !['minor', 'major', 'critical'].includes(review.severity) || !review.notes.trim() || !review.evidence.trim() || !review.affectedBehavior.trim()) throw new Error('Review requires quality/context decisions, severity, notes, evidence and affected behavior');
    const saved = await json<Reviews>(join(dir, 'reviews.json')).catch(error => { if (error.code === 'ENOENT') return { version: 1 as const, items: {} as Reviews['items'] }; throw error; });
    saved.items[item.path] = { ...review, sha256: item.sha256, at: new Date().toISOString() };
    await atomicJson(join(dir, 'reviews.json'), saved);
    const state = await json<RunState>(join(dir, 'state.json')).catch(() => undefined);
    if (state) {
      const rows = await reviewItems(id, root);
      state.quality = rows.some(row => row.review && !qualityPass(row)) ? 'failed' : state.execution === 'completed' && rows.length > 0 && rows.every(qualityPass) ? 'passed' : 'needs-review';
      await atomicJson(join(dir, 'state.json'), state);
    }
  } finally { await release(); }
}
export function familyComparisons(items: ReviewItem[]) {
  const groups = new Map<string, ReviewItem[]>();
  for (const item of items) { const key = `${item.run.id}/${item.run.repetition}/${item.run.pairId ?? item.path}`; groups.set(key, [...(groups.get(key) ?? []), item]); }
  return [...groups].map(([key, rows]) => {
    if (rows[0]?.run.benchmark === 'memory') {
      const baseline = rows.find(row => row.run.arm === 'baseline'), candidate = rows.find(row => row.run.arm === 'memory');
      const compatible = !!baseline && !!candidate && ['pairId', 'originalPromptSha256', 'fixtureSha256', 'verificationSha256', 'commit', 'datasetCommit', 'seedSha256'].every(field => typeof baseline.run[field] === 'string' && baseline.run[field] === candidate.run[field]) && JSON.stringify(baseline.run.route) === JSON.stringify(candidate.run.route) && JSON.stringify(baseline.run.policy) === JSON.stringify(candidate.run.policy);
      const qualityPassing = compatible && qualityPass(baseline!) && qualityPass(candidate!);
      const priced = typeof baseline?.run.estimatedCostUsd === 'number' && typeof candidate?.run.estimatedCostUsd === 'number';
      return { key, compatible, qualityPassing, group: baseline?.run.group ?? candidate?.run.group, baselineCostUsd: baseline?.run.estimatedCostUsd ?? null, candidateCostUsd: candidate?.run.estimatedCostUsd ?? null,
        deltaCostUsd: qualityPassing && priced ? candidate!.run.estimatedCostUsd - baseline!.run.estimatedCostUsd : null, scope: 'Current Codex calls only. Preparation, import, backend work and failures are separate. Unknown backend costs prevent a complete savings claim.' };
    }
    const baseline = rows.find(row => row.run.arm === 'same-thread'), candidate = rows.find(row => row.run.arm === 'fresh-thread');
    const compatible = !!baseline && !!candidate && ['pairId', 'historyThreadId', 'promptSha256', 'handoffSha256', 'fixtureSha256', 'verificationSha256', 'commit'].every(field => typeof baseline.run[field] === 'string' && baseline.run[field] === candidate.run[field]) &&
      JSON.stringify(baseline.run.route) === JSON.stringify(candidate.run.route) && JSON.stringify(baseline.run.input) === JSON.stringify(candidate.run.input) &&
      Array.isArray(baseline.run.input) && baseline.run.threadId === baseline.run.historyThreadId && candidate.run.threadId !== baseline.run.threadId;
    const qualityPassing = compatible && qualityPass(baseline!) && qualityPass(candidate!);
    const priced = typeof baseline?.run.estimatedCostUsd === 'number' && typeof candidate?.run.estimatedCostUsd === 'number';
    return { key, compatible, qualityPassing, baselineCostUsd: baseline?.run.estimatedCostUsd ?? null, candidateCostUsd: candidate?.run.estimatedCostUsd ?? null,
      deltaCostUsd: qualityPassing && priced ? candidate!.run.estimatedCostUsd - baseline!.run.estimatedCostUsd : null,
      scope: 'Completion calls only. Shared history/scout costs and all failures are recorded in pair.json and the attempt ledger.' };
  });
}
export async function resultSummary(id: string, root = resultsRoot) {
  assertDebug(); const dir = await runDirectory(id, root);
  const state = await json<RunState>(join(dir, 'state.json')).catch(() => undefined);
  if (state?.execution === 'running' && !await resourceIsLive(root, id)) state.execution = 'interrupted';
  const rows = await reviewItems(id, root), events = await readEvents(dir);
  return { state, accounting: account(events), comparisons: familyComparisons(rows), memory: rows.some(row => row.run.benchmark === 'memory') ? memorySummary(rows) : undefined, missingReviews: rows.filter(row => !row.review).length,
    note: 'Checks and manual quality/context review are separate. No production policy changes follow automatically. Small samples do not establish general savings.' };
}
export function memorySummary(rows: ReviewItem[]) {
  const memory = rows.filter(row => row.run.benchmark === 'memory');
  const pairs = familyComparisons(memory);
  const groups = ['equal-information', 'continuity'].map(group => {
    const selected = memory.filter(row => row.run.group === group), comparisons = pairs.filter(pair => 'group' in pair && pair.group === group);
    const values = comparisons.flatMap(pair => pair.deltaCostUsd === null ? [] : [pair.deltaCostUsd]);
    const mean = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
    const variance = values.length > 1 ? values.reduce((sum, value) => sum + (value - mean!) ** 2, 0) / (values.length - 1) : null;
    const t95 = [0, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262][Math.min(9, values.length - 1)] ?? 2.262;
    const width = variance === null ? null : t95 * Math.sqrt(variance / values.length);
    return { group, distinctTasks: new Set(selected.map(row => row.run.id)).size, matchedPairs: comparisons.length, qualityPassingPairs: comparisons.filter(pair => pair.qualityPassing).length,
      failedChecks: selected.filter(row => !row.run.checksPassed).length, failures: selected.filter(row => row.run.error).map(row => ({ task: row.run.id, arm: row.run.arm, error: row.run.error })),
      knownCurrentModelDeltaUsd: { n: values.length, mean, minimum: values.length ? Math.min(...values) : null, maximum: values.length ? Math.max(...values) : null, mean95Interval: width === null ? null : [mean! - width, mean! + width], assumption: 'Paired sample mean with Student-t approximation; small convenience samples do not establish general savings. Ungraded, incompatible or failed pairs are excluded.' } };
  });
  const distinctTasks = new Set(memory.map(row => row.run.id)).size;
  const preparation = memory[0]?.run.preparationCostUsd ?? null;
  const cycles = [...new Set(memory.filter(row => row.run.experiment === 'full-cycle').map(row => row.run.repetition))].map(repetition => {
    const selected = memory.filter(row => row.run.experiment === 'full-cycle' && row.run.repetition === repetition);
    return { repetition, arms: ['baseline', 'memory'].map(arm => {
      const current = selected.filter(row => row.run.arm === arm), history = current[0]?.run.cyclePreparation?.[arm];
      const currentModelCostUsd = current.length && current.every(row => !row.run.error && typeof row.run.estimatedCostUsd === 'number') ? current.reduce((sum, row) => sum + row.run.estimatedCostUsd, 0) : null;
      return { arm, historicalModelCostUsd: history?.modelCostUsd ?? null, currentModelCostUsd, wholeCycleModelCostUsd: history?.modelCostUsd !== null && history?.modelCostUsd !== undefined && currentModelCostUsd !== null ? history.modelCostUsd + currentModelCostUsd : null, backendCostUsd: null };
    }) };
  });
  return { groups, fullCycles: cycles, criticalFailures: memory.filter(row => row.review && !qualityPass(row) && row.review.severity === 'critical').map(row => ({ task: row.run.id, arm: row.run.arm, evidence: row.review!.evidence, affectedBehavior: row.review!.affectedBehavior })),
    datasetCommit: memory[0]?.run.datasetCommit, backendVersion: memory.find(row => row.run.arm === 'memory')?.run.backendVersion, policy: memory[0]?.run.policy,
    preparation: { totalHistoricalModelWorkUsd: preparation, memoryOnlyShareUsd: null, note: 'Historical work is shared context; its entire cost is not automatically memory-only overhead.' },
    importDurationMs: memory.reduce((sum, row) => sum + Number(row.run.importDurationMs ?? 0), 0),
    amortization: { distinctTasks, repeatedExecutionsDoNotIncreaseN: true, historicalModelWorkUsdPerDistinctTask: preparation === null || !distinctTasks ? null : preparation / distinctTasks },
    completeSavings: null, backendCostUsd: null, note: 'Backend/indexing billing is unknown. Tests require manual review; severity and affected behavior are preserved. No claim of zero overhead or complete savings is supported.' };
}
export async function analyzeResult(id: string, action: 'analyze'|'summarize'|'reaccount', root = resultsRoot): Promise<string> {
  if (action === 'reaccount') throw new Error('Reaccount belongs to the retired context/model experiment; raw recorded usage is preserved');
  return JSON.stringify(await resultSummary(id, root), null, 2);
}
