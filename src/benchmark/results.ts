import { readFile, readdir, lstat } from 'node:fs/promises';
import { join, relative, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { assertDebug, acquireLock, atomicJson, hash, inside, inventory, json, repositoryRoot, resultsRoot, runDirectory, resourceIsLive } from './storage.js';
import { account, readEvents } from './service.js';
import { loadRuns, prepareGrades, analyzeGrades, type Grades } from './drivers/grading/grade.js';
import type { RunManifest, RunState } from './types.js';
const exec=promisify(execFile);
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
export async function studySource(id:string,root=resultsRoot,comparison?:{family:string;variants:readonly string[]}) {
  assertDebug();
  const dir=await runDirectory(id,root), center=await json<RunManifest>(join(dir,'center-manifest.json')).catch(()=>undefined);
  if(center && (center.preview.profile.category!=='context-models'||!['quick','standard'].includes(center.preview.profile.name)))throw new Error('Select a context/model pilot run');
  const state=await json<RunState>(join(dir,'state.json')).catch(()=>undefined);
  if(center&&state?.execution!=='completed')throw new Error('Frozen pilot must be complete');
  const paths=(await inventory(dir)).filter(p=>p.endsWith('/manifest.json'));
  for(const path of paths) {
    const manifest=await json<any>(path);
    if(manifest.opts?.phase!=='pilot'||!manifest.sourceHashes||!Array.isArray(manifest.plan))continue;
    if(!comparison)return manifest;
    const rows=await reviewItems(id,root);
    const selected=manifest.plan.filter((trial:any)=>trial.family===comparison.family&&comparison.variants.includes(trial.variant));
    if(!selected.length||comparison.variants.some(variant=>!selected.some((trial:any)=>trial.variant===variant)))throw new Error('Frozen pilot does not contain this selected comparison');
    const evidence:ReviewItem[]=selected.map((trial:any)=>{
      const row=rows.find(row=>row.run.case===trial.case&&row.run.family===trial.family&&row.run.variant===trial.variant&&row.run.repeat===trial.repeat&&row.run.completed&&qualityPass(row)&&row.run.check?.passed&&row.run.setupStateMatched&&row.run.protectedFilesUnchanged&&row.run.longContextTargetMet!==false);
      if(!row)throw new Error(`Frozen pilot requires passing execution, context/note review and fixture checks: ${trial.case}/${trial.variant}`);
      return row;
    });
    for(const trial of selected){const group=evidence.filter(row=>row.run.case===trial.case&&row.run.repeat===trial.repeat);if(new Set(group.map(row=>row.run.beforeInterventionStateHash)).size!==1)throw new Error('Frozen pilot fixture states differ between selected variants');}
    return {...manifest,reviewEvidenceSha256:hash(JSON.stringify(evidence.map(row=>({path:row.path,sha256:row.sha256,review:row.review}))))};
  }
  throw new Error('No compatible frozen context/model pilot manifest');
}
export type Review = { pass:boolean; notes:string; severity:'minor'|'major'|'critical'; evidence:string; affectedBehavior:string; preservedContext?:boolean; summaryPass?:boolean; checkpointPass?:boolean };
export type ReviewItem = {path:string;sha256:string;label:string;run:any;review?:Review};
type Reviews={version:1;items:Record<string,Review & {sha256:string;at:string}>};
export async function reviewItems(id:string,root=resultsRoot):Promise<ReviewItem[]> {
  assertDebug();const dir=await runDirectory(id,root),saved=await json<Reviews>(join(dir,'reviews.json')).catch(error=>{if(error.code==='ENOENT')return {version:1 as const,items:{} as Reviews["items"]};throw error;});
  const center=await json<RunManifest>(join(dir,'center-manifest.json')).catch(error=>{if(error.code==='ENOENT')return undefined;throw error;});
  if(center&&center.schemaVersion!==1)return [];
  if(saved.version!==1||!saved.items||typeof saved.items!=='object')throw new Error('Unsupported review schema; preserve and inspect raw files');
  const items:ReviewItem[]=[];
  for(const file of await inventory(dir)) {
    if(file.includes('/blind/')||file.includes('/store/'))continue;
    const path=relative(dir,file);
    let candidates:{run:any;pointer:string}[]=[];
    if(file.endsWith('/run.json')) {
      const run=await json<any>(file);
      if(run.family&&!run.finishedAt)continue;
      if((run.id&&run.arm)||(run.case&&run.family&&run.variant)) candidates=[{run,pointer:''}];
    } else if(file.endsWith('/thread-switch.json')) {
      const data=await json<any>(file);
      candidates=(data.trials??[]).flatMap((trial:any,n:number)=>trial.arms.map((arm:any)=>({run:{...arm,id:`history-${trial.historyTurns}`,repeat:trial.repeat,result:arm.turn?.answer,usage:arm.turn?.usage,estimatedCostUsd:arm.turn?.estimatedCostUsd,sharedSetup:trial.setupTurns,scope:'Switch turn only; identical successful setup shared by arms'},pointer:`#trial-${n}/${arm.arm}`})));
    } else if(/gpt-[^/]+\.json$/.test(file)) {
      const data=await json<any>(file);if(data.route&&data.prices)candidates=[{run:{...data,id:data.route.model,arm:'probe',result:data.result?.result},pointer:''}];
    }
    if(!candidates.length)continue;
    const digest=hash(await readFile(file));
    for(const {run,pointer} of candidates) {
      const identity=path+pointer,review=saved.items[identity],itemDigest=pointer?hash(JSON.stringify(run)):digest;
      if(review&&review.sha256!==itemDigest)throw new Error(`Reviewed artifact identity changed: ${identity}`);
      items.push({path:identity,sha256:itemDigest,label:`${run.id??run.case} · ${run.arm??`${run.family}/${run.variant}`} · ${run.error?'execution failed':run.check?.passed===false||run.checksPassed===false?'checks failed':review?review.pass?'manual pass':'manual fail':'review pending'}`,run,review});
    }
  }
  return items;
}
export async function saveReview(id:string,item:Pick<ReviewItem,'path'|'sha256'>,review:Review,root=resultsRoot) {
  assertDebug();const release=await acquireLock(await runDirectory(id,root));
  try{return await writeReview(id,item,review,root);}finally{await release();}
}
async function writeReview(id:string,item:Pick<ReviewItem,'path'|'sha256'>,review:Review,root:string) {
  assertDebug();const dir=await runDirectory(id,root),found=(await reviewItems(id,root)).find(row=>row.path===item.path);
  if(!found||found.sha256!==item.sha256)throw new Error('Review artifact identity changed');
  if(typeof review.pass!=='boolean'||!['minor','major','critical'].includes(review.severity)||!review.evidence.trim()||!review.affectedBehavior.trim()||!review.notes.trim())throw new Error('Review requires a decision, notes, severity, evidence and affected behavior');
  const data=await json<Reviews>(join(dir,'reviews.json')).catch(error=>{if(error.code==='ENOENT')return {version:1 as const,items:{} as Reviews["items"]};throw error;});
  data.items[item.path]={...review,sha256:item.sha256,at:new Date().toISOString()};await atomicJson(join(dir,'reviews.json'),data);
  if(found.run.family) {
    const base=await driverRoot(dir,item.path),path=join(base,'grades.json');
    const grades=await json<any>(path).catch(error=>{if(error.code==='ENOENT')return {version:1,grades:{}};throw error;});
    grades.grades[found.run.neutralId]={executionPass:review.pass,preservedContext:review.preservedContext===true,summaryQuality:found.run.family==='B'||found.run.summary!==undefined?{pass:review.summaryPass===true}:null,checkpointQuality:found.run.family==='C'||found.run.variant==='fresh_checkpoint'||found.run.checkpoint!==undefined?{pass:review.checkpointPass===true}:null,notes:review.notes,severity:review.severity,evidence:review.evidence,affectedBehavior:review.affectedBehavior,artifactSha256:item.sha256};
    await atomicJson(path,grades);
  } else if(found.run.repetition && found.run.commit) {
    const base=await driverRoot(dir,item.path),path=join(base,'grades.json'),runs=await loadRuns(base);
    try { await prepareGrades(base,runs); } catch(error) { if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error; }
    const grades=await json<Grades>(path),grade=grades.runs.find(row=>row.id===found.run.id&&row.repetition===found.run.repetition&&row.arm===found.run.arm);
    if(!grade || grade.promptSha256!==found.run.promptSha256 || grade.commit!==found.run.commit)throw new Error('Legacy grade identity changed');
    grade.pass=review.pass;grade.notes=review.notes;await atomicJson(path,grades);
    if(grades.runs.every(row=>typeof row.pass==='boolean'))await atomicJson(join(base,'graded-summary.json'),analyzeGrades(base,runs,grades));
  }
  const state=await json<RunState>(join(dir,'state.json')).catch(error=>{if(error.code==='ENOENT')return undefined;throw error;});
  if(state&&state.quality!=='diagnostic'){
    const rows=await reviewItems(id,root);
    state.quality=rows.some(row=>row.review&&!qualityPass(row))?'failed':state.execution==='completed'&&rows.length>0&&rows.every(qualityPass)?'passed':'needs-review';
    await atomicJson(join(dir,'state.json'),state);
  }
}
export async function resultSummary(id:string,root=resultsRoot) {
  assertDebug();
  if((await listResults(root)).some(r=>r.id===id&&r.execution==='read-only'))return {version:'historical file / unknown',files:[id],note:'Raw historical artifact preserved; structured review is unavailable for an unknown format.'};
  const dir=await runDirectory(id,root),manifest=await json<RunManifest>(join(dir,'center-manifest.json')).catch(()=>undefined),state=await json<RunState>(join(dir,'state.json')).catch(()=>undefined);
  if(state?.execution==='running'&&!await resourceIsLive(root,id))state.execution='interrupted';
  const warnings:string[]=[];
  const items=await reviewItems(id,root).catch(error=>{warnings.push(`Structured review unavailable: ${String(error)}`);return [];});
  const events=await readEvents(dir).catch(error=>{warnings.push(`Attempt ledger unavailable: ${String(error)}`);return [];});
  const comparisons=familyComparisons(items);
  return {version:manifest?.schemaVersion??'historical / unknown',state,warnings,accounting:manifest&&!warnings.some(warning=>warning.startsWith('Attempt ledger'))?account(events):{totalEstimatedUsd:null,note:'Historical or damaged attempt ledger is unavailable. Inspect the original family summary and raw artifacts; zero cost is not inferred.'},comparisons,variation:comparisonVariation(comparisons),missingReviews:warnings.length?null:items.filter(i=>!i.review).length,reviewed:items.filter(i=>i.review).length,note:'Checks and human review are separate. Completed execution does not mean quality passed. See family summaries for paired comparisons. Unknown formats are preserved as raw artifacts.'};
}
export async function analyzeResult(id:string,action:'analyze'|'summarize'|'reaccount',root=resultsRoot) {
  assertDebug();const release=await acquireLock(await runDirectory(id,root));
  try{return await analyzeSavedResult(id,action,root);}finally{await release();}
}
async function analyzeSavedResult(id:string,action:'analyze'|'summarize'|'reaccount',root:string) {
  assertDebug();const dir=await runDirectory(id,root),items=await reviewItems(id,root);
  if(!items.some(i=>i.run.family))throw new Error('This action requires compatible context/model study results');
  if(action==='reaccount') {
    await (await import('./drivers/context-models-reaccount.js')).main([dir]);return 'Derived accounting-corrected.json created; original run.json preserved.';
  }
  try { await exec('python3',['--version']); } catch { throw new Error('Python 3 is unavailable; raw results and review remain available'); }
  const result=await exec('python3',[join(repositoryRoot,`benchmark/context-models-${action}.py`),dir],{cwd:repositoryRoot,maxBuffer:4_000_000});return result.stdout;
}

export const qualityPass=(item:ReviewItem)=>item.review?.pass===true&&!item.run.error&&item.run.check?.passed!==false&&item.run.checksPassed!==false&&(!Array.isArray(item.run.checks)||item.run.checks.every((c:any)=>c.exitCode===0||c.passed===true))&&(!item.run.family||(item.review.preservedContext===true&&(!(item.run.family==='B'||item.run.summary!==undefined)||item.review.summaryPass===true)&&(!(item.run.family==='C'||item.run.variant==='fresh_checkpoint'||item.run.checkpoint!==undefined)||item.review.checkpointPass===true)));

export function familyComparisons(items:ReviewItem[]) {
  const groups=new Map<string,Map<string,ReviewItem>>();

  for(const item of items) {
    const r=item.run,family=r.family??(r.scope?'thread-switch':r.repetition?'workflows':r.stages?'context-quality':'task-control'),key=`${family}/${r.id??r.case}/${r.repetition??r.repeat??1}`,variant=r.arm??r.variant;
    const group=groups.get(key)??new Map<string,ReviewItem>(),existing=group.get(variant);
    if(!existing||(!r.error&&existing.run.error))group.set(variant,item);groups.set(key,group);
  }
  return [...groups].map(([key,group])=>{
    const family=key.split('/')[0]!,baseName=family==='A'?'resume':family==='B'?'sol':family==='C'?'checkpoint_sol':family==='thread-switch'?'same-thread':family==='context-quality'?'resume':'baseline';
    const baseline=group.get(baseName),cost=(item:ReviewItem)=>item.run.estimatedCostUsd??item.run.totalEstimatedCostUsd??item.run.totals?.costUsd??null;
    return {key,baseline:baseName,candidateOnly:!baseline,comparisons:[...group].filter(([name])=>name!==baseName).map(([variant,candidate])=>{
      const compatible=!!baseline&&(!baseline.run.promptSha256||baseline.run.promptSha256===candidate.run.promptSha256)&&(!baseline.run.commit||baseline.run.commit===candidate.run.commit)&&(!baseline.run.beforeInterventionStateHash||baseline.run.beforeInterventionStateHash===candidate.run.beforeInterventionStateHash);
      const qualityPassing=compatible&&qualityPass(baseline!)&&qualityPass(candidate),baseCost=baseline&&cost(baseline),candidateCost=cost(candidate);
      return {variant,compatible,qualityPassing,baselineCostUsd:baseCost??null,candidateCostUsd:candidateCost,deltaCostUsd:qualityPassing&&baseCost!=null&&candidateCost!=null?candidateCost-baseCost:null,scope:family==='thread-switch'?'Switch turns only; shared setup retained in raw artifact':'Whole independent trial; context study post-intervention details in family analysis'};
    })};
  });
}

async function driverRoot(root:string,path:string) {
  let current=dirname(inside(root,path.split('#')[0]!));
  while(current!==root) {
    try {await lstat(join(current,'manifest.json'));return current;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    current=dirname(current);
  }
  return root;
}

function comparisonVariation(groups:ReturnType<typeof familyComparisons>) {
  const values=new Map<string,number[]>();
  for(const group of groups)for(const pair of group.comparisons) {
    const key=group.key.slice(0,group.key.lastIndexOf('/'))+'/'+pair.variant;
    const previous=values.get(key)??[];
    if(pair.deltaCostUsd!==null)previous.push(pair.deltaCostUsd);
    values.set(key,previous);
  }
  return [...values].map(([key,deltas])=>{
    const sorted=deltas.sort((a,b)=>a-b),n=sorted.length;
    return {key,qualityPassingPricedPairs:n,minimumDeltaUsd:n>=2?sorted[0]:null,maximumDeltaUsd:n>=2?sorted.at(-1):null,medianDeltaUsd:n>=2?(sorted[Math.floor((n-1)/2)]!+sorted[Math.floor(n/2)]!)/2:null,note:n<2?'Insufficient paired observations to describe variation':'Descriptive within-case variation only; no confidence or general savings claim'};
  });
}
