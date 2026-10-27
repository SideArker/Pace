import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { analyzeResult, reviewItems, saveReview } from '../src/benchmark/results.js';
import { PRICES } from '../src/benchmark/drivers/context-models-support.js';
const roots:string[]=[];
afterEach(async()=>{vi.unstubAllEnvs();vi.restoreAllMocks();await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'pace-analysis-test-'));roots.push(root);const dir=join(root,'study'),base=join(dir,'segment-1');await mkdir(base,{recursive:true});
 await writeFile(join(base,'manifest.json'),JSON.stringify({opts:{phase:'pilot'},prices:PRICES}));
 const usage={input_tokens:100,cached_input_tokens:20,cache_write_input_tokens:0,output_tokens:10,reasoning_output_tokens:0};
 for(const variant of ['resume','fresh_checkpoint']){
  const path=join(base,'pilot/A/1',variant);await mkdir(path,{recursive:true});
  const run={case:'pilot',family:'A',variant,repeat:1,neutralId:variant,completed:true,startedAt:'2026-10-20T00:00:00Z',finishedAt:'2026-10-20T00:00:01Z',setupStateMatched:true,beforeInterventionStateHash:'same',protectedFilesUnchanged:true,interventionStageIndex:0,check:{passed:true},totals:{durationMs:1,costUsd:1,knownCostSubtotalUsd:1},postIntervention:{durationMs:1,costUsd:1,knownCostSubtotalUsd:1},stages:[{kind:'followup-1',startedAt:'2026-10-20T00:00:00Z',durationMs:1,route:{model:'gpt-6.1-sol',effort:'medium'},audit:{usage,runnerUsage:usage,estimateNoUnreportedWritesUsd:1}}]};
  await writeFile(join(path,'run.json'),JSON.stringify(run));
  const events=[{direction:'out',message:{method:'turn/start'}},{direction:'response',message:{method:'turn/start',result:{turn:{id:'active'}}}},{direction:'in',message:{method:'thread/tokenUsage/updated',params:{turnId:'active',tokenUsage:{total:{totalTokens:110},last:{inputTokens:100,cachedInputTokens:20,cacheWriteInputTokens:0,outputTokens:10,reasoningOutputTokens:0}}}}}];
  await writeFile(join(path,'1-followup-1.events.jsonl'),events.map(event=>JSON.stringify(event)).join('\n')+'\n');
 }
 for(const item of await reviewItems('study',root))await saveReview('study',item,{pass:true,preservedContext:true,checkpointPass:true,notes:'Synthetic review',severity:'minor',evidence:'Synthetic RPC and check',affectedBehavior:'Accounting only'},root);
 return {root,dir,base};
}
it('runs compatible analysis, preserves original accounting, and labels derived corrections with recorded prices',async()=>{
 const {root,dir,base}=await fixture(),original=join(base,'pilot/A/1/resume/run.json'),before=await readFile(original,'utf8');vi.spyOn(console,'log').mockImplementation(()=>{});
 await analyzeResult('study','reaccount',root);expect(await readFile(original,'utf8')).toBe(before);
 const correction=JSON.parse(await readFile(join(base,'pilot/A/1/resume/accounting-corrected.json'),'utf8'));
 expect(correction.totals.costUsd).toBeCloseTo(0.000262);expect(correction.accountingCorrection.priceSnapshot).toEqual(PRICES);
 await expect(analyzeResult('study','reaccount',root)).rejects.toThrow();
 await analyzeResult('study','analyze',root);await analyzeResult('study','summarize',root);
 expect(JSON.parse(await readFile(join(dir,'analysis.json'),'utf8')).attempts).toBe(2);
 expect(JSON.parse(await readFile(join(dir,'graded-summary.json'),'utf8')).groups[0].qualityPassingPricedPairs).toBe(1);
 await writeFile(join(base,'manifest.json'),JSON.stringify({prices:{...PRICES,checkedAt:'2099-01-01'}}));await expect(analyzeResult('study','reaccount',root)).rejects.toThrow('price protocol');
});
it('reports missing Python while retaining raw results and manual review',async()=>{
 const {root,dir}=await fixture();vi.stubEnv('PATH',join(dir,'no-python'));
 await expect(analyzeResult('study','analyze',root)).rejects.toThrow('Python 3 is unavailable');expect(await reviewItems('study',root)).toHaveLength(2);
});
