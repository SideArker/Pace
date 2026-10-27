import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import stringWidth from 'string-width';
import { TextInput } from '@inkjs/ui';
import { catalog, categories } from '../benchmark/catalog.js';
import { preflight } from '../benchmark/preflight.js';
import { startRun, resumeRun, previewResume } from '../benchmark/service.js';
import { listResults, resultFiles, readResultFile, reviewItems, saveReview, resultSummary, analyzeResult, type ReviewItem, type Review } from '../benchmark/results.js';
import { loadPreferences, savePreferences, baselineChoices } from '../benchmark/preferences.js';
import { isDebugBuild } from '../core/build-mode.js';
import type { Preview, Selection } from '../benchmark/types.js';
const native={preflight,startRun,resumeRun,previewResume,listResults,resultFiles,readResultFile,reviewItems,saveReview,resultSummary,analyzeResult,loadPreferences,savePreferences,baselineChoices};
export type BenchmarkService=typeof native;
type Screen='home'|'categories'|'profiles'|'baseline'|'baseline-path'|'source'|'preview'|'progress'|'results'|'result'|'files'|'file'|'reviews'|'review'|'notes'|'evidence'|'behavior'|'turn-limit'|'dollar-limit'|'dataset-path';
export function BenchmarkManager({width,height,onClose,canStart=()=>undefined,service=native,initialResults=false}: {width:number;height:number;onClose:()=>void;canStart?:()=>string|undefined;service?:BenchmarkService;initialResults?:boolean}) {
  const [screen,setScreen]=useState<Screen>(initialResults?'results':'home'),[index,setIndex]=useState(0);
  const [selection,setSelection]=useState<Selection>({category:'routing',profile:'quick'}),[preview,setPreview]=useState<Preview>(),[resuming,setResuming]=useState(false);
  const [runs,setRuns]=useState<Awaited<ReturnType<typeof listResults>>>([]),[baselines,setBaselines]=useState<string[]>([]),[runId,setRunId]=useState(''),[files,setFiles]=useState<string[]>([]),[items,setItems]=useState<ReviewItem[]>([]),[item,setItem]=useState<ReviewItem>();
  const [review,setReview]=useState<Review>({pass:false,notes:'',evidence:'',affectedBehavior:'',severity:'major'});
  const [output,setOutput]=useState(''),[offset,setOffset]=useState(0),[fileBack,setFileBack]=useState<Screen>('files'),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const operation=useRef<AbortController|undefined>(undefined),mounted=useRef(true);
  const go=(next:Screen)=>{setScreen(next);setIndex(0);setError('');setOffset(0);};
  const perform=async(action:()=>Promise<void>)=>{if(busy)return;setBusy(true);setError('');try{await action();}catch(error){if(mounted.current)setError(String(error));}finally{if(mounted.current)setBusy(false);}};
  useEffect(()=>{mounted.current=true;void service.loadPreferences().then(saved=>{if(saved&&mounted.current)setSelection(saved);});if(initialResults)void perform(async()=>setRuns(await service.listResults()));return()=>{mounted.current=false;operation.current?.abort();};},[]);
  const showPreview=async(value:Selection)=>{const next=await service.preflight(value);setSelection(value);setPreview(next);setResuming(false);await service.savePreferences(value);go('preview');};
  const chooseProfile=async(value:Selection)=>{
    if(value.category==='task-control'){setSelection(value);setBaselines(await service.baselineChoices());go('baseline');}
    else if(value.profile.startsWith('confirmation-')){setSelection(value);const available=(await service.listResults()).filter(run=>run.category==='context-models'&&run.execution==='completed'&&['quick','standard'].includes(run.profile??''));setRuns(available);go('source');}
    else await showPreview(value);
  };
  const run=async(resume=false)=>{
    const reason=canStart();if(reason)throw new Error(reason);
    const controller=new AbortController();operation.current=controller;go('progress');setOutput('Starting benchmark…');
    try {const result=await (resume?service.resumeRun(runId,{signal:controller.signal,canStart,onEvent:event=>{if(mounted.current)setOutput(old=>(old+'\n'+(event.kind==='log'?String(event.text):`${event.kind} ${event.key??event.trial??''}`)).slice(-30000));}}):service.startRun(selection,{preview,signal:controller.signal,canStart,onEvent:event=>{if(mounted.current)setOutput(old=>(old+'\n'+(event.kind==='log'?String(event.text):`${event.kind} ${event.key??event.trial??''}`)).slice(-30000));}}));
      if(mounted.current){setRunId(result.id);setOutput(JSON.stringify(result,null,2));go('result');}
    }finally{operation.current=undefined;}
  };
  const currentProfiles=catalog.filter(p=>p.category===selection.category);
  const outputRows=Math.max(3,height-7);
  const outputLines=useMemo(()=>output.split('\n').flatMap(line=>{
    const rows:string[]=[];let row='',columns=0;
    for(const char of line){const size=stringWidth(char);if(columns+size>Math.max(10,width-4)){rows.push(row);row='';columns=0;}row+=char;columns+=size;}
    rows.push(row);return rows;
  }),[output,width]);
  const choices=screen==='home'?['Run benchmark','Results','Close']
    :screen==='categories'?categories.map(c=>`${c.label}${c.unavailable?` · ${c.unavailable}`:''}`)
    :screen==='profiles'?currentProfiles.map(p=>p.name)
    :screen==='baseline'?['Candidate-only (no A/B)',...baselines,'Enter another built baseline path']
    :screen==='source'?runs.map(r=>r.label)
    :screen==='preview'?(resuming||!preview?.profile.paid?['Start','Inspect ordered trial plan','Back']:['Start','Inspect ordered trial plan','Set model/Vex call limit','Set estimated dollar threshold',...(selection.category==='workflows'?['Use a pinned dataset manifest']:[]),'Back'])
    :screen==='results'?runs.map(r=>r.label).concat('Back')
    :screen==='result'?['Summary / accounting','Artifacts / answers / diffs / checks','Review / grades','Resume unfinished trials','Analyze context study','Summarize graded context study','Reaccount (derived file)','Back']
    :screen==='files'?files.concat('Back')
    :screen==='reviews'?items.map(i=>`${i.review?'reviewed':'missing grade'} · ${i.label}`).concat('Back')
    :screen==='review'?['Execution quality: '+(review.pass?'pass':'fail'),'Context preserved: '+(review.preservedContext===undefined?'ungraded':review.preservedContext?'yes':'no'),'Summary quality: '+(review.summaryPass===undefined?'ungraded':review.summaryPass?'pass':'fail'),'Checkpoint quality: '+(review.checkpointPass===undefined?'ungraded':review.checkpointPass?'pass':'fail'),'Severity: '+review.severity,'View answer / diff / checks','Add notes and evidence','Back']:[];
  useInput((input,key)=>{
    if(key.escape||(key.ctrl&&input==='c')) {if(operation.current)operation.current.abort();else if(busy)return;else if(screen==='home')onClose();else if(screen==='result')void perform(async()=>{setRuns(await service.listResults());go('results');});else go(screen==='file'?fileBack:screen==='review'?'reviews':'home');return;}
    if(busy)return;
    if(screen==='file'){if(key.downArrow)setOffset(v=>Math.min(Math.max(0,outputLines.length-outputRows),v+1));if(key.upArrow)setOffset(v=>Math.max(0,v-1));return;}
    if(key.upArrow||key.downArrow||key.tab){setIndex(i=>(i+(key.upArrow||key.shift?-1:1)+choices.length)%Math.max(1,choices.length));return;}
    if(!key.return||!choices.length)return;
    void perform(async()=>{
      if(screen==='home'){if(index===0){go('categories');setIndex(Math.max(0,categories.findIndex(c=>c.id===selection.category)));}else if(index===1){setRuns(await service.listResults());go('results');}else onClose();}
      else if(screen==='categories'){const category=categories[index]!;if(category.unavailable)throw new Error(category.unavailable);const remembered=category.id===selection.category?selection.profile:'quick';setSelection({category:category.id,profile:remembered});go('profiles');setIndex(Math.max(0,catalog.filter(p=>p.category===category.id).findIndex(p=>p.name===remembered)));}
      else if(screen==='profiles')await chooseProfile({...selection,profile:currentProfiles[index]!.name,baseline:undefined,source:undefined});
      else if(screen==='baseline'){if(index===0)await showPreview({...selection,baseline:undefined});else if(index<=baselines.length)await showPreview({...selection,baseline:baselines[index-1]});else go('baseline-path');}
      else if(screen==='source')await showPreview({...selection,source:runs[index]!.id});
      else if(screen==='preview'){if(index===0)await run(resuming);else if(index===1){setOutput(`${preview!.profile.category}/${preview!.profile.name}\nSuite: ${preview!.profile.suite??'Synthetic built-in fixture'}\nVariants: ${preview!.profile.variants.join(', ')}\n${preview!.baselineScope??preview!.profile.evaluation}\n\nOrdered trials:\n${preview!.plan.map((trial,i)=>`${i+1}. ${trial.description}`).join('\n')}`);setFileBack('preview');go('file');}else if(resuming){setResuming(false);go('result');}else if(index===2)go('turn-limit');else if(index===3)go('dollar-limit');else if(index===4&&selection.category==='workflows')go('dataset-path');else go('profiles');}
      else if(screen==='results'){if(index===runs.length)go('home');else {const selected=runs[index]!;setRunId(selected.id);setOutput(JSON.stringify(await service.resultSummary(selected.id),null,2));go('result');}}
      else if(screen==='result'){
        if(index===0){setOutput(JSON.stringify(await service.resultSummary(runId),null,2));setFileBack('result');go('file');}
        else if(index===1){setFiles(await service.resultFiles(runId));go('files');}
        else if(index===2){setItems(await service.reviewItems(runId));go('reviews');}
        else if(index===3){const resume=await service.previewResume(runId);setPreview(resume.preview);setResuming(true);setOutput(`${resume.remainingTrials} unfinished trials; ${resume.retainedCalls} prior calls, known subtotal $${resume.knownSubtotalUsd}. ${resume.note}`);go('preview');}
        else if(index<7){setOutput(await service.analyzeResult(runId,(['analyze','summarize','reaccount'] as const)[index-4]!));setFileBack('result');go('file');}
        else {setRuns(await service.listResults());go('results');}
      } else if(screen==='files'){if(index===files.length)go('result');else {setOutput(await service.readResultFile(runId,files[index]!));setFileBack('files');go('file');}}
      else if(screen==='reviews'){if(index===items.length)go('result');else{const next=items[index]!;setItem(next);setReview(next.review??{pass:false,notes:'',evidence:'',affectedBehavior:'',severity:'major'});setOutput(JSON.stringify(next.run,null,2));go('review');}}
      else if(screen==='review'){
        if(index===0)setReview(r=>({...r,pass:!r.pass}));
        else if(index===1)setReview(r=>({...r,preservedContext:!r.preservedContext}));
        else if(index===2)setReview(r=>({...r,summaryPass:!r.summaryPass}));
        else if(index===3)setReview(r=>({...r,checkpointPass:!r.checkpointPass}));
        else if(index===4)setReview(r=>({...r,severity:r.severity==='minor'?'major':r.severity==='major'?'critical':'minor'}));
        else if(index===5){let detail=JSON.stringify(item?.run,null,2);const diffPath=item!.path.replace(/run\.json$/, 'diff.patch');try{detail+='\n\nDiff:\n'+await service.readResultFile(runId,diffPath);}catch{}setOutput(detail);setFileBack('review');go('file');}else if(index===6)go('notes');else go('reviews');
      }
    });
  });
  const field=screen==='turn-limit'?'Maximum model/Vex calls (positive integer)':screen==='dollar-limit'?'Estimated dollar threshold (empty = unset)':screen==='dataset-path'?'Pinned dataset manifest path (empty = local fixtures)':screen==='baseline-path'?'Built baseline checkout path':screen==='notes'?'Review notes':screen==='evidence'?'Evidence (file/check/answer reference)':screen==='behavior'?'Affected behavior':'';
  const submitField=(value:string)=>{void perform(async()=>{
    if(screen==='turn-limit')await showPreview({...selection,maxTurns:Number(value)});
    else if(screen==='dollar-limit')await showPreview({...selection,maxUsd:value.trim()?Number(value):undefined});
    else if(screen==='dataset-path')await showPreview({...selection,dataset:value.trim()||undefined});
    else if(screen==='baseline-path')await showPreview({...selection,baseline:value});
    else if(screen==='notes'){if(!value.trim())throw new Error('Notes are required');setReview(r=>({...r,notes:value}));go('evidence');}
    else if(screen==='evidence'){if(!value.trim())throw new Error('Evidence is required');setReview(r=>({...r,evidence:value}));go('behavior');}
    else {await service.saveReview(runId,item!,{...review,affectedBehavior:value});setItems(await service.reviewItems(runId));go('reviews');}
  });};
  const rows=Math.max(3,height-14),start=Math.max(0,Math.min(index-Math.floor(rows/2),choices.length-rows));
  if(!isDebugBuild)return <Text>Benchmark Center is available only in a debug build.</Text>;
  return <Box flexDirection="column" width={width} height={Math.max(10,height)} paddingX={1} overflowY="hidden">
    <Text bold color="#A5B4FC">Benchmark Center · {screen}{runId&&['result','file','reviews','review'].includes(screen)?` · ${runId}`:''}</Text>
    <Text dimColor>Debug checkout · preview/results make no model calls · Memory requires plan 02</Text>
    {preview&&screen==='preview'?<Box flexDirection="column"><Text>{resuming?`Resume ${runId} · `:''}{preview.profile.category}/{preview.profile.name} · {preview.plan.length} trials · {preview.profile.repeats} repeats</Text><Text>{preview.profile.route}</Text><Text>{preview.profile.evaluation}</Text><Text>{preview.estimate}</Text>{resuming?<Text>{output}</Text>:null}<Text>{preview.profile.paid?`Time: up to ${preview.profile.timeoutMinutes} min per turn/decision; `:''}Run watchdog {preview.plan.length*preview.profile.timeoutMinutes*8} min</Text><Text>{preview.baselineScope}</Text><Text>{preview.profile.paid?"Uncontrolled local experiment. Explicit Start consumes allowance.":"Explicit Start runs synthetic diagnostics; no allowance is used."}</Text></Box>:null}
    {screen==='result'?<Text>{output.slice(0,Math.max(100,width*3))}</Text>:null}
    {screen==='review'?<Text>{item?.run.rubric??'Review the raw answer, diff and external checks before grading.'}</Text>:null}
    {screen==='source'&&!runs.length?<Text>No completed context/model pilot is available. Run and review a pilot before confirmation.</Text>:null}
    {screen==='reviews'&&!items.length?<Text>No compatible review format found. Preserve and inspect raw artifacts; no automatic import.</Text>:null}
    {screen==='file'?<Text>{outputLines.slice(offset,offset+outputRows).join('\n')}</Text>:null}
    {screen==='progress'?<Text>{outputLines.slice(-outputRows).join('\n')}</Text>:null}
    {field&&!busy?<Box flexDirection="column"><Text>{field}</Text><TextInput key={screen} onSubmit={submitField}/></Box>:null}
    {!busy?choices.slice(start,start+rows).map((label,i)=><Text key={i} color={index===start+i?'#59E6A7':undefined}>{index===start+i?'❯':' '} {label}</Text>):<Text color="yellow">{screen==='progress'?'Running · Esc cancels only this benchmark':'Working…'}</Text>}
    {error?<Text color="red">{error}</Text>:null}<Box flexGrow={1}/><Text dimColor>↑/↓ select / scroll · Enter choose · Esc {operation.current?'cancel run':'back / close'}</Text>
  </Box>;
}
