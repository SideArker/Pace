import { mkdir, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppServerRunner } from '../src/integrations/app-server-runner.js';
import { readAvailableModels } from '../src/integrations/models.js';
import { Capture, PRICES } from './context-models-support.js';
const out = process.argv[2];
if (!out) throw new Error('Supply output directory');
await mkdir(out,{recursive:true});
await writeFile(join(out,'models.json'),JSON.stringify(await readAvailableModels(),null,2));
const root=await mkdtemp(join(tmpdir(),'pace-model-probe-'));
for (const route of [{model:'gpt-6.1-sol',effort:'medium' as const},{model:'gpt-6-luna',effort:'low' as const}]) {
  const capture=new Capture(join(out,route.model+'.events.jsonl'),route);
  const start=performance.now(); let result, error;
  try {result=await new AppServerRunner(capture.factory).run('Infrastructure probe. Use a shell tool to run node --version, then in a separate tool call run printf PACE_PROBE_OK. Do not edit files. Reply with the marker and Node version.',root,route,undefined,p=>{if(p.kind==='approval')p.respond('decline');},AbortSignal.timeout(90000),'side');}
  catch(e){error=String(e);}
  const record={route,result,error,durationMs:Math.round(performance.now()-start),...capture.audit(result?.usage),prices:PRICES};
  await writeFile(join(out,route.model+'.json'),JSON.stringify(record,null,2));
  console.log(JSON.stringify({route,error,result:result?.result,audit:capture.audit(result?.usage)}));
  if(error)break;
}
