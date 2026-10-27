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
    if (run.benchmark !== 'fresh-completion') continue;
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
  return { state, accounting: account(events), comparisons: familyComparisons(rows), missingReviews: rows.filter(row => !row.review).length,
    note: 'Checks and manual quality/context review are separate. No production policy changes follow automatically. Small samples do not establish general savings.' };
}
export async function analyzeResult(id: string, action: 'analyze'|'summarize'|'reaccount', root = resultsRoot): Promise<string> {
  if (action === 'reaccount') throw new Error('Reaccount belongs to the retired context/model experiment; raw recorded usage is preserved');
  return JSON.stringify(await resultSummary(id, root), null, 2);
}
