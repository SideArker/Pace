import React from 'react';
import { render } from 'ink';
import { BenchmarkManager } from '../components/BenchmarkManager.js';
import { assertDebug } from '../benchmark/storage.js';
import { preflight } from '../benchmark/preflight.js';
import { startRun, resumeRun, previewResume } from '../benchmark/service.js';
import { listResults, resultSummary, resultFiles, readResultFile, analyzeResult } from '../benchmark/results.js';
import { catalog, categories } from '../benchmark/catalog.js';
import { interactiveInkOptions } from './terminal-options.js';
import type { Selection } from '../benchmark/types.js';
export const benchmarkHelp=`Usage:
  pace benchmark                              Open Benchmark Center (TTY)
  pace benchmark list                         List named profiles; no inference
  pace benchmark run CATEGORY --profile NAME [--preview]
    [--max-turns N] [--max-usd N] [--controlled] [--repeats N (Memory Confirm only)]
  pace benchmark results [RUN_ID] [--files | --file RELATIVE_PATH]
  pace benchmark resume RUN_ID [--preview]
  pace benchmark analyze|summarize RUN_ID

Run is an explicit Start. Preview/list/results never invoke models.
Dollars estimate Standard API equivalents; a threshold stops subsequent calls.
Memory profiles: prepare, quick, standard, confirm, full-cycle.
Fresh completion is uncontrolled; Memory requires Linux isolation.`;
export function parseBenchmarkArgs(args:string[]) {
  const positional:string[]=[],values:Record<string,string>={},flags=new Set<string>();
  const booleans=['--preview','--offline','--controlled','--files','--help'];
  const valued=['--profile','--baseline','--source','--max-turns','--max-usd','--dataset','--file','--repeats'];
  for(let i=0;i<args.length;i++) {
    const value=args[i]!;
    if(booleans.includes(value)){if(flags.has(value))throw new Error(`Duplicate flag: ${value}`);flags.add(value);}
    else if(valued.includes(value)){if(values[value]!==undefined||!args[i+1]||args[i+1]!.startsWith('--'))throw new Error(`Missing or duplicate value: ${value}`);values[value]=args[++i]!;}
    else if(value.startsWith('-'))throw new Error(`Unknown flag: ${value}`);else positional.push(value);
  }
  return {positional,values,flags};
}
export const benchmarkCommandService={preflight,startRun,resumeRun,previewResume,listResults,resultSummary,resultFiles,readResultFile,analyzeResult};
export async function benchmarkCommand(args:string[],service=benchmarkCommandService) {
  const {preflight,startRun,resumeRun,previewResume,listResults,resultSummary,resultFiles,readResultFile,analyzeResult}=service;
  assertDebug();
  const {positional,values,flags}=parseBenchmarkArgs(args),[action,id]=positional;
  if(flags.has('--help')){console.log(benchmarkHelp);return;}
  const allowed=(named:string[],boolean:string[])=>{for(const key of Object.keys(values))if(!named.includes(key))throw new Error(`Flag ${key} does not apply to ${action??'panel'}`);for(const key of flags)if(!boolean.includes(key))throw new Error(`Flag ${key} does not apply to ${action??'panel'}`);};
  if(!action){allowed([],[]);if(!process.stdin.isTTY||!process.stdout.isTTY)throw new Error('Benchmark Center needs a TTY. Use benchmark list, results, or run CATEGORY --profile NAME.');await panel();return;}
  if(action==='list'){allowed([],[]);if(positional.length!==1)throw new Error('Usage: benchmark list');console.log(catalog.map(p=>`${p.category}/${p.name} · ${p.evaluation}`).join('\n'));return;}
  if(action==='run') {
    allowed(['--profile','--baseline','--source','--max-turns','--max-usd','--dataset','--repeats'],['--preview','--offline','--controlled']);
    if(positional.length!==2||!values['--profile'])throw new Error('Usage: benchmark run CATEGORY --profile NAME (complete named profile required)');
    const selection:Selection={category:id!,profile:values['--profile']!,baseline:values['--baseline'],source:values['--source'],dataset:values['--dataset'],offline:flags.has('--offline'),controlled:flags.has('--controlled'),maxTurns:values['--max-turns']===undefined?undefined:Number(values['--max-turns']),maxUsd:values['--max-usd']===undefined?undefined:Number(values['--max-usd'])};
    if(values['--repeats']!==undefined)selection.repeats=Number(values['--repeats']);
    const preview=await preflight(selection);console.log(JSON.stringify(preview,null,2));
    if(!flags.has('--preview'))await withCancellation(signal=>startRun(selection,{preview,signal,onEvent:event=>{if(event.kind==='log')process.stdout.write(String(event.text));}}).then(result=>{console.log(JSON.stringify(result,null,2));if(result.state.execution!=='completed')process.exitCode=1;}));return;
  }
  if(action==='results') {
    allowed(['--file'],['--files']);if(positional.length>2)throw new Error('Usage: benchmark results [RUN_ID]');
    if(!id){if(values['--file']||flags.has('--files'))throw new Error('Select a run ID first');if(process.stdin.isTTY&&process.stdout.isTTY)await panel(true);else console.log(JSON.stringify(await listResults(),null,2));}
    else if(values['--file'])console.log(await readResultFile(id,values['--file']));
    else if(flags.has('--files'))console.log((await resultFiles(id)).join('\n'));
    else console.log(JSON.stringify(await resultSummary(id),null,2));return;
  }
  allowed([],action==='resume'?['--preview']:[]);if(positional.length!==2)throw new Error(`Usage: benchmark ${action} RUN_ID`);
  if(action==='resume'){console.log(JSON.stringify(await previewResume(id!),null,2));if(flags.has('--preview'))return;await withCancellation(signal=>resumeRun(id!,{signal,onEvent:event=>{if(event.kind==='log')process.stdout.write(String(event.text));}}).then(result=>{console.log(JSON.stringify(result,null,2));if(result.state.execution!=='completed')process.exitCode=1;}));return;}
  if(action==='analyze'||action==='summarize'||action==='reaccount'){console.log(await analyzeResult(id!,action));return;}
  throw new Error(`Unknown benchmark command: ${action}`);
}
async function withCancellation<T>(action:(signal:AbortSignal)=>Promise<T>) {
  const abort=new AbortController(),cancel=()=>abort.abort();process.once('SIGINT',cancel);process.once('SIGTERM',cancel);
  try{return await action(abort.signal);}finally{process.off('SIGINT',cancel);process.off('SIGTERM',cancel);}
}
async function panel(initialResults=false) {
  let instance:ReturnType<typeof render>;instance=render(<BenchmarkManager width={process.stdout.columns??100} height={(process.stdout.rows??30)-1} initialResults={initialResults} onClose={()=>instance.unmount()}/>,interactiveInkOptions);await instance.waitUntilExit();
}
