import { readFile, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getProfile } from './catalog.js';
import { assertDebug, hash, repositoryRoot, json } from './storage.js';
import { isolationUnavailable, validateDataset } from './datasets.js';
import { parseRoutingSuite } from '../entrypoints/routing-suite.js';
import { parseSuite } from './drivers/runner/suite.js';
import { baselineBuildPaths, benchmarkProvenance } from '../entrypoints/benchmark-provenance.js';
import { verifyFrozenSources } from './drivers/context-models-continue.js';
import { FAMILIES, order } from './drivers/context-models.js';
import { PaceStore } from '../core/sessions.js';
import { loadRoutingPrompts } from '../core/routing/routing-prompts.js';
import { vexServerPath } from '../core/vex/client.js';
import type { Preview, Selection, Trial } from './types.js';
const exec=promisify(execFile);
export async function preflight(selection: Selection): Promise<Preview> {
  assertDebug();
  selection={category:selection.category,profile:selection.profile,baseline:selection.baseline?resolve(selection.baseline):undefined,source:selection.source||undefined,dataset:selection.dataset?resolve(selection.dataset):undefined,offline:selection.offline===true,controlled:selection.controlled===true,maxUsd:selection.maxUsd,maxTurns:selection.maxTurns};
  const profile=getProfile(selection.category,selection.profile);
  if(selection.controlled) throw new Error(isolationUnavailable);
  for(const [name,value] of [['maxUsd',selection.maxUsd],['maxTurns',selection.maxTurns]] as const)
    if(value!==undefined && (!Number.isFinite(value) || value<=0 || (name==='maxTurns'&&!Number.isSafeInteger(value)))) throw new Error(`${name} must be a positive ${name==='maxTurns'?'integer':'number'}`);
  if(selection.baseline && profile.category!=='task-control') throw new Error('A baseline checkout applies only to task-control');
  if(selection.dataset && profile.category!=='workflows') throw new Error('External project datasets currently apply to executed workflows');
  if(selection.offline&&!selection.dataset)throw new Error('Offline applies to a pinned dataset cache; it does not disable model execution');
  if(selection.source&&!(profile.category==='context-models'&&profile.name.startsWith('confirmation-')))throw new Error('Source applies only to a selected context/model confirmation');
  const dataset=selection.dataset?validateDataset(await json(resolve(selection.dataset))):undefined;
  let suiteText:string|undefined, suite:any;
  if(profile.suite) { suiteText=await readFile(join(repositoryRoot,profile.suite),'utf8'); suite=JSON.parse(suiteText); }
  const plan:Trial[]=[], resolvedCommits:Record<string,string>={}; let turns=0;
  if(dataset)resolvedCommits.dataset=dataset.commit;
  const add=(key:string,description=key)=>plan.push({key,description});
  if(profile.category==='routing') {
    suite=parseRoutingSuite(suite);
    for(let r=1;r<=profile.repeats;r++) for(const task of r%2?suite.cases:[...suite.cases].reverse()) add(`${task.id}/${r}`);
    turns=plan.length*(profile.name==='shape-only'?4:12);
  } else if(profile.category==='workflows') {
    suite=parseSuite(suite);
    for(const task of suite.cases) {
      const ref=task.ref??suite.ref??'HEAD';
      if(!resolvedCommits[ref] && !selection.dataset) resolvedCommits[ref]=(await exec('git',['rev-parse','--verify',`${ref}^{commit}`],{cwd:resolve(repositoryRoot,suite.repository)})).stdout.trim();
      for(let r=1;r<=profile.repeats;r++) for(const arm of r%2?profile.variants:[...profile.variants].reverse()) add(`${task.id}/${r}/${arm}`);
    }
    turns=plan.length*8;
  } else if(profile.category==='task-control') {
    profile.variants=selection.baseline?['baseline','candidate']:['candidate'];
    if(!Array.isArray(suite.cases)||!suite.cases.length) throw new Error('Task-control suite has no cases');
    if(selection.baseline) {
      const base=resolve(selection.baseline);
      for(const file of ['dist/core/orchestrator.js','routing-prompts.default.json','package.json']) await access(join(base,file));
      const provenance=await benchmarkProvenance(base,baselineBuildPaths);
      resolvedCommits.baseline=provenance.commit; resolvedCommits.baselineBuild=provenance.sourceSha256;
    }
    for(const [index,task] of suite.cases.entries()) for(const arm of selection.baseline?(index%2?['candidate','baseline']:['baseline','candidate']):['candidate']) add(`${task.id}/${arm}`);
    turns=plan.length*12;
  } else if(profile.category==='context-quality') {
    for(const task of suite.cases)if(task.repository){const ref=task.ref??'HEAD';resolvedCommits[`${task.id}/${ref}`]=(await exec('git',['rev-parse','--verify',`${ref}^{commit}`],{cwd:resolve(repositoryRoot,task.repository)})).stdout.trim();}
    for(const task of suite.cases) for(let r=1;r<=profile.repeats;r++) for(const arm of r%2?profile.variants:[...profile.variants].reverse()) { add(`${task.id}/${r}/${arm}`); turns+=task.setup.length+task.followups.length+(arm==='fresh_checkpoint'?2:arm==='compact_resume'?1:0); }
  } else if(profile.category==='thread-switch') {
    for(let r=1;r<=profile.repeats;r++) for(const history of profile.name==='quick'?[1]:[1,4,8]) { add(`${r}/${history}`); turns+=history+2; }
  } else if(profile.category==='context-models' && profile.name!=='probe') {
    const confirmation=profile.name.startsWith('confirmation-');
    if(confirmation) {
      if(!selection.source) throw new Error('Confirmation requires a frozen completed pilot run (select it in the wizard or pass --source ID)');
      const { studySource }=await import('./results.js'); const source=await studySource(selection.source,undefined,{family:profile.name.at(-1)!,variants:profile.variants});
      await verifyFrozenSources(source.sourceHashes,repositoryRoot);
      if(source.suiteSha256!==hash(suiteText!)) throw new Error('Frozen suite changed');
      resolvedCommits.frozenPilot=hash(JSON.stringify(source));
    }
    const families=confirmation?[profile.name.at(-1)!]:['A','B','C'];
    const cases=suite.cases.filter((task:any)=>task.cohort===(confirmation?'holdout':'pilot'));
    const rows:{task:any;family:string;variant:string;r:number}[]=[];
    for(const family of families) for(const task of cases) {
      if(family==='C'&&!confirmation&&!task.long) continue;
      for(let r=1;r<=profile.repeats;r++) for(const variant of order(confirmation?profile.variants:FAMILIES[family as keyof typeof FAMILIES],r)) rows.push({task,family,variant,r});
    }
    if(confirmation) rows.sort((a,b)=>a.r-b.r||families.indexOf(a.family)-families.indexOf(b.family)||cases.indexOf(a.task)-cases.indexOf(b.task));
    for(const {task,family,variant,r} of rows) { add(`${task.id}/${family}/${r}/${variant}`); turns+=task.setup.length+task.followups.length+(family==='B'||variant.includes('checkpoint')?1:0)+(variant==='compact_resume'?1:0)+(variant.includes('checkpoint')?1:0); }
  } else if(profile.driver==='context-models-probe') { add('probe'); turns=2; }
  else { add('persistence'); }
  const dependencies=['Node',...(profile.category==='routing'?['Vex credentials and enabled routes']:profile.paid?['Existing Codex login / enabled routes (access checked only on Start)']:['GC (--expose-gc)']),...(['routing','workflows','task-control'].includes(profile.category)?['Vex MCP']:[])];
  if(dependencies.includes('Vex MCP')&&!vexServerPath()) throw new Error('Vex MCP dependency is unavailable; no fallback route will be used');
  const config=['routing','workflows'].includes(profile.category)?await new PaceStore().loadConfig():undefined;
  if(config&&!config.models.some(model=>model.enabled!==false&&model.efforts.length))throw new Error('No enabled benchmark model routes; no fallback will be selected');
  const effectiveConfig=config?{config:{models:config.models,defaultRoute:config.defaultRoute,routingMode:'auto',trustedFolders:[],skillFolder:null,approvalMode:'request-approval'},prompts:loadRoutingPrompts()}:undefined;
  return {effectiveConfig,datasetManifest:dataset,datasetHash:dataset&&hash(JSON.stringify(dataset)),selection:{...selection,baseline:selection.baseline&&resolve(selection.baseline),dataset:selection.dataset&&resolve(selection.dataset)},profile,suiteHash:suiteText&&hash(suiteText),plan,maximumModelTurns:selection.maxTurns??turns,estimate:profile.paid?`0–${selection.maxTurns??turns} Codex turns/compactions or Vex decisions (internal model requests are not separately capped); Standard API equivalent unknown until usage is reported. Vex separate. Dollar threshold ${selection.maxUsd===undefined?'unset':`$${selection.maxUsd}`} stops subsequent calls, not the current call or account billing.`:'No inference. Cost $0. Synthetic sessions only.',baselineScope:profile.category==='task-control'?(selection.baseline?'Baseline controller and shipped prompts; candidate store, runner and Vex client are shared':'Candidate-only; no A/B comparison'):undefined,resolvedCommits,dependencies};
}
