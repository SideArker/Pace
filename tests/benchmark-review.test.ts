import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reviewItems, saveReview, resultSummary, readResultFile, familyComparisons } from '../src/benchmark/results.js';
import { hash } from '../src/benchmark/storage.js';
const roots:string[]=[];afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
async function setup(){const root=await mkdtemp(join(tmpdir(),'pace-review-test-'));roots.push(root);const dir=join(root,'run');await mkdir(dir);return {root,dir};}
const review={pass:true,notes:'Rubric checked',severity:'minor' as const,evidence:'answer + diff + independent check',affectedBehavior:'CSV quoting'};
function run(arm:string){return {id:'case',repetition:1,arm,commit:'frozen',promptSha256:'same',durationMs:10,usage:{input_tokens:100,cached_input_tokens:0,cache_write_input_tokens:0,output_tokens:10,reasoning_output_tokens:0},estimatedCostUsd:arm==='baseline'?1:0.5,stages:[],routing:[],checks:[{command:'test',exitCode:0,output:'pass'}],subturns:[],vexShellCommands:[],mcpCalls:[],paceRoutingCalls:0,agentVexCalls:0,result:'answer',gitStatus:'',diffFile:'diff.patch'};}
it('keeps legacy identities and emits quality-passing workflow pairs only after explicit review',async()=>{
 const {root,dir}=await setup();await writeFile(join(dir,'manifest.json'),'{}');
 for(const arm of ['baseline','routed_single','routed_split']){const sub=join(dir,'case','1',arm);await mkdir(sub,{recursive:true});await writeFile(join(sub,'run.json'),JSON.stringify(run(arm)));}
 const rows=await reviewItems('run',root);expect(rows).toHaveLength(3);expect(familyComparisons(rows)[0]!.comparisons.every(p=>!p.qualityPassing)).toBe(true);
 for(const item of rows)await saveReview('run',item,review,root);
 const report=JSON.parse(await readFile(join(dir,'graded-summary.json'),'utf8'));expect(report.comparisons.routed_single.qualityPassingPairs).toBe(1);
 const before=await readFile(join(dir,'case/1/baseline/run.json'),'utf8');await writeFile(join(dir,'case/1/baseline/run.json'),before+' ');await expect(reviewItems('run',root)).rejects.toThrow('identity changed');
});
it('does not let a manual pass conceal failed checks or missing context assessments',async()=>{
 const base=run('baseline'),candidate={...run('candidate'),checks:[{command:'test',exitCode:1,output:'failure'}]};
 const rows=[base,candidate].map((r,i)=>({path:String(i),sha256:hash(String(i)),label:r.arm,run:r,review}));expect(familyComparisons(rows)[0]!.comparisons[0]!.qualityPassing).toBe(false);
 const context=[{...base,case:'x',family:'A',variant:'resume',arm:undefined,summary:'summary'},{...base,case:'x',family:'A',variant:'fresh_checkpoint',arm:undefined,summary:'summary'}].map((r,i)=>({path:String(i),sha256:'x',label:'study',run:r,review}));
 expect(familyComparisons(context)[0]!.comparisons[0]!.qualityPassing).toBe(false);
});
it('preserves unknown historical files and allows raw read without claiming structured import',async()=>{const {root}=await setup();await writeFile(join(root,'history.json'),'old artifact');expect(await resultSummary('history.json',root)).toMatchObject({version:'historical file / unknown'});expect(await readResultFile('history.json','history.json',root)).toBe('old artifact');});
it('keeps a completed thread-arm review stable when later trials are appended',async()=>{
 const {root,dir}=await setup(),batch=join(dir,'segment-1');await mkdir(batch);
 const trial={repeat:1,historyTurns:1,setupTurns:[],arms:[{arm:'same-thread',turn:{answer:'answer',usage:run('baseline').usage}}]};
 await writeFile(join(batch,'thread-switch.json'),JSON.stringify({trials:[trial]}));const [first]=await reviewItems('run',root);await saveReview('run',first!,review,root);
 await writeFile(join(batch,'thread-switch.json'),JSON.stringify({trials:[trial,{...trial,repeat:2}]}));expect((await reviewItems('run',root))[0]?.review?.pass).toBe(true);
});
it('keeps historical accounting unknown and includes separate context assessments in overall quality',async()=>{
 const {root,dir}=await setup(),base=join(dir,'segment-1');await mkdir(base);await writeFile(join(base,'manifest.json'),'{}');
 const saved=join(base,'x/A/1/fresh_checkpoint/run.json');await mkdir(join(saved,'..'),{recursive:true});
 await writeFile(saved,JSON.stringify({case:'x',family:'A',variant:'fresh_checkpoint',repeat:1,neutralId:'neutral',completed:true,finishedAt:'now',checkpoint:{goal:'x'},check:{passed:true},stages:[]}));
 await writeFile(join(dir,'state.json'),JSON.stringify({version:1,execution:'completed',quality:'needs-review',segment:1,updatedAt:'now'}));
 const [item]=await reviewItems('run',root);await saveReview('run',item!,{...review,preservedContext:true,checkpointPass:false},root);
 expect(JSON.parse(await readFile(join(dir,'state.json'),'utf8')).quality).toBe('failed');
 expect((await resultSummary('run',root)).accounting.totalEstimatedUsd).toBeNull();
});
it('requires quality-reviewed frozen pilot pairs before offering a selected confirmation',async()=>{
 const {root,dir}=await setup(),base=join(dir,'segment-1');await mkdir(base);
 await writeFile(join(dir,'center-manifest.json'),JSON.stringify({schemaVersion:1,preview:{profile:{category:'context-models',name:'quick'}}}));
 await writeFile(join(dir,'state.json'),JSON.stringify({version:1,execution:'completed',quality:'needs-review',segment:1,updatedAt:'now'}));
 const plan=['resume','fresh_checkpoint'].map(variant=>({case:'pilot',family:'A',variant,repeat:1}));
 await writeFile(join(base,'manifest.json'),JSON.stringify({opts:{phase:'pilot'},sourceHashes:{},plan,suiteSha256:'suite'}));
 for(const trial of plan){const path=join(base,`pilot/A/1/${trial.variant}`);await mkdir(path,{recursive:true});await writeFile(join(path,'run.json'),JSON.stringify({...trial,neutralId:trial.variant,completed:true,finishedAt:'now',check:{passed:true},setupStateMatched:true,protectedFilesUnchanged:true,beforeInterventionStateHash:'same',stages:[]}));}
 const {studySource}=await import('../src/benchmark/results.js'),comparison={family:'A',variants:['resume','fresh_checkpoint']};
 await expect(studySource('run',root,comparison)).rejects.toThrow('review');
 for(const item of await reviewItems('run',root))await saveReview('run',item,{...review,preservedContext:true,checkpointPass:true},root);
 expect((await studySource('run',root,comparison)).reviewEvidenceSha256).toMatch(/^[a-f0-9]{64}$/);
});
it('preserves browsing access when an interrupted run left a malformed artifact',async()=>{
 const {root,dir}=await setup();await mkdir(join(dir,'segment-1'));await writeFile(join(dir,'segment-1/run.json'),'{"unfinished":');
 const summary=await resultSummary('run',root);expect(summary.warnings).toEqual(expect.arrayContaining([expect.stringContaining('Structured review unavailable')]));
 expect(await readResultFile('run','segment-1/run.json',root)).toBe('{"unfinished":');
 await writeFile(join(dir,'center-manifest.json'),JSON.stringify({schemaVersion:99}));expect(await reviewItems('run',root)).toEqual([]);
});
