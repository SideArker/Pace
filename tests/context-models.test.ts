import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Capture, btw, replay } from '../benchmark/context-models-support.js';
import { order, parseOptions, stateHash, runCase } from '../benchmark/context-models.js';
const calls=vi.hoisted(()=>[] as {prompt:string;route:any;thread?:string;mode?:string}[]);
vi.mock('../src/integrations/app-server-runner.js',()=>({AppServerRunner:class {
 async run(prompt:string,_root:string,route:any,thread:string|undefined,_p:any,_s:any,mode:string){calls.push({prompt,route,thread,mode});return {threadId:thread??`new-${calls.length}`,result:'Test response',completed:true,context:{tokens:1000,windowTokens:10000,model:route.model}};}
}}));
describe('context/model study measurement boundaries',()=>{
 it('aggregates multiple requests once, ignores resume baseline and duplicate events, and does not double-price reasoning',async()=>{
  const root=await mkdtemp(join(tmpdir(),'pace-study-test-'));const c=new Capture(join(root,'events.jsonl'),{model:'gpt-6.1-sol',effort:'medium'});
  const emit=(total:number,input:number,cached:number,output:number)=>c.log('in',{method:'thread/tokenUsage/updated',params:{tokenUsage:{total:{totalTokens:total},last:{inputTokens:input,cachedInputTokens:cached,cacheWriteInputTokens:0,outputTokens:output,reasoningOutputTokens:4}}}});
  emit(1000,900,0,100);c.log('out',{method:'turn/start'});emit(1000,900,0,100);emit(1110,100,40,10);emit(1110,100,40,10);emit(1230,110,50,10);
  const a=c.audit({input_tokens:210,cached_input_tokens:90,cache_write_input_tokens:0,output_tokens:20,reasoning_output_tokens:8});
  expect(a.modelRequests).toBe(2);expect(a.aggregationMatches).toBe(true);expect(a.usage).toMatchObject({input_tokens:210,reasoning_output_tokens:8});expect(a.estimateNoUnreportedWritesUsd).toBeCloseTo((120*2+90*0.1+20*10)/1e6);
 });
 it('preserves unknown measurements rather than converting absent fields to zero',async()=>{
  const root=await mkdtemp(join(tmpdir(),'pace-study-test-'));const c=new Capture(join(root,'events.jsonl'),{model:'gpt-6-luna',effort:'low'});c.log('out',{method:'turn/start'});c.log('in',{method:'thread/tokenUsage/updated',params:{tokenUsage:{total:{totalTokens:11},last:{inputTokens:10,outputTokens:1}}}});expect(c.audit().usage?.cached_input_tokens).toBeNull();expect(c.audit().usage?.cache_write_input_tokens).toBeNull();expect(c.audit().estimateNoUnreportedWritesUsd).toBeUndefined();
 });
 it('copies btw retained exchanges and last 24 visible lines, without inventing tool history',()=>{
  const history=[{user:'correction: throw',assistant:'unfinished'}];const lines=Array.from({length:30},(_,i)=>({role:'activity',text:`visible ${i}`,detail:`detail ${i}`}));const p=btw(history,lines,[{text:'pending',completed:false}],'summary','active');expect(p).toContain('User: correction: throw\nPace: unfinished');expect(p).not.toContain('visible 5 (');expect(p).toContain('visible 6 (detail 6)');expect(p).toContain('Current user request (still in progress):\nactive');expect(p).toContain('[ ] pending');expect(p).toContain('Do not edit files or take action.');expect(replay(history,'next')).toContain(JSON.stringify(history));
 });
 it('rotates order across three repeats and rejects invalid CLI flags',()=>{expect(order(['a','b'],1)).toEqual(['a','b']);expect(order(['a','b'],2)).toEqual(['b','a']);expect(order(['a','b'],3)).toEqual(['a','b']);expect(()=>parseOptions(['--silent-fallback','yes'])).toThrow();expect(()=>parseOptions(['--repeat','0'])).toThrow();expect(stateHash({b:'2',a:'1'})).toBe(stateHash({a:'1',b:'2'}));});
 it('keeps Luna side thread separate and returns both follow-ups to the main Sol thread',async()=>{
  calls.length=0;const out=await mkdtemp(join(tmpdir(),'pace-study-test-'));const task={id:'test',cohort:'pilot',files:{'package.json':'{}\n'},setup:['inspect','correction'],followups:['change','preserve'],check:"console.log('PASS')",rubric:'test',summaryFacts:[]};
  const r=await runCase(task,'B','luna_side',1,out,1);expect(r.completed).toBe(true);expect(calls.map(c=>c.thread)).toEqual([undefined,'new-1',undefined,'new-1','new-1']);expect(calls.map(c=>c.route.model)).toEqual(['gpt-6.1-sol','gpt-6.1-sol','gpt-6-luna','gpt-6.1-sol','gpt-6.1-sol']);expect(calls[2]?.mode).toBe('side');expect(r.summaryThreadValidated).toBe(true);expect(r.threadTransitionValidated).toBe(true);expect(JSON.parse(await readFile(join(out,'test/B/1/luna_side/run.json'),'utf8')).stages).toHaveLength(5);
 });
});
