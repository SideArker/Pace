import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile, readdir, mkdtemp } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { AppServerRunner } from '../src/integrations/app-server-runner.js';
import { CodexRunError, type Progress, type Execution } from '../src/integrations/codex-types.js';
import { checkpointPrompt, parseCheckpoint, checkpointHandoff } from '../src/core/checkpoint.js';
import { readAvailableModels } from '../src/integrations/models.js';
import type { Route } from '../src/shared/types.js';
import { Capture, PRICES, replay, btw, type Exchange, type LiveLine } from './context-models-support.js';
const exec = promisify(execFile);
export const FAMILIES = {A:['resume','compact_resume','fresh_replay','fresh_checkpoint'], B:['sol','luna_main','luna_side'], C:['checkpoint_sol','checkpoint_luna']} as const;
type Family=keyof typeof FAMILIES;
type Case={id:string;cohort:string;long?:boolean;longTargetInputTokens?:number;files:Record<string,string>;setup:string[];followups:string[];check:string;rubric:string;summaryFacts:string[]};
const SOL:Route={model:'gpt-6.1-sol',effort:'medium'}, LUNA:Route={model:'gpt-6-luna',effort:'low'};
const SUMMARY='Give a short task summary, at most 160 words. State the exact active requirements, earlier user correction, public API, verified file findings, unfinished work, and any open uncertainty. Do not edit files or take action.';
function hash(value:string|Buffer){return createHash('sha256').update(value).digest('hex');}
async function json(path:string,value:unknown){await writeFile(path,JSON.stringify(value,null,2)+'\n');}
export function parseOptions(args:string[]) {
  const values=new Map<string,string>();const flags=new Set<string>();
  const booleans=['--study','--list','--help']; const valid=['--phase','--family','--suite','--out','--repeat','--variants','--case','--timeout-minutes'];
  for(let i=0;i<args.length;i++){const key=args[i]!;if(booleans.includes(key)){flags.add(key);continue;}if(!valid.includes(key)||!args[i+1]||args[i+1]!.startsWith('--'))throw new Error(`Invalid option ${key}`);values.set(key,args[++i]!);}
  const phase=values.get('--phase')??'pilot';if(!['pilot','confirmation'].includes(phase))throw new Error('Invalid phase');
  const family=values.get('--family')??'all';if(!['all','A','B','C'].includes(family))throw new Error('Invalid family');
  const repeat=Number(values.get('--repeat')??(phase==='pilot'?'1':'3'));
  const timeout=Number(values.get('--timeout-minutes')??'5');
  if(!Number.isInteger(repeat)||repeat<1||repeat>10||!Number.isFinite(timeout)||timeout<0.1||timeout>20)throw new Error('Invalid repeat or timeout');
  return {phase,family,repeat,timeout,variants:values.get('--variants')?.split(','),selected:values.get('--case'),suite:resolve(values.get('--suite')??'benchmark/suites/context-models-2026-10-20.json'),out:resolve(values.get('--out')??`benchmark/results/context-models-${new Date().toISOString().replace(/[:.]/g,'-')}`),list:flags.has('--list'),help:flags.has('--help')};
}
export function order<T>(variants:readonly T[], repeat:number):T[]{const offset=(repeat-1)%variants.length;return [...variants.slice(offset),...variants.slice(0,offset)];}
async function command(file:string,args:string[],cwd:string){try{const r=await exec(file,args,{cwd,timeout:120000,maxBuffer:20000000});return {passed:true,output:r.stdout+r.stderr};}catch(e){const x=e as Error & {stdout?:string;stderr?:string};return {passed:false,output:(x.stdout??'')+(x.stderr??'')+String(e)};}}
async function files(root:string,prefix=''):Promise<Record<string,string>>{const result:Record<string,string>={};for(const item of await readdir(join(root,prefix),{withFileTypes:true})){if(item.name==='.git')continue;const path=join(prefix,item.name);if(item.isDirectory())Object.assign(result,await files(root,path));else if(item.isFile())result[path]=await readFile(join(root,path),'utf8');}return result;}
export function stateHash(state:Record<string,string>){return hash(JSON.stringify(Object.entries(state).sort(([a],[b])=>a.localeCompare(b))));}
function fatal(error:string){return /usage.limit|hit your|rate.limit|quota|allowance|insufficient|unauthorized|authentication|access denied|not supported|not available|model mismatch|effort mismatch|failed to load configuration|invalid transport|rerout/i.test(error);}
export async function runCase(task:Case,family:Family,variant:string,repeat:number,out:string,timeout:number){
  const neutralId=hash(`${task.id}/${family}/${variant}/${repeat}`).slice(0,12);const dir=join(out,task.id,family,String(repeat),variant);await mkdir(dir,{recursive:true});
  const root=await mkdtemp(join(tmpdir(),'pace-context-models-'));const stages:any[]=[];const history:Exchange[]=[];const live:(LiveLine & {id?:string})[]=[];let tasks:{text:string;completed:boolean}[]=[];
  const run:any={neutralId,case:task.id,family,variant,repeat,fixture:root,startedAt:new Date().toISOString(),stages,rubric:task.rubric,automaticCheckpoints:false,retries:0};
  let thread:string|undefined; const save=()=>json(join(dir,'run.json'),run);
  await save();
  const turn=async(kind:string,prompt:string,route:Route=SOL,requested:string|null|undefined=thread,mode:'main'|'side'='main')=>{
    const stage:any={kind,prompt,route,requestedThreadId:requested??null,mode,startedAt:new Date().toISOString()};stages.push(stage);await save();
    const capture=new Capture(join(dir,`${stages.length}-${kind}.events.jsonl`),route);const start=performance.now();
    const progress=(p:Progress)=>{
      if(p.kind==='approval'){stage.approvalsDeclined=(stage.approvalsDeclined??0)+1;p.respond('decline');}
      if(p.kind==='question')p.respond({});
      if(p.kind==='tasks')tasks=p.items;
      if(p.kind==='activity') {const existing=live.find(x=>x.id===p.id);const line={role:'activity',text:p.title,detail:p.detail,id:p.id};if(existing)Object.assign(existing,line);else live.push(line);}
      if(p.kind==='message'||p.kind==='status'||p.kind==='system')live.push({role:p.kind==='message'?'codex':p.kind==='system'?'system':'info',text:p.text});
    };
    live.push({role:'you',text:prompt});let result:Execution|undefined;
    try{result=await new AppServerRunner(capture.factory).run(prompt,root,route,requested??undefined,progress,AbortSignal.timeout(timeout*60000),mode,[],'request-approval');stage.threadId=result.threadId;stage.answer=result.result;stage.completed=result.completed;stage.context=result.context;
      if(!result.completed||!result.threadId)throw new Error('Incomplete model turn');
      if(requested&&result.threadId!==requested)throw new Error('Unexpected thread replacement');
      if(capture.audit().reroutes.length)throw new Error('Model rerouted');
      live.push({role:'codex',text:result.result});return result;
    }catch(e){stage.error=String(e);if(e instanceof CodexRunError){stage.errorUsage=e.usage;stage.context=e.context;}throw e;}
    finally{stage.durationMs=Math.round(performance.now()-start);stage.audit=capture.audit(result?.usage??stage.errorUsage);if(stage.audit.aggregationMatches===false)stage.measurementError='Usage aggregation mismatch';await save();console.log(`${task.id} ${family}/${variant} r${repeat} ${kind} ${stage.durationMs}ms${stage.error?' ERROR '+stage.error:''}`);}
  };
  try{
    for(const [name,content]of Object.entries(task.files)){await mkdir(dirname(join(root,name)),{recursive:true});await writeFile(join(root,name),content);}
    for(const args of [['init','--quiet'],['add','.'],['-c','user.name=Pace Benchmark','-c','user.email=pace@example.invalid','commit','--quiet','-m','fixture']]){const r=await command('git',args,root);if(!r.passed)throw new Error(r.output);}
    run.initialStateHash=stateHash(await files(root));
    for(let i=0;i<task.setup.length;i++){const prompt=task.setup[i]!;const r=await turn(`setup-${i+1}`,prompt);thread=r.threadId;history.push({user:prompt,assistant:r.result});}
    run.beforeInterventionThreadId=thread;run.beforeInterventionStateHash=stateHash(await files(root));run.setupStateMatched=run.initialStateHash===run.beforeInterventionStateHash;
    run.setupHistoryCharacters={user:history.reduce((s,x)=>s+x.user.length,0),assistant:history.reduce((s,x)=>s+x.assistant.length,0)};
    run.contextBeforeIntervention=stages.at(-1)?.context;run.longContextTargetMet=!task.long||(run.contextBeforeIntervention?.tokens??0)>=(task.longTargetInputTokens??50000);
    if(!run.setupStateMatched)throw new Error('Setup changed fixture files');
    if(!run.longContextTargetMet)throw new Error('Measured long context below preregistered target');
    run.interventionStageIndex=stages.length;await save();let prompt=task.followups[0]!;
    if(variant==='compact_resume'){
      const stage:any={kind:'compact',prompt:'/compact',route:SOL,requestedThreadId:thread};stages.push(stage);await save();
      const capture=new Capture(join(dir,`${stages.length}-compact.events.jsonl`),SOL);
      const r=await new AppServerRunner(capture.factory).compact(thread!,root,SOL,()=>{},AbortSignal.timeout(timeout*60000));
      Object.assign(stage,r,{kind:'compact',audit:capture.audit(r.usage)});await save();if(r.outcome!=='completed')throw new Error(`Compaction ${r.outcome}: ${r.error}`);
    }
    if(variant==='fresh_replay'){prompt=replay(history,prompt);thread=undefined;}
    if(['fresh_checkpoint','checkpoint_sol','checkpoint_luna'].includes(variant)){
      const route=variant==='checkpoint_luna'?LUNA:SOL;let note;let cp=checkpointPrompt();
      for(let attempt=1;attempt<=2;attempt++){const r=await turn(attempt===1?'checkpoint':'checkpoint-repair',cp,route);if(r.threadId!==thread)throw new Error('Checkpoint author changed thread');try{note=parseCheckpoint(r.result);break;}catch(e){run.retries++;if(attempt===2)throw e;cp=checkpointPrompt()+`\n\nPrevious note failed validation: ${String(e)}. Rewrite from thread context.`;}}
      run.checkpoint=note;prompt=checkpointHandoff(note!,[],prompt);thread=undefined;
    }
    if(family==='B'){
      run.btwInputs={history,liveLines:live.slice(-24),tasks,activePrompt:null};
      const r=variant==='luna_side'?await turn('summary',btw(history,live,tasks,SUMMARY),LUNA,null,'side'):await turn('summary',SUMMARY,variant==='luna_main'?LUNA:SOL);
      run.summary=r.result;run.summaryThreadId=r.threadId;run.summaryThreadValidated=variant==='luna_side'?r.threadId!==thread:r.threadId===thread;
      if(!run.summaryThreadValidated)throw new Error('Summary thread mismatch');
      // No new decision is requested in the summary; no automatic side-result injection.
    }
    run.beforeFollowupStateHash=stateHash(await files(root));if(run.beforeFollowupStateHash!==run.beforeInterventionStateHash)throw new Error('Intervention changed fixture');
    for(let i=0;i<task.followups.length;i++){const r=await turn(`followup-${i+1}`,i===0?prompt:task.followups[i]!,SOL,thread);if(i===0){const fresh=['fresh_replay','fresh_checkpoint','checkpoint_sol','checkpoint_luna'].includes(variant);run.threadTransitionValidated=fresh?r.threadId!==run.beforeInterventionThreadId:r.threadId===run.beforeInterventionThreadId;if(!run.threadTransitionValidated)throw new Error('Followup thread mismatch');}thread=r.threadId;}
    run.check=await command(process.execPath,['--input-type=module','-e',task.check],root);
    run.completed=true;
  }catch(e){run.error=String(e);run.completed=false;run.stopPaidRuns=fatal(run.error);}
  finally{
    const finalFiles=await files(root);run.finalStateHash=stateHash(finalFiles);await json(join(dir,'final-files.json'),finalFiles);
    await command('git',['add','-N','.'],root);const diff=await command('git',['diff','--binary'],root);await writeFile(join(dir,'diff.patch'),diff.output);run.diff=diff.output;
    run.protectedFilesUnchanged=Object.entries(task.files).filter(([name])=>!name.startsWith('src/')).every(([name,content])=>finalFiles[name]===content);
    run.changedFiles=Object.keys(finalFiles).filter(name=>finalFiles[name]!==task.files[name]);
    const total=(ss:any[])=>({durationMs:ss.reduce((s,x)=>s+(x.durationMs??0),0),costUsd:ss.every(x=>x.audit?.estimateNoUnreportedWritesUsd!==undefined)?ss.reduce((s,x)=>s+x.audit.estimateNoUnreportedWritesUsd,0):null,knownCostSubtotalUsd:ss.reduce((s,x)=>s+(x.audit?.estimateNoUnreportedWritesUsd??0),0),unknownUsageStages:ss.filter(x=>!x.audit?.usage).map(x=>x.kind)});
    run.totals=total(stages);run.postIntervention=run.interventionStageIndex===undefined?null:total(stages.slice(run.interventionStageIndex));run.finishedAt=new Date().toISOString();await save();
    const blind=join(out,'blind',neutralId);await mkdir(blind,{recursive:true});await json(join(blind,'review.json'),{neutralId,case:task.id,rubric:task.rubric,setup:history,summary:run.summary,checkpoint:run.checkpoint,followups:stages.filter(s=>s.kind.startsWith('followup-')).map(s=>({prompt:s.prompt.split('\n\nCurrent user request:\n').at(-1),answer:s.answer,error:s.error})),check:run.check,diff:run.diff,finalFiles,protectedFilesUnchanged:run.protectedFilesUnchanged});
  }
  return run;
}
export async function main(args=process.argv.slice(2)){
  const opts=parseOptions(args);if(opts.help){console.log('Context/model study: --study --phase pilot|confirmation --family all|A|B|C --suite PATH --out NEW_DIR --repeat 1..10 --variants comma,separated --case ID --timeout-minutes 0.1..20 --list. Sequential runs; existing Codex login; no fallback.');return;}
  const suiteText=await readFile(opts.suite,'utf8');const suite=JSON.parse(suiteText)as{cases:Case[]};const cohort=opts.phase==='pilot'?'pilot':'holdout';
  const cases=suite.cases.filter(x=>x.cohort===cohort&&(!opts.selected||x.id===opts.selected));if(!cases.length)throw new Error('No matching cases');
  const families=(opts.family==='all'?['A','B','C']:[opts.family])as Family[];const plan:{task:Case;family:Family;variant:string;repeat:number}[]=[];
  for(const family of families)for(const task of cases){if(family==='C'&&opts.phase==='pilot'&&!task.long)continue;for(let repeat=1;repeat<=opts.repeat;repeat++){const variants=(FAMILIES[family]as readonly string[]).filter(v=>!opts.variants||opts.variants.includes(v));if(!variants.length)throw new Error('No variants');for(const variant of order(variants,repeat))plan.push({task,family,variant,repeat});}}
  if(opts.variants?.some(v=>!Object.values(FAMILIES).flat().includes(v as never)))throw new Error('Unknown variant');
  if(opts.phase==='confirmation')plan.sort((a,b)=>a.repeat-b.repeat||families.indexOf(a.family)-families.indexOf(b.family)||cases.indexOf(a.task)-cases.indexOf(b.task));
  const planned=plan.map(({task,...x})=>({...x,case:task.id,modelTurns:task.setup.length+task.followups.length+(x.family==='B'||x.variant.includes('checkpoint')?1:0),nativeCompactions:x.variant==='compact_resume'?1:0}));
  if(opts.list){console.log(JSON.stringify({options:opts,scenarios:planned.length,modelTurns:planned.reduce((s,x)=>s+x.modelTurns,0),nativeCompactions:planned.reduce((s,x)=>s+x.nativeCompactions,0),plan:planned},null,2));return;}
  await mkdir(opts.out,{recursive:false});const models=await readAvailableModels();for(const route of [SOL,LUNA])if(!models.some(m=>m.model===route.model&&m.efforts.includes(route.effort!)))throw new Error(`Unavailable model/effort ${route.model}/${route.effort}`);
  const sourcePaths=['benchmark/context-models.ts','benchmark/context-models-support.ts','benchmark/context-models-probe.ts','benchmark/context-models-reaccount.ts','benchmark/context-models-analyze.py','tests/context-models.test.ts','benchmark/context-quality.ts','benchmark/thread-switch.ts','src/integrations/app-server-runner.ts','src/integrations/app-server-process.ts','src/integrations/app-server-protocol.ts','src/core/checkpoint.ts','src/components/App.tsx','package-lock.json'];
  const sourceHashes=Object.fromEntries(await Promise.all(sourcePaths.map(async p=>[p,hash(await readFile(p))])));const commit=await command('git',['rev-parse','HEAD'],process.cwd());
  await json(join(opts.out,'manifest.json'),{createdAt:new Date().toISOString(),opts,applicationBaseCommit:'f967efb48ef73a52d8f0273751a9864bae39f7a2',benchmarkCommit:commit.output.trim(),sourceHashes,benchmarkSha256:hash(JSON.stringify(sourceHashes)),suiteSha256:hash(suiteText),models,routes:{SOL,LUNA},prices:PRICES,node:process.version,codexCli:(await command(process.execPath,['node_modules/@openai/codex/bin/codex.js','--version'],process.cwd())).output.trim(),sdk:JSON.parse(await readFile('node_modules/@openai/codex-sdk/package.json','utf8')).version,plan:planned,summaryPrompt:SUMMARY,automaticCheckpoints:false,automaticCompactionLimit:240000,checkpointRecentExchanges:[],retryPolicy:'At most one malformed-checkpoint repair. No scenario retries. Stop on usage limit; stop after two consecutive access/transport errors.',selectionRule:'Quality pass first. Among quality-passing pilot candidates select lowest post-intervention total estimated cost; use duration as tie-breaker (<5% cost difference). Confirm only the selected comparison within its own family on both held-out cases, three repeats, rotated variant order. No whole-family claim from a different family.',blindReview:'Review artifacts are exported with neutral IDs; mapping remains in runs. Reviewer is the execution agent, no independent human/model judge.',setupAccounting:'Each scenario has an independent setup, charged once in its total. Post-intervention includes checkpoint/repair, summary/side, compaction and both follow-ups; no shared-setup subsidy.'});
  await writeFile(join(opts.out,'suite.json'),suiteText);const runs:any[]=[];let accessFailures=0;
  for(const p of plan){const run=await runCase(p.task,p.family,p.variant,p.repeat,opts.out,opts.timeout);runs.push(run);accessFailures=run.error&&/app-server|timeout|fetch|connect|access|authentication|stream|transport/i.test(run.error)?accessFailures+1:0;await json(join(opts.out,'summary.json'),{started:runs.length,completed:runs.filter(r=>r.completed).length,planned:plan.length,stopped:run.stopPaidRuns||accessFailures>=2,runs:runs.map(r=>({neutralId:r.neutralId,case:r.case,family:r.family,variant:r.variant,repeat:r.repeat,completed:r.completed,error:r.error,checkPassed:r.check?.passed,setupStateMatched:r.setupStateMatched,longContext:r.contextBeforeIntervention,threadTransitionValidated:r.threadTransitionValidated,totals:r.totals,postIntervention:r.postIntervention}))});if(run.stopPaidRuns||accessFailures>=2){console.error('Stopped further paid runs: '+run.error);break;}}
  console.log('Results: '+opts.out);
}
if(process.argv[1]?.endsWith('context-models.ts'))await main();
