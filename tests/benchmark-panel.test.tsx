import React from 'react';
import { PassThrough, Writable } from 'node:stream';
import { render } from 'ink';
import { afterEach, expect, it, vi } from 'vitest';
import { BenchmarkManager, type BenchmarkService } from '../src/components/BenchmarkManager.js';
import { preflight } from '../src/benchmark/preflight.js';
class Terminal extends Writable {isTTY=true;columns=120;rows=40;writes:string[]=[];override _write(chunk:Buffer,_encoding:BufferEncoding,done:()=>void){this.writes.push(chunk.toString());done();}}
const instances:ReturnType<typeof render>[]=[];
afterEach(()=>{for(const instance of instances.splice(0))instance.unmount();vi.restoreAllMocks();});
async function mount(canStart=()=>undefined as string|undefined){
 const stdout=new Terminal(),stdin=Object.assign(new PassThrough(),{isTTY:true,setRawMode:()=>{},ref:()=>{},unref:()=>{}}),onClose=vi.fn();
 const service={preflight,loadPreferences:vi.fn().mockResolvedValue(undefined),savePreferences:vi.fn().mockResolvedValue(undefined),baselineChoices:vi.fn().mockResolvedValue([]),startRun:vi.fn().mockResolvedValue({id:'test-run',state:{execution:'completed'}}),resumeRun:vi.fn(),listResults:vi.fn().mockResolvedValue([{id:'test-run',label:'test-run · completed'}]),resultSummary:vi.fn().mockResolvedValue({version:1,missingReviews:1}),resultFiles:vi.fn().mockResolvedValue(['answer.md','diff.patch']),readResultFile:vi.fn().mockResolvedValue('answer evidence'),reviewItems:vi.fn().mockResolvedValue([{path:'segment-1/x/run.json',sha256:'hash',label:'case · baseline',run:{id:'case',rubric:'Preserve behavior'}}]),saveReview:vi.fn().mockResolvedValue(undefined),analyzeResult:vi.fn()} as unknown as BenchmarkService;
 const instance=render(<BenchmarkManager width={120} height={38} onClose={onClose} service={service} canStart={canStart}/>,{stdin,stdout,stderr:new PassThrough(),interactive:true,patchConsole:false,alternateScreen:false,maxFps:1000});instances.push(instance);
 const key=async(value:string)=>{stdin.write(value);await instance.waitUntilRenderFlush();await new Promise(resolve=>setTimeout(resolve,value==='\x1b'?100:10));await instance.waitUntilRenderFlush();};
 await instance.waitUntilRenderFlush();return {service,stdout,stdin,instance,key,onClose};
}
it('previews a Quick profile for every available family without Start and passes the same config as CLI',async()=>{
 const ui=await mount();for(let category=0;category<1;category++){
  await ui.key('\r');for(let i=0;i<(category===0?0:1);i++)await ui.key('\x1b[B');await ui.key('\r');await ui.key('\r');
  if(category===2)await ui.key('\r'); // explicit candidate-only choice
  await vi.waitFor(()=>expect(ui.stdout.writes.join('')).toContain(category===6?'no allowance is used.':'Explicit Start consumes allowance.'));
  expect(ui.service.startRun).not.toHaveBeenCalled();await ui.key('\x1b');
 }
 expect(ui.service.savePreferences).toHaveBeenCalledTimes(1);
 for(const [selection] of vi.mocked(ui.service.savePreferences).mock.calls)expect(await preflight(selection)).toEqual(await preflight({category:selection.category,profile:'quick'}));
});
it('rejects Start with active jobs while retaining preview and results access',async()=>{
 const ui=await mount(()=>'Wait for active jobs and queue');await ui.key('\r');await ui.key('\r');await ui.key('\r');await ui.key('\r');
 await vi.waitFor(()=>expect(ui.stdout.writes.join('')).toContain('Wait for active jobs and queue'));expect(ui.service.startRun).not.toHaveBeenCalled();
});
it('starts only on explicit Start and cancels only the run through its AbortSignal',async()=>{
 const ui=await mount();let signal:AbortSignal|undefined;
 vi.mocked(ui.service.startRun).mockImplementation(async(_selection,options)=>{signal=options?.signal;return await new Promise((_resolve,reject)=>signal!.addEventListener('abort',()=>reject(new Error('cancelled run'))));});
 await ui.key('\r');await ui.key('\r');await ui.key('\r');expect(ui.service.startRun).not.toHaveBeenCalled();await ui.key('\r');
 await vi.waitFor(()=>expect(ui.service.startRun).toHaveBeenCalledOnce());await ui.key('\x1b');expect(signal?.aborted).toBe(true);expect(ui.onClose).not.toHaveBeenCalled();
});
it('browses artifacts and saves a review with severity, notes, evidence and affected behavior',async()=>{
 const ui=await mount();await ui.key('\x1b[B');await ui.key('\r');await ui.key('\r');
 await ui.key('\x1b[B');await ui.key('\x1b[B');await ui.key('\r');await ui.key('\r');
 await ui.key('\r'); // mark execution pass
 for(let i=0;i<4;i++)await ui.key('\x1b[B');await ui.key('\r');
 for(const value of ['Meets rubric','answer.md line 2','Existing parser behavior']){await ui.key(value);await ui.key('\r');}
 await vi.waitFor(()=>expect(ui.service.saveReview).toHaveBeenCalledWith('test-run',expect.anything(),expect.objectContaining({pass:true,notes:'Meets rubric',evidence:'answer.md line 2',affectedBehavior:'Existing parser behavior',severity:'major'})));
});
it('scrolls through a long unbroken answer instead of hiding its wrapped tail',async()=>{
 const ui=await mount();vi.mocked(ui.service.readResultFile).mockResolvedValue('x'.repeat(8000)+'\nEND_OF_ANSWER');
 await ui.key('\x1b[B');await ui.key('\r');await ui.key('\r');await ui.key('\x1b[B');await ui.key('\r');await ui.key('\r');
 expect(ui.stdout.writes.join('')).not.toContain('END_OF_ANSWER');await ui.key('\x1b[B'.repeat(100));
 await vi.waitFor(()=>expect(ui.stdout.writes.join('')).toContain('END_OF_ANSWER'));
});
