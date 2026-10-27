import { inside } from "../storage.js";
import { assertDebug } from "../storage.js";
import { createHash } from 'node:crypto';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { runCase, type FAMILIES } from './context-models.js';
type Planned={case:string;family:keyof typeof FAMILIES;variant:string;repeat:number};
export const trialKey=(p:Planned)=>`${p.case}/${p.family}/${p.repeat}/${p.variant}`;
export function remainingPlan(plan:Planned[],runs:(Planned&{completed?:boolean})[]){const done=new Set(runs.filter(r=>r.completed).map(trialKey));return plan.filter(p=>!done.has(trialKey(p)));}
export async function verifyFrozenSources(hashes:Record<string,string>,cwd=process.cwd()){for(const [name,expected]of Object.entries(hashes)){const actual=createHash('sha256').update(await readFile(inside(resolve(cwd),name))).digest('hex');if(actual!==expected)throw new Error(`Frozen source changed: ${name}`);}}
async function inventory(root:string):Promise<any[]>{const rows:any[]=[];for(const item of await readdir(root,{withFileTypes:true})){if(item.name==='blind')continue;const path=join(root,item.name);if(item.isDirectory())rows.push(...await inventory(path));else if(item.name==='run.json')rows.push(JSON.parse(await readFile(path,'utf8')));}return rows;}
const json=async(path:string,value:unknown)=>writeFile(path,JSON.stringify(value,null,2)+'\n');
export async function main(args: string[]){
  assertDebug();
 const [fromArg,outArg]=args;if(!fromArg||!outArg||args.length!==2)throw new Error('Usage: context-models-continue.ts ORIGINAL_RESULTS NEW_RESULTS');
 const from=resolve(fromArg),out=resolve(outArg),manifestText=await readFile(join(from,'manifest.json'),'utf8'),manifest=JSON.parse(manifestText);
 await verifyFrozenSources(manifest.sourceHashes);
 const existing=await inventory(from),plan=remainingPlan(manifest.plan,existing);
 if(!plan.length){console.log('All planned trials are already complete.');return;}
 const suiteText=await readFile(join(from,'suite.json'),'utf8');if(createHash('sha256').update(suiteText).digest('hex')!==manifest.suiteSha256)throw new Error('Frozen suite changed');
 const suite=JSON.parse(suiteText);await mkdir(out,{recursive:false});
 await json(join(out,'manifest.json'),{...manifest,createdAt:new Date().toISOString(),continuedFrom:from,originalManifestSha256:createHash('sha256').update(manifestText).digest('hex'),continuationRuntimeSha256:createHash('sha256').update(await readFile('src/benchmark/drivers/context-models-continue.ts')).digest('hex'),continuationDriverSha256:createHash('sha256').update(await readFile('benchmark/context-models-continue.ts')).digest('hex'),previouslyCompleted:existing.filter(r=>r.completed).length,originalPlanned:manifest.plan.length,plan,executionSourcePolicy:'Original runCase and all frozen source hashes verified unchanged. Recreate only unfinished trials from their initial fixture and thread; no successful trial is repeated.'});
 await writeFile(join(out,'suite.json'),suiteText);const runs:any[]=[];let failures=0;
 for(const p of plan){const task=suite.cases.find((c:any)=>c.id===p.case);if(!task)throw new Error(`Missing case ${p.case}`);const r=await runCase(task,p.family,p.variant,p.repeat,out,manifest.opts.timeout);runs.push(r);failures=r.error&&/app-server|timeout|fetch|connect|access|authentication|stream|transport/i.test(r.error)?failures+1:0;await json(join(out,'summary.json'),{started:runs.length,completed:runs.filter(r=>r.completed).length,planned:plan.length,previouslyCompleted:existing.filter(r=>r.completed).length,stopped:!!r.stopPaidRuns||failures>=2,runs:runs.map(r=>({case:r.case,family:r.family,variant:r.variant,repeat:r.repeat,completed:r.completed,error:r.error,checkPassed:r.check?.passed,totals:r.totals,postIntervention:r.postIntervention}))});if(r.stopPaidRuns||failures>=2){console.error('Stopped further paid runs: '+r.error);break;}}
 console.log('Results: '+out);
}
