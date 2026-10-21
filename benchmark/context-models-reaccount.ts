import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { Capture } from './context-models-support.js';
async function walk(root:string):Promise<string[]>{const result:string[]=[];for(const e of await readdir(root,{withFileTypes:true})){if(e.name==='blind'||e.name==='schema')continue;const p=join(root,e.name);if(e.isDirectory())result.push(...await walk(p));else if(e.name==='run.json')result.push(p);}return result;}
const root=resolve(process.argv[2]??'benchmark/results/context-models-2026-10-20');
const sourceHashes=Object.fromEntries(await Promise.all(['benchmark/context-models-support.ts','benchmark/context-models-reaccount.ts'].map(async p=>[p,createHash('sha256').update(await readFile(p)).digest('hex')])));
const totals=(stages:any[])=>({durationMs:stages.reduce((s,x)=>s+(x.durationMs??0),0),costUsd:stages.every(x=>x.audit?.estimateNoUnreportedWritesUsd!==undefined)?stages.reduce((s,x)=>s+x.audit.estimateNoUnreportedWritesUsd,0):null,knownCostSubtotalUsd:stages.reduce((s,x)=>s+(x.audit?.estimateNoUnreportedWritesUsd??0),0),unknownUsageStages:stages.filter(x=>!x.audit?.usage).map(x=>x.kind)});
let corrected=0, mismatches=0;
for(const path of await walk(root)){
 const run=JSON.parse(await readFile(path,'utf8'));if(!run.finishedAt)continue;
 const dir=path.slice(0,-'run.json'.length);
 for(let i=0;i<run.stages.length;i++){
  const stage=run.stages[i];const log=join(dir,`${i+1}-${stage.kind}.events.jsonl`);const c=new Capture(log,stage.route);
  try{c.events=(await readFile(log,'utf8')).trim().split('\n').filter(Boolean).map(x=>JSON.parse(x));}catch{c.events=[];}
  stage.originalAudit=stage.audit;stage.audit=c.audit(stage.originalAudit?.runnerUsage??stage.errorUsage);
  if(stage.audit.aggregationMatches===false)mismatches++;
 }
 run.originalTotals=run.totals;run.originalPostIntervention=run.postIntervention;
 run.totals=totals(run.stages);run.postIntervention=run.interventionStageIndex===undefined?null:totals(run.stages.slice(run.interventionStageIndex));
 run.accountingCorrection={sourceHashes,createdAt:new Date().toISOString(),method:'Filter usage by active turn ID; deduplicate cumulative total within that turn. Native compaction zero billing placeholders remain unknown. Raw run.json and RPC are unchanged.'};
 await writeFile(join(dir,'accounting-corrected.json'),JSON.stringify(run,null,2)+'\n');corrected++;
}
console.log(JSON.stringify({corrected,mismatches,sourceHashes},null,2));
