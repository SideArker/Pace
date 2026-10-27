import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, appendFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyFrozenSources } from './drivers/context-models-continue.js';
import { benchmarkProvenance } from '../entrypoints/benchmark-provenance.js';
import { acquireLock, assertDebug, atomicJson, atomicWrite, hash, json, resultsRoot, repositoryRoot, runDirectory } from './storage.js';
import { preflight } from './preflight.js';
import type { Event, Preview, RunManifest, RunState, Selection } from './types.js';
export async function readEvents(dir: string): Promise<Event[]> {
  const text=await readFile(join(dir,'events.jsonl'),'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error;});
  // A crash may tear the final append. Preserve the bytes; only complete lines are evidence.
  return text.split('\n').slice(0,-1).filter(Boolean).map(line=>JSON.parse(line));
}
export function account(events: Event[]) {
  const started=events.filter(e=>e.kind==='call-started'),finished=events.filter(e=>e.kind==='call-finished');
  const completedIds=new Set(finished.map(e=>e.id));
  const provider=(name:string)=>{
    const starts=started.filter(e=>e.provider===name),rows=finished.filter(e=>e.provider===name);
    const knownSubtotalUsd=rows.reduce((s,e)=>s+Number(e.knownCostUsd??e.estimatedCostUsd??0),0);
    const complete=starts.length===rows.length&&rows.every(e=>typeof e.estimatedCostUsd==='number'&&Number.isFinite(e.estimatedCostUsd)&&(e.costComplete===true||e.usageComplete===true));
    const usage=Object.fromEntries(['input_tokens','cached_input_tokens','cache_write_input_tokens','output_tokens','reasoning_output_tokens'].map(key=>[key,rows.every(e=>typeof (e.knownUsage as any)?.[key]==='number')&&rows.length?rows.reduce((s,e)=>s+(e.knownUsage as any)[key],0):null]));
    return {attempts:starts.length,failures:rows.filter(e=>e.error).length,uncertain:starts.filter(e=>!completedIds.has(e.id)).length,knownSubtotalUsd,totalEstimatedUsd:complete?knownSubtotalUsd:null,usage,durationMs:rows.reduce((s,e)=>s+Number(e.durationMs??0),0)};
  };
  const trials=events.filter(e=>e.kind==='trial-finished');
  return {allAttempts:started.length,codex:provider('codex'),vex:provider('vex'),trialFailures:trials.filter(e=>e.execution==='failed').length,completedTrials:[...new Set(trials.filter(e=>e.execution==='completed').map(e=>String(e.key)))],note:'All attempts, including failures and interrupted calls. Quality-passing pairs are reported separately by the family grader. Unknown usage and Vex billing remain unknown.'};
}
type Options={preview?:Preview;root?:string;onEvent?:(event:Event)=>void;signal?:AbortSignal;canStart?:()=>string|undefined;registerChild?:(pid:number)=>Promise<void>};
export async function startRun(selection: Selection, options: Options={}) {
  assertDebug(); const preview=await preflight(selection);
  if(options.preview&&hash(JSON.stringify(options.preview))!==hash(JSON.stringify(preview)))throw new Error('Benchmark preview changed; refresh the preview before Start');
  const blocked=options.canStart?.(); if(blocked)throw new Error(blocked);
  const root=options.root??resultsRoot,release=await acquireLock(root);
  let runRelease:Awaited<ReturnType<typeof acquireLock>>|undefined;
  try {
    const provenance=await benchmarkProvenance();
    const id=`${preview.profile.category}-${new Date().toISOString().replace(/[^0-9]/g,'')}-${randomUUID().slice(0,8)}`;
    const dir=join(root,id);await mkdir(dir);
    const manifest:RunManifest={schemaVersion:1,id,createdAt:new Date().toISOString(),preview,...provenance,priceSnapshot:preview.profile.category==='context-models'?(await import('./drivers/context-models-support.js')).PRICES:JSON.parse(await readFile(join(repositoryRoot,'versions.json'),'utf8')).pricing,controlled:false};
    await atomicJson(join(dir,'center-manifest.json'),manifest);
    await release.setRun(id);runRelease=await acquireLock(dir);await runRelease.setRun(id);
    return await execute(dir,manifest,1,{...options,registerChild:async pid=>{await release.registerChild(pid);await runRelease!.registerChild(pid);}});
  } finally {try{await runRelease?.();}finally{await release();}}
}
export async function previewResume(id:string, root=resultsRoot) {
  assertDebug();const dir=await runDirectory(id,root);
  const manifest=await json<RunManifest>(join(dir,'center-manifest.json'));
  if(manifest.schemaVersion!==1)throw new Error('Unsupported manifest schema; preserve raw results');
  const accounting=account(await readEvents(dir));
  return {preview:manifest.preview,completedTrials:accounting.completedTrials.length,remainingTrials:manifest.preview.plan.filter(trial=>!accounting.completedTrials.includes(trial.key)).length,retainedCalls:accounting.allAttempts,knownSubtotalUsd:accounting.codex.knownSubtotalUsd+accounting.vex.knownSubtotalUsd,note:'Prior failed and interrupted calls retain their cost. The original call/dollar limits still apply; unfinished trials restart in fresh fixtures.'};
}
export async function resumeRun(id:string, options:Options={}) {
  assertDebug(); const root=options.root??resultsRoot,dir=await runDirectory(id,root);
  const blocked=options.canStart?.();if(blocked)throw new Error(blocked);
  const release=await acquireLock(root);
  let runRelease:Awaited<ReturnType<typeof acquireLock>>|undefined;
  try {
    runRelease=await acquireLock(dir);await runRelease.setRun(id);
    const manifest=await json<RunManifest>(join(dir,'center-manifest.json'));
    if(manifest.schemaVersion!==1)throw new Error('Unsupported manifest schema; preserve raw results');
    const state=await json<RunState>(join(dir,'state.json'));
    if(state.execution==='completed')throw new Error('Run already completed; successful trials are immutable');
    await verifyFrozenSources(manifest.sourceHashes,repositoryRoot);
    const [provenance,preview]=await Promise.all([benchmarkProvenance(),preflight(manifest.preview.selection)]);
    if(provenance.sourceSha256!==manifest.sourceSha256 || hash(JSON.stringify(preview))!==hash(JSON.stringify(manifest.preview))) throw new Error('Frozen source/config/fixture mismatch; start a new run');
    // Preserve the torn append, then delimit it before writing another event stream.
    const events=await readFile(join(dir,'events.jsonl'),'utf8').catch(()=> '');
    if(events && !events.endsWith('\n')) {
      await atomicJson(join(dir,`torn-events-${state.segment}.json`),{bytes:events.slice(events.lastIndexOf('\n')+1)});
      // Rewrite only the incomplete final record; complete calls and trials retain their exact bytes.
      await atomicWrite(join(dir,'events.jsonl'),events.slice(0,events.lastIndexOf('\n')+1));
    }
    for(const entry of await readdir(dir,{withFileTypes:true}))if(/^scratch-\d+$/.test(entry.name))await rm(join(dir,entry.name),{recursive:true,force:true});
    await release.setRun(id);
    return await execute(dir,manifest,state.segment+1,{...options,registerChild:async pid=>{await release.registerChild(pid);await runRelease!.registerChild(pid);}});
  } finally {try{await runRelease?.();}finally{await release();}}
}
async function execute(dir: string, manifest: RunManifest, segment: number, options: Options) {
  const previous = account(await readEvents(dir));
  const state: RunState = {
    version: 1, execution: options.signal?.aborted?'cancelled':'running', quality: manifest.preview.profile.paid ? 'needs-review' : 'diagnostic',
    segment, updatedAt: new Date().toISOString(),
  };
  await atomicJson(join(dir, 'state.json'), state);
  if(state.execution==='cancelled')return {id:manifest.id,dir,state,accounting:previous};
  const payload = join(dir, `segment-${segment}-input.json`);
  const out = join(dir, `segment-${segment}`);
  const events = join(dir, 'events.jsonl');
  const scratch = join(dir, `scratch-${segment}`);
  await mkdir(scratch);
  await atomicJson(payload, { manifest, out, events, segment, completed: previous.completedTrials,
    calls: previous.allAttempts, knownUsd: previous.codex.knownSubtotalUsd + previous.vex.knownSubtotalUsd });
  const fromTs = import.meta.url.endsWith('.ts');
  const worker = fileURLToPath(new URL(fromTs ? './worker.ts' : './worker.js', import.meta.url));
  const args = [...(manifest.preview.profile.category === 'diagnostics' ? ['--expose-gc'] : []),
    ...(fromTs ? ['--import', 'tsx'] : []), worker, payload];
  const blocked = options.canStart?.();
  if (blocked) throw new Error(blocked);
  const child = spawn(process.execPath, args, {
    cwd: repositoryRoot, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, TMPDIR: scratch, TEMP: scratch, TMP: scratch, VEX_STATS_PATH: join(dir, `segment-${segment}-vex-stats.json`) },
  });
  let failure: string | undefined;
  let cancelled = false;
  let logQueue = Promise.resolve();
  let snapshot = Promise.resolve();
  const closed = new Promise<number | null>(resolve => {
    child.once('error', error => { failure = String(error); resolve(1); });
    child.once('close', resolve);
  });
  const log = (channel: string, chunk: Buffer) => {
    logQueue = logQueue.then(() => appendFile(join(dir, `segment-${segment}.${channel}.log`), chunk))
      .catch(error => { failure = String(error); cancel(); });
    options.onEvent?.({ at: new Date().toISOString(), kind: 'log', channel, text: chunk.toString() });
  };
  child.stdout!.on('data', chunk => log('stdout', chunk));
  child.stderr!.on('data', chunk => log('stderr', chunk));
  child.on('message', event => {
    options.onEvent?.(event as Event);
    if (['call-finished', 'trial-finished'].includes((event as Event).kind)) {
      snapshot = snapshot.then(async () => atomicJson(join(dir, 'accounting.json'), account(await readEvents(dir))))
        .catch(error => { failure = String(error); cancel(); });
    }
  });
  const killGroup = (signal: NodeJS.Signals) => {
    try {
      if (process.platform === 'win32') {
        if (child.pid) spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
      } else if (child.pid) process.kill(-child.pid, signal);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') failure = String(error); }
  };
  let escalation: NodeJS.Timeout | undefined;
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    if (child.connected) child.send('cancel', () => {});
    killGroup('SIGTERM');
    escalation = setTimeout(() => killGroup('SIGKILL'), 5000);
  };
  let deadline: NodeJS.Timeout | undefined;
  let code: number | null = 1;
  try {
    if (child.pid) await options.registerChild?.(child.pid);
    options.signal?.addEventListener('abort', cancel, { once: true });
    if (options.signal?.aborted) cancel();
    deadline = setTimeout(() => { failure = 'Benchmark run time limit reached'; cancel(); },
      Math.max(1, manifest.preview.plan.length) * manifest.preview.profile.timeoutMinutes * 60000 * 8);
    code = await closed;
  } catch (error) {
    failure = String(error); cancel(); killGroup('SIGKILL'); await closed;
  } finally {
    if (deadline) clearTimeout(deadline);
    if (escalation) clearTimeout(escalation);
    options.signal?.removeEventListener('abort', cancel);
    killGroup('SIGKILL');
    await logQueue; await snapshot;
    await rm(scratch, { recursive: true, force: true });
  }
  const accounting = account(await readEvents(dir));
  const completed = manifest.preview.plan.every(trial => accounting.completedTrials.includes(trial.key));
  state.execution = cancelled ? 'cancelled' : code === 0 && completed && !failure ? 'completed' : 'failed';
  state.error = failure ?? (code ? `Driver exited ${code}; see stderr` : !completed ? 'One or more trials failed or were not executed' : undefined);
  state.updatedAt = new Date().toISOString();
  await atomicJson(join(dir, 'accounting.json'), accounting);
  await atomicJson(join(dir, 'state.json'), state);
  return { id: manifest.id, dir, state, accounting };
}
