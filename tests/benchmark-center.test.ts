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
 await Promise.all([import('../benchmark/runner/workflows.js'),import('../benchmark/task-control.js'),import('../benchmark/context-quality.js'),import('../benchmark/thread-switch.js'),import('../benchmark/context-models.js'),import('../benchmark/context-models-probe.js'),import('../benchmark/context-models-continue.js'),import('../benchmark/context-models-reaccount.js'),import('../benchmark/session-persistence.js'),import('../benchmark/grading/grade.js')]);
 expect(vex).not.toHaveBeenCalled();expect(codex).not.toHaveBeenCalled();expect(exit).not.toHaveBeenCalled();
});
it('lists each family and builds the same profile configuration for CLI and UI without models',async()=>{
 const vex=vi.spyOn(VexRouter.prototype,'choose');const codex=vi.spyOn(AppServerRunner.prototype,'run');
 for(const category of ['routing','workflows','task-control','context-quality','thread-switch','context-models','diagnostics']){
  const parsed=parseBenchmarkArgs(['run',category,'--profile','quick']);
  const cli=await preflight({category:parsed.positional[1]!,profile:parsed.values['--profile']!,offline:false,controlled:false});
  expect(cli).toEqual(await preflight({category,profile:'quick'}));expect(cli.plan.length).toBeGreaterThan(0);
  if(category==='task-control')expect(cli.baselineScope).toContain('Candidate-only');
  if(category==='context-models'){expect(cli.plan).toHaveLength(16);expect(cli.plan[0]!.key).toContain('/A/');}
 }
 expect(catalog.some(p=>p.category==='memory')).toBe(false);expect(vex).not.toHaveBeenCalled();expect(codex).not.toHaveBeenCalled();
});
it('rejects unknown and inapplicable options, invalid budgets, unavailable memory and missing frozen confirmation sources',async()=>{
 expect(()=>parseBenchmarkArgs(['run','routing','--profiel','quick'])).toThrow('Unknown flag');
 expect(()=>parseBenchmarkArgs(['--profile'])).toThrow();
 await expect(preflight({category:'memory',profile:'quick'})).rejects.toThrow('plan 02');
 await expect(preflight({category:'diagnostics',profile:'quick',maxTurns:NaN})).rejects.toThrow();
 await expect(preflight({category:'context-models',profile:'confirmation-A'})).rejects.toThrow('frozen');
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
it('runs persistence with GC and no account, releases locks, then rejects mutation before resume',async()=>{
 const root=await temporary();const result=await startRun({category:'diagnostics',profile:'quick'},{root});
 expect(result.state.execution).toBe('completed');expect(result.accounting.allAttempts).toBe(0);
 const text=await readFile(join(result.dir,'segment-1/metrics.jsonl'),'utf8');const metrics=text.trim().split('\n').map(line=>JSON.parse(line));expect(metrics).toHaveLength(3);expect(metrics.every(m=>m.gcAvailable&&m.assertionsPassed)).toBe(true);
 const state=JSON.parse(await readFile(join(result.dir,'state.json'),'utf8'));state.execution='interrupted';await atomicJson(join(result.dir,'state.json'),state);
 const manifest=JSON.parse(await readFile(join(result.dir,'center-manifest.json'),'utf8'));manifest.sourceSha256=hash('different frozen source');await atomicJson(join(result.dir,'center-manifest.json'),manifest);
 await expect(resumeRun(result.id,{root})).rejects.toThrow('Frozen');const release=await acquireLock(root);await release();
},30000);
it('cancels a real owned diagnostic process, cleans scratch/locks, and resumes into a separate segment',async()=>{
 const root=await temporary(),abort=new AbortController();
 const first=await startRun({category:'diagnostics',profile:'quick'},{root,signal:abort.signal,onEvent:event=>{if(event.kind==='trial-started')abort.abort();}});
 expect(first.state.execution).toBe('cancelled');expect((await inventory(first.dir)).some(path=>path.includes('/scratch-'))).toBe(false);
 const second=await resumeRun(first.id,{root});expect(second.state.execution).toBe('completed');expect(second.state.segment).toBe(2);expect(second.accounting.allAttempts).toBe(0);
 const file=join(second.dir,'segment-2/metrics.jsonl'),before=await readFile(file,'utf8');
 const state=JSON.parse(await readFile(join(second.dir,'state.json'),'utf8'));state.execution='interrupted';await atomicJson(join(second.dir,'state.json'),state);
 const third=await resumeRun(first.id,{root});expect(third.state.execution).toBe('completed');expect(await readFile(file,'utf8')).toBe(before);
 const events=await readEvents(first.dir);expect(events.some(e=>e.kind==='trial-skipped'&&e.key==='persistence')).toBe(true);
},30000);
it('enforces the advertised per-call timeout and refuses a reported fallback route',async()=>{
 const root=await temporary(),abort=new AbortController();configureControl({signal:abort.signal,events:join(root,'events.jsonl'),completed:new Set(),maxTurns:4,timeoutMs:20,calls:0,knownUsd:0});
 const {combinedSignal}=await import('../src/benchmark/control.js');const signal=combinedSignal()!;
 await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));expect(signal.aborted).toBe(true);
 await expect(modelCall('codex',{model:'expected'},async()=>({route:{model:'fallback'},usage:undefined}))).rejects.toThrow('mismatch');
 expect(account(await readEvents(root)).codex.failures).toBe(1);
});
it('stops an orphaned diagnostic worker after its supervisor crashes and makes the run resumable',async()=>{
 const root=await temporary();
 const {spawn}=await import('node:child_process');const {pathToFileURL}=await import('node:url');
 const {repositoryRoot,resourceIsLive}=await import('../src/benchmark/storage.js');
 const script=`import {startRun} from ${JSON.stringify(pathToFileURL(join(repositoryRoot,'src/benchmark/service.ts')).href)};await startRun({category:'diagnostics',profile:'quick'},{root:${JSON.stringify(root)},onEvent:e=>{if(e.kind==='trial-started')process.stdout.write('TRIAL_STARTED\\n');}});`;
 const supervisor=spawn(process.execPath,['--import','tsx','--input-type=module','-e',script],{cwd:repositoryRoot,stdio:['ignore','pipe','pipe']});
 let output='';supervisor.stdout.on('data',data=>{output+=data.toString();});
 try {
  await vi.waitFor(()=>expect(output).toContain('TRIAL_STARTED'),{timeout:10000});supervisor.kill('SIGKILL');
  await new Promise<void>(resolve=>supervisor.once('close',()=>resolve()));
  await vi.waitFor(async()=>expect(await resourceIsLive(root)).toBe(false),{timeout:10000});
  const {listResults,resultSummary}=await import('../src/benchmark/results.js');const [entry]=await listResults(root);
  expect(entry?.execution).toBe('interrupted');expect((await resultSummary(entry!.id,root)).state?.execution).toBe('interrupted');
  expect((await inventory(root)).some(path=>path.includes('/scratch-'))).toBe(false);
  const resumed=await resumeRun(entry!.id,{root});expect(resumed.state.execution).toBe('completed');
 } finally {
  supervisor.kill('SIGKILL');
  const lock=await readFile(join(root,'.benchmark-lock'),'utf8').then(text=>JSON.parse(text)).catch(()=>undefined);
  if(lock?.child?.pid)try{process.kill(-lock.child.pid,'SIGKILL');}catch{}
 }
},30000);
it('serializes competing stale-lock recoveries and refuses a changed preview before allocating a run',async()=>{
 const root=await temporary();await writeFile(join(root,'.benchmark-lock'),JSON.stringify({pid:2147483647,host:(await import('node:os')).hostname(),nonce:'stale'}));
 const attempts=await Promise.allSettled([acquireLock(root),acquireLock(root)]);
 const leases=attempts.filter((attempt):attempt is PromiseFulfilledResult<Awaited<ReturnType<typeof acquireLock>>>=>attempt.status==='fulfilled');
 expect(leases).toHaveLength(1);await leases[0]!.value();expect(await inventory(root)).toEqual([]);
 const preview=await preflight({category:'diagnostics',profile:'quick'});preview.maximumModelTurns=1;
 await expect(startRun({category:'diagnostics',profile:'quick'},{root,preview})).rejects.toThrow('preview changed');expect(await inventory(root)).toEqual([]);
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
