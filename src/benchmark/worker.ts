import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, mkdir, mkdtemp, rm, unlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { configureControl, emit, beginTrial, finishTrial } from './control.js';
import { assertDebug, json, repositoryRoot, atomicJson } from './storage.js';
import { fetchDataset, prepareDatasetProject } from './datasets.js';
import type { RunManifest } from './types.js';
export async function worker(payload: {manifest:RunManifest;out:string;events:string;completed:string[];calls:number;knownUsd:number;segment?:number}) {
  assertDebug(); const abort=new AbortController();
  const cancel=()=>abort.abort(new Error('Benchmark cancelled'));
  const message=(value:unknown)=>{if(value==='cancel')cancel();};
  let disconnected=false;
  let watchdog:NodeJS.Timeout|undefined;
  const disconnect=()=>{
    if(disconnected)return;
    disconnected=true;cancel();
    // The service starts this worker as a process-group leader; only its descendants share this group.
    watchdog=setTimeout(()=>{if(process.platform==='win32')spawnSync('taskkill',['/pid',String(process.pid),'/t','/f']);else process.kill(-process.pid,'SIGKILL');},5000);
  };
  const hasParent=process.connected;
  process.on('SIGTERM',cancel);process.on('SIGINT',cancel);process.on('message',message);
  if(hasParent)process.on('disconnect',disconnect);
  const outputError=(error:NodeJS.ErrnoException)=>{if(error.code==='EPIPE')disconnect();else cancel();};
  process.stdout.on('error',outputError);process.stderr.on('error',outputError);
  try {
  const {preview}=payload.manifest, profile=preview.profile;
  configureControl({signal:abort.signal,events:payload.events,segment:payload.segment,completed:new Set(payload.completed),calls:payload.calls,knownUsd:payload.knownUsd,maxTurns:preview.maximumModelTurns,timeoutMs:Math.ceil(profile.timeoutMinutes*60000),maxUsd:preview.selection.maxUsd,effective:preview.effectiveConfig as any,prices:payload.manifest.priceSnapshot as any,onEvent:event=>{if(process.connected)process.send?.(event,()=>{});}});
  let suite=profile.suite&&join(repositoryRoot,profile.suite);
  if(preview.selection.dataset) {
    const dataset=await json(preview.selection.dataset);
    const cached=await fetchDataset(dataset,{offline:preview.selection.offline,signal:abort.signal,onEvent:kind=>emit(kind)});
    const project=await prepareDatasetProject(cached.project);
    process.env.PACE_BENCHMARK_DATASET_PROJECT=project;
    const original=JSON.parse(await readFile(suite!,'utf8')); original.repository=project;original.ref='HEAD';for(const task of original.cases)delete task.ref;
    suite=join(payload.out+'-inputs','suite.json');await mkdir(payload.out+'-inputs',{recursive:true});await atomicJson(suite,original);
    emit('dataset-working-copy',{project,sourceCommit:cached.dataset.commit,controlled:false});
  }
  if(['workflows','context-quality'].includes(profile.category)&&!preview.selection.dataset) {
    const original=JSON.parse(await readFile(suite!,'utf8'));
    if(profile.category==='workflows'){original.repository=resolve(repositoryRoot,original.repository);for(const task of original.cases)task.ref=preview.resolvedCommits[task.ref??original.ref??'HEAD'];}
    else for(const task of original.cases)if(task.repository){task.repository=resolve(repositoryRoot,task.repository);task.ref=preview.resolvedCommits[`${task.id}/${task.ref??'HEAD'}`];}
    suite=join(payload.out+'-inputs','suite.json');await mkdir(payload.out+'-inputs',{recursive:true});await atomicJson(suite,original);
  }
  if(profile.driver==='thread-switch')process.chdir(await mkdtemp(join(tmpdir(),'pace-thread-switch-')));
  const args=[...profile.args,...(suite?['--suite',suite]:[])];
  if(preview.selection.baseline)args.push('--baseline-dir',preview.selection.baseline);
  if(profile.driver==='session-persistence') {
    if(beginTrial('persistence')) { await mkdir(payload.out); const rows:string[]=[]; const log=console.log;
      console.log=(...values:unknown[])=>{rows.push(values.join(' '));log(...values);};
      try { await (await import('./drivers/session-persistence.js')).main(args); await writeFile(join(payload.out,'metrics.jsonl'),rows.join('\n')+'\n');finishTrial(); } finally { console.log=log; }
    }
  } else if(profile.driver==='routing') {
    const {benchmarkArgs}=await import('../entrypoints/routing-benchmark-cli.js');
    await (await import('../entrypoints/routing-benchmark-runner.js')).runRouting(benchmarkArgs([...args,'--out',payload.out])!);
  } else if(profile.driver==='context-models-probe') {
    if(beginTrial('probe')) { await (await import('./drivers/context-models-probe.js')).main([payload.out]); const probes=await Promise.all(profile.variants.map(model=>json<any>(join(payload.out,model+'.json')).catch(()=>({error:'not executed'}))));finishTrial(probes.some(probe=>probe.error)); }
  } else {
    args.push('--out',profile.driver==='thread-switch'?join(payload.out,'thread-switch.json'):payload.out);
    const modules={ 'runner/workflows':()=>import('./drivers/runner/workflows.js'), 'task-control':()=>import('./drivers/task-control.js'), 'context-quality':()=>import('./drivers/context-quality.js'), 'thread-switch':()=>import('./drivers/thread-switch.js'), 'context-models':()=>import('./drivers/context-models.js') };
    const load=modules[profile.driver as keyof typeof modules]; if(!load)throw new Error('Unknown benchmark driver');
    await (await load()).main(args);
  }
  abort.signal.throwIfAborted();
  } finally {
    process.off('SIGTERM',cancel);process.off('SIGINT',cancel);process.off('message',message);process.off('disconnect',disconnect);process.stdout.off('error',outputError);process.stderr.off('error',outputError);
    configureControl(undefined);
    if(watchdog)clearTimeout(watchdog);
    if(disconnected) {
      await rm(join(dirname(payload.out),`scratch-${payload.segment}`),{recursive:true,force:true});
      for(const lock of [join(dirname(payload.out),'.benchmark-lock'),join(dirname(dirname(payload.out)),'.benchmark-lock')]){
        const owner=await json<{runId:string;child?:{pid:number}}>(lock).catch(()=>undefined);
        if(owner?.runId===payload.manifest.id&&owner.child?.pid===process.pid)await unlink(lock);
      }
      if(process.platform==='win32')spawnSync('taskkill',['/pid',String(process.pid),'/t','/f']);else process.kill(-process.pid,'SIGKILL');
    }
  }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try { await worker(await json(process.argv[2]!)); }
  catch(error) { console.error(String(error));process.exitCode=1; }
  finally { process.disconnect?.(); }
}
