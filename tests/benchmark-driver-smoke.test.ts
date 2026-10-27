import React from 'react';
import { PassThrough, Writable } from 'node:stream';
import { render } from 'ink';
import { BenchmarkManager, type BenchmarkService } from '../src/components/BenchmarkManager.js';
import { benchmarkCommand, benchmarkCommandService } from '../src/entrypoints/benchmark-cli.js';
import { preflight } from '../src/benchmark/preflight.js';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { catalog } from '../src/benchmark/catalog.js';
import { worker } from '../src/benchmark/worker.js';
import { configureControl } from '../src/benchmark/control.js';
import { inventory, repositoryRoot } from '../src/benchmark/storage.js';
import { readEvents, account } from '../src/benchmark/service.js';
import { AppServerRunner } from '../src/integrations/app-server-runner.js';
import { SdkRunner } from '../src/integrations/codex.js';
import { VexRouter } from '../src/core/vex/client.js';
import * as models from '../src/integrations/models.js';
import type { RunManifest } from '../src/benchmark/types.js';
const exec=promisify(execFile),roots=new Set<string>();
class Terminal extends Writable {isTTY=true;columns=120;rows=40;writes:string[]=[];override _write(chunk:Buffer,_encoding:BufferEncoding,done:()=>void){this.writes.push(chunk.toString());done();}}
afterEach(async()=>{configureControl(undefined);vi.restoreAllMocks();await Promise.all([...roots].map(root=>rm(root,{recursive:true,force:true})));roots.clear();});
it('runs all model families through the shared worker with fake transports and equivalent CLI/UI artifacts',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pace-driver-smoke-'));roots.add(root);
 vi.spyOn(process,'chdir').mockImplementation(path=>{roots.add(path);});
 const repository=join(root,'repo');await mkdir(repository);await writeFile(join(repository,'package.json'),'{}');
 for(const args of [['init','-q'],['add','.'],['-c','user.name=Test','-c','user.email=test@localhost','commit','-qm','fixture']])await exec('git',args,{cwd:repository});
 const commit=(await exec('git',['rev-parse','HEAD'],{cwd:repository})).stdout.trim();
 const usage={input_tokens:100,cached_input_tokens:20,cache_write_input_tokens:0,output_tokens:10,reasoning_output_tokens:0};let turn=0;
 const fake=async(prompt:string,project:string,route:any,thread:string|undefined)=>{
  if(project.startsWith(tmpdir())&&project!==repository)roots.add(project.split('/workspace')[0]!);
  return {completed:true,threadId:thread??`fake-thread-${++turn}`,route,usage,usageComplete:true,result:prompt.startsWith('Create a checkpoint')?JSON.stringify({complete:true,goal:'Fixture',constraints:[],findings:[],changes:[],checks:[],unfinished:[],questions:[],risks:[]}):prompt.includes('nextSteps')?JSON.stringify({summary:'Fixture',findings:[],nextSteps:[],checks:[],risks:[]}):'src/csv.js src/queue.js src/report.js mock answer',context:{tokens:60000,windowTokens:240000,model:route.model}};
 };
 vi.spyOn(AppServerRunner.prototype,'run').mockImplementation(fake);
 vi.spyOn(AppServerRunner.prototype,'compact').mockResolvedValue({outcome:'completed',durationMs:1,usage} as any);
 vi.spyOn(SdkRunner.prototype,'run').mockImplementation(fake);
 vi.spyOn(VexRouter.prototype,'verify').mockResolvedValue();vi.spyOn(VexRouter.prototype,'close').mockResolvedValue();
 vi.spyOn(VexRouter.prototype,'choose').mockImplementation(async request=>{const choice=request.options.find(o=>o.id==='single')?.id??request.options[0]!.id;return {contractVersion:'1',choice,abstained:false,confidence:1,probabilities:Object.fromEntries(request.options.map(o=>[o.id,o.id===choice?1:0]))};});
 vi.spyOn(models,'readAvailableModels').mockResolvedValue([{model:'gpt-6.1-sol',efforts:['medium','high']},{model:'gpt-6-luna',efforts:['low']}]);
 vi.spyOn(console,'log').mockImplementation(()=>{});
 const task={id:'fixture',cohort:'pilot',long:true,files:{'package.json':'{}'},setup:['Inspect fixture'],followups:['First followup','Second followup'],check:"console.log('PASS')",rubric:'Fixture only',summaryFacts:[]};
 for(const category of ['routing','workflows','task-control','context-quality','thread-switch','context-models']) {
  const profile=structuredClone(catalog.find(p=>p.category===category&&p.name==='quick')!);
  const suite=category==='routing'?{version:1,cases:[{id:'fixture',category:'test',prompt:'Read fixture',preferred:'single',acceptable:['single'],reason:'Smoke'}]}
    :category==='workflows'?{repository,ref:commit,cases:[{id:'fixture',prompt:'Read fixture',rubric:'Smoke'}]}
    :category==='task-control'?{version:1,cases:[{id:'fixture',split:'development',language:'en',goal:'Read fixture',previous:'Partial',prompt:'Describe modules',shape:'single',lead:'medium',checks:'analysis',expectedActions:['continue','replace']}]}
    :{cases:[task]};
  if(profile.suite){const file=join(root,category+'.json');await writeFile(file,JSON.stringify(suite));profile.suite=relative(repositoryRoot,file);}
  const signatures:any[]=[];
  const selections:any[]=[];
  const originalPreview=await preflight({category,profile:'quick'});
  const fakePreflight:typeof preflight=async selection=>({...originalPreview,profile,selection:{category:selection.category,profile:selection.profile}});
  let caller='cli';
  const executeFake:typeof benchmarkCommandService.startRun=async selection=>{
   selections.push((await fakePreflight(selection)).selection);
   const dir=join(root,category+'-'+caller);await mkdir(dir);const events=join(dir,'events.jsonl');
   const manifest={schemaVersion:1,id:'fake',preview:{...(await fakePreflight(selection)),maximumModelTurns:1000,resolvedCommits:{[commit]:commit}}} as unknown as RunManifest;
   await worker({manifest,out:join(dir,'segment-1'),events,completed:[],calls:0,knownUsd:0});configureControl(undefined);
   const paths=(await inventory(join(dir,'segment-1'))).filter(p=>p.endsWith('/run.json')&&!p.includes('/blind/'));
   const runs=await Promise.all(paths.map(async path=>{const r=JSON.parse(await readFile(path,'utf8'));return {id:r.id??r.case,arm:r.arm??r.variant,family:r.family,repeat:r.repetition??r.repeat,error:!!r.error};}));
   if(category==='thread-switch'){const data=JSON.parse(await readFile(join(dir,'segment-1/thread-switch.json'),'utf8'));runs.push(...data.trials.map((t:any)=>({history:t.historyTurns,repeat:t.repeat,arms:t.arms.map((a:any)=>a.arm)})));}
   const accounting=account(await readEvents(dir));
   signatures.push({runs,trials:(await readEvents(dir)).filter(e=>e.kind==='trial-finished').map(e=>({key:e.key,execution:e.execution})),calls:accounting.allAttempts});
   return {id:'fake',dir,state:{version:1,segment:1,execution:'completed',quality:'needs-review',updatedAt:'now'},accounting};
  };
  await benchmarkCommand(['run',category,'--profile','quick'],{...benchmarkCommandService,preflight:fakePreflight,startRun:executeFake});
  caller='ui';
  const stdout=new Terminal(),stdin=Object.assign(new PassThrough(),{isTTY:true,setRawMode:()=>{},ref:()=>{},unref:()=>{}});
  const service={preflight:fakePreflight,startRun:executeFake,loadPreferences:async()=>undefined,savePreferences:async()=>{},baselineChoices:async()=>[]} as unknown as BenchmarkService;
  const ui=render(React.createElement(BenchmarkManager,{width:120,height:38,onClose:()=>{},service}),{stdin,stdout,stderr:new PassThrough(),interactive:true,patchConsole:false,alternateScreen:false,maxFps:1000});
  const key=async(input:string)=>{stdin.write(input);await ui.waitUntilRenderFlush();await new Promise(resolve=>setTimeout(resolve,10));};
  try {
    await ui.waitUntilRenderFlush();await key('\r');
    for(let i=0;i<['routing','workflows','task-control','context-quality','thread-switch','context-models'].indexOf(category);i++)await key('\x1b[B');
    await key('\r');await key('\r');if(category==='task-control')await key('\r');
    await vi.waitFor(()=>expect(stdout.writes.join('')).toContain('Explicit Start consumes allowance.'));
    await key('\r');await vi.waitFor(()=>expect(signatures).toHaveLength(2),{timeout:15000});
  } finally {ui.unmount();}
  expect(selections[0]).toEqual(selections[1]);
  expect(signatures[0],category).toEqual(signatures[1]);expect(signatures[0].trials.length,category).toBeGreaterThan(0);
  expect(signatures[0].trials.every((trial:any)=>trial.execution==='completed'),category).toBe(true);
 }
},30000);
