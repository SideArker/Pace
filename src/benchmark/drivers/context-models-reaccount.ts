import { assertDebug, repositoryRoot } from "../storage.js";
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { Capture, PRICES } from './context-models-support.js';
async function walk(root:string):Promise<string[]>{const result:string[]=[];for(const e of await readdir(root,{withFileTypes:true})){if(e.name==='blind'||e.name==='schema')continue;const p=join(root,e.name);if(e.isDirectory())result.push(...await walk(p));else if(e.name==='run.json')result.push(p);}return result;}
export async function main(argv: string[]) {
  assertDebug();
const root=resolve(argv[0]??'benchmark/results/context-models-2026-10-20');
const sourceHashes=Object.fromEntries(await Promise.all(['benchmark/context-models-support.ts','benchmark/context-models-reaccount.ts','src/benchmark/drivers/context-models-support.ts','src/benchmark/drivers/context-models-reaccount.ts'].map(async p=>[p,createHash('sha256').update(await readFile(join(repositoryRoot,p))).digest('hex')])));
const totals=(stages:any[])=>({durationMs:stages.reduce((s,x)=>s+(x.durationMs??0),0),costUsd:stages.every(x=>x.audit?.estimateNoUnreportedWritesUsd!==undefined)?stages.reduce((s,x)=>s+x.audit.estimateNoUnreportedWritesUsd,0):null,knownCostSubtotalUsd:stages.reduce((s,x)=>s+(x.audit?.estimateNoUnreportedWritesUsd??0),0),unknownUsageStages:stages.filter(x=>!x.audit?.usage).map(x=>x.kind)});
let corrected=0, mismatches=0;
for(const path of await walk(root)){
 const run=JSON.parse(await readFile(path,'utf8'));if(!run.finishedAt)continue;
 const dir=path.slice(0,-'run.json'.length);
 let ancestor=dirname(path),recordedPrices:any;
 while(ancestor.startsWith(root)){
  const manifest=await readFile(join(ancestor,'manifest.json'),'utf8').then(text=>JSON.parse(text)).catch(error=>{if(error.code==='ENOENT')return undefined;throw error;});
  if(manifest?.prices){recordedPrices=manifest.prices;break;}
  if(ancestor===root)break;ancestor=dirname(ancestor);
 }
 const canonical=(value:any):any=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
 if(JSON.stringify(canonical(recordedPrices))!==JSON.stringify(canonical(PRICES)))throw new Error('Recorded study price protocol differs or is missing; reaccount refused rather than applying new prices');
 for(let i=0;i<run.stages.length;i++){
  const stage=run.stages[i];const log=join(dir,`${i+1}-${stage.kind}.events.jsonl`);const c=new Capture(log,stage.route);
  try{c.events=(await readFile(log,'utf8')).trim().split('\n').filter(Boolean).map(x=>JSON.parse(x));}catch{c.events=[];}
  stage.originalAudit=stage.audit;stage.audit=c.audit(stage.originalAudit?.runnerUsage??stage.errorUsage);
  if(stage.audit.aggregationMatches===false)mismatches++;
 }
 run.originalTotals=run.totals;run.originalPostIntervention=run.postIntervention;
 run.totals=totals(run.stages);run.postIntervention=run.interventionStageIndex===undefined?null:totals(run.stages.slice(run.interventionStageIndex));
 run.accountingCorrection={sourceHashes,priceSnapshot:recordedPrices,createdAt:new Date().toISOString(),method:'Filter usage by active turn ID; deduplicate cumulative total within that turn. Native compaction zero billing placeholders remain unknown. Raw run.json and RPC are unchanged.'};
 await writeFile(join(dir,'accounting-corrected.json'),JSON.stringify(run,null,2)+'\n',{flag:'wx'});corrected++;
}
console.log(JSON.stringify({corrected,mismatches,sourceHashes},null,2));

}
