import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rm, unlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { configureControl } from './control.js';
import { assertDebug, json, repositoryRoot, atomicJson } from './storage.js';
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
  configureControl({signal:abort.signal,events:payload.events,segment:payload.segment,completed:new Set(payload.completed),calls:payload.calls,knownUsd:payload.knownUsd,maxTurns:preview.maximumModelTurns,timeoutMs:Math.ceil(profile.timeoutMinutes*60000),maxUsd:preview.selection.maxUsd,prices:payload.manifest.priceSnapshot as any,onEvent:event=>{if(process.connected)process.send?.(event,()=>{});}});
  if (profile.category === 'memory') {
    const { runMemoryBenchmark } = await import('./drivers/memory.js');
    await runMemoryBenchmark({ preview, out: payload.out, signal: abort.signal });
  } else {
  const { runFreshCompletion, parseFreshSuite } = await import('./drivers/fresh-completion.js');
  const suite = parseFreshSuite(await json(join(repositoryRoot, profile.suite!)));
  await runFreshCompletion({ suite, repeats: profile.repeats, out: payload.out, signal: abort.signal, prompts: (preview.effectiveConfig as any).prompts });
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
