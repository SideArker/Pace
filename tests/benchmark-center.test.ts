import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { catalog } from '../src/benchmark/catalog.js';
import { parseBenchmarkArgs } from '../src/entrypoints/benchmark-cli.js';
import { preflight } from '../src/benchmark/preflight.js';
import { account, readEvents, startRun, resumeRun } from '../src/benchmark/service.js';
import { acquireLock, atomicJson, hash, inventory } from '../src/benchmark/storage.js';
import { configureControl, beginTrial, finishTrial, modelCall } from '../src/benchmark/control.js';
import { VexRouter } from '../src/core/vex/client.js';
import { AppServerRunner } from '../src/integrations/app-server-runner.js';
const roots:string[]=[];
async function temporary(){const root=await mkdtemp(join(tmpdir(),'pace-center-test-'));roots.push(root);return root;}
afterEach(async()=>{configureControl(undefined);vi.restoreAllMocks();await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
it('imports every migrated driver without inference, exit, or file writes',async()=>{
 const vex=vi.spyOn(VexRouter.prototype,'choose').mockRejectedValue(new Error('unexpected inference'));
 const codex=vi.spyOn(AppServerRunner.prototype,'run').mockRejectedValue(new Error('unexpected inference'));
 const exit=vi.spyOn(process,'exit');
 await import('../src/benchmark/drivers/fresh-completion.js');
 expect(vex).not.toHaveBeenCalled();expect(codex).not.toHaveBeenCalled();expect(exit).not.toHaveBeenCalled();
});
it('lists each family and builds the same profile configuration for CLI and UI without models',async()=>{
 const vex=vi.spyOn(VexRouter.prototype,'choose');const codex=vi.spyOn(AppServerRunner.prototype,'run');
 for(const category of ['fresh-completion']){
  const parsed=parseBenchmarkArgs(['run',category,'--profile','quick']);
  const cli=await preflight({category:parsed.positional[1]!,profile:parsed.values['--profile']!,offline:false,controlled:false});
  expect(cli).toEqual(await preflight({category,profile:'quick'}));expect(cli.plan.length).toBeGreaterThan(0);
 }
 expect([...new Set(catalog.map(p=>p.category))]).toEqual(['fresh-completion','memory']);expect(vex).not.toHaveBeenCalled();expect(codex).not.toHaveBeenCalled();
});
it('rejects unknown and inapplicable options, invalid budgets, unavailable memory and missing frozen confirmation sources',async()=>{
 expect(()=>parseBenchmarkArgs(['run','routing','--profiel','quick'])).toThrow('Unknown flag');
 expect(()=>parseBenchmarkArgs(['--profile'])).toThrow();
 await expect(preflight({category:'memory',profile:'unknown'})).rejects.toThrow('Unknown benchmark profile');
 await expect(preflight({category:'fresh-completion',profile:'quick',maxTurns:NaN})).rejects.toThrow();
 await expect(preflight({category:'context-models',profile:'confirmation-A'})).rejects.toThrow('Unknown benchmark profile');
 await expect(preflight({category:'task-control',profile:'quick',baseline:'/missing-built-checkout'})).rejects.toThrow();
});
it('journals failed, missing-usage and interrupted calls separately from completed quality pairs',async()=>{
 const root=await temporary(),events=join(root,'events.jsonl');const controller=new AbortController();
 configureControl({signal:controller.signal,events,completed:new Set(['already-done']),maxTurns:8,calls:0,knownUsd:0});
 expect(beginTrial('already-done')).toBe(false);expect(beginTrial('fresh')).toBe(true);
 const usage={input_tokens:100,cached_input_tokens:10,cache_write_input_tokens:0,output_tokens:5,reasoning_output_tokens:0};
 await modelCall('codex',{model:'gpt-6.1-sol'},async()=>({usage}));
 await expect(modelCall('codex',{model:'gpt-6.1-sol'},async()=>{throw Object.assign(new Error('transport'),{usage});})).rejects.toThrow();
 await modelCall('codex',{},async()=>({usage:undefined}));finishTrial(true);
 const rows=await readEvents(root),totals=account(rows);
 expect(totals.codex.attempts).toBe(3);expect(totals.codex.failures).toBe(1);expect(totals.codex.knownSubtotalUsd).toBeGreaterThan(0);expect(totals.codex.totalEstimatedUsd).toBeNull();expect(totals.completedTrials).toEqual([]);
 await writeFile(events,'{"kind": "torn"',{flag:'a'});expect(await readEvents(root)).toEqual(rows);
 const interrupted=account([...rows,{kind:'call-started',provider:'codex',id:'interrupted',at:'now'}]);expect(interrupted.codex.uncertain).toBe(1);
});
it('cancels during an in-flight fake model call, records uncertainty and stops the next call',async()=>{
 const root=await temporary(),abort=new AbortController();configureControl({signal:abort.signal,events:join(root,'events.jsonl'),completed:new Set(),maxTurns:4,calls:0,knownUsd:0});
 const promise=modelCall('codex',{},()=>new Promise((_resolve,reject)=>abort.signal.addEventListener('abort',()=>reject(new Error('cancelled')))));
 abort.abort();await expect(promise).rejects.toThrow('cancelled');await expect(modelCall('codex',{},async()=>({usage:undefined}))).rejects.toThrow();
 expect(account(await readEvents(root)).allAttempts).toBe(1);
});
it('atomically preserves old data when serialization fails and enforces resource ownership',async()=>{
 const root=await temporary(),file=join(root,'state.json');await atomicJson(file,{old:true});
 const circular:any={};circular.self=circular;await expect(atomicJson(file,circular)).rejects.toThrow();expect(JSON.parse(await readFile(file,'utf8'))).toEqual({old:true});expect(await inventory(root)).toEqual([file]);
 const release=await acquireLock(root);await expect(acquireLock(root)).rejects.toThrow('owned');await release();
 await writeFile(join(root,'.benchmark-lock'),JSON.stringify({pid:2147483647,host:(await import('node:os')).hostname(),nonce:'dead'}));const recovered=await acquireLock(root);await recovered();
});
it('enforces the advertised per-call timeout and refuses a reported fallback route',async()=>{
 const root=await temporary(),abort=new AbortController();configureControl({signal:abort.signal,events:join(root,'events.jsonl'),completed:new Set(),maxTurns:4,timeoutMs:20,calls:0,knownUsd:0});
 const {combinedSignal}=await import('../src/benchmark/control.js');const signal=combinedSignal()!;
 await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));expect(signal.aborted).toBe(true);
 await expect(modelCall('codex',{model:'expected'},async()=>({route:{model:'fallback'},usage:undefined}))).rejects.toThrow('mismatch');
 expect(account(await readEvents(root)).codex.failures).toBe(1);
});
it('serializes competing stale-lock recoveries and refuses a changed preview before allocating a run',async()=>{
 const root=await temporary();await writeFile(join(root,'.benchmark-lock'),JSON.stringify({pid:2147483647,host:(await import('node:os')).hostname(),nonce:'stale'}));
 const attempts=await Promise.allSettled([acquireLock(root),acquireLock(root)]);
 const leases=attempts.filter((attempt):attempt is PromiseFulfilledResult<Awaited<ReturnType<typeof acquireLock>>>=>attempt.status==='fulfilled');
 expect(leases).toHaveLength(1);await leases[0]!.value();expect(await inventory(root)).toEqual([]);
 const preview=await preflight({category:'fresh-completion',profile:'quick'});preview.maximumModelTurns=1;
 await expect(startRun({category:'fresh-completion',profile:'quick'},{root,preview})).rejects.toThrow('preview changed');expect(await inventory(root)).toEqual([]);
});
it('retains the threshold-crossing call and keeps partially missing usage unknown',async()=>{
 const root=await temporary(),events=join(root,'events.jsonl'),signal=new AbortController().signal;
 configureControl({signal,events,completed:new Set(),maxTurns:3,maxUsd:0.00001,calls:0,knownUsd:0});
 await modelCall('codex',{model:'gpt-6.1-sol'},async()=>({usage:{input_tokens:1000,cached_input_tokens:0,cache_write_input_tokens:0,output_tokens:10,reasoning_output_tokens:0}}));
 await expect(modelCall('codex',{},async()=>({usage:undefined}))).rejects.toThrow('threshold');expect(account(await readEvents(root)).allAttempts).toBe(1);
 configureControl({signal,events,completed:new Set(),maxTurns:3,calls:0,knownUsd:0});
 await modelCall('codex',{model:'gpt-6.1-sol'},async()=>({usage:{input_tokens:100,output_tokens:10} as any}));
 expect(account(await readEvents(root)).codex.totalEstimatedUsd).toBeNull();
});
