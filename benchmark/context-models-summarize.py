#!/usr/bin/env python3
"""Produce reviewable comparisons from immutable runs plus explicit manual grades."""
import json,pathlib,sys,collections,datetime,csv,hashlib
root=pathlib.Path(sys.argv[1]);keys=['input_tokens','cached_input_tokens','cache_write_input_tokens','output_tokens','reasoning_output_tokens']
runs=[];stages=[]
for path in sorted(root.glob('*/**/run.json')):
 if 'blind'in path.parts:continue
 corrected=path.with_name('accounting-corrected.json');r=json.loads((corrected if corrected.exists()else path).read_text());batch=path.relative_to(root).parts[0]
 gp=root/batch/'grades.json';grade=json.loads(gp.read_text()).get('grades',{}).get(r['neutralId'])if gp.exists()else None
 r['batch']=batch;r['path']=str(path.relative_to(root));r['grade']=grade
 r['phase']='confirmation'if r['case'].startswith('holdout-')else'infrastructure_failure'if batch=='pilot'else'pilot'
 r['qualityPass']=bool(grade and grade['executionPass'] and grade.get('preservedContext') and all(grade.get(k)is None or grade[k]['pass']for k in ['summaryQuality','checkpointQuality']))
 r['wallDurationMs']=round((datetime.datetime.fromisoformat(r['finishedAt'])-datetime.datetime.fromisoformat(r['startedAt'])).total_seconds()*1000)if r.get('finishedAt')else None
 r['postWallDurationMs']=round((datetime.datetime.fromisoformat(r['finishedAt'])-datetime.datetime.fromisoformat(r['stages'][r['interventionStageIndex']]['startedAt'])).total_seconds()*1000)if r.get('finishedAt')and r.get('interventionStageIndex')is not None and r['stages'][r['interventionStageIndex']].get('startedAt')else None
 r['clockGapMs']=r['wallDurationMs']-r['totals']['durationMs']if r['wallDurationMs']is not None and r.get('totals',{}).get('durationMs')is not None else None
 r['followupCostUsd']=sum(s['audit']['estimateNoUnreportedWritesUsd']for s in r['stages']if s['kind'].startswith('followup-')and s.get('audit',{}).get('estimateNoUnreportedWritesUsd')is not None)if all(s.get('audit',{}).get('estimateNoUnreportedWritesUsd')is not None for s in r['stages']if s['kind'].startswith('followup-'))else None
 for i,s in enumerate(r['stages']):
  a=s.get('audit',{});u=a.get('usage')or{};ordinary=u.get('input_tokens')-u.get('cached_input_tokens')-u.get('cache_write_input_tokens')if all(u.get(k)is not None for k in keys[:3])else None
  stages.append({'batch':batch,'case':r['case'],'family':r['family'],'variant':r['variant'],'repeat':r['repeat'],'kind':s['kind'],'model':s.get('route',{}).get('model'),'effort':s.get('route',{}).get('effort'),'threadId':s.get('threadId'),'requestedThreadId':s.get('requestedThreadId'),'durationMs':s.get('durationMs'),'costUsd':a.get('estimateNoUnreportedWritesUsd'),'ordinary_input_tokens':ordinary,**{k:u.get(k)for k in keys},'modelRequests':a.get('modelRequests'),'runnerAggregationMatches':a.get('aggregationMatches'),'ignoredOtherTurnEvents':a.get('ignoredOtherTurnEvents'),'compactionPlaceholder':a.get('compactionPlaceholder'),'error':s.get('error')})
 runs.append(r)
# A failed attempt remains in the all-attempt audit; only completed quality-passing
# artifacts can enter the paired result. Never pair across experiment families.
completed={(r['phase'],r['case'],r['family'],r['repeat'],r['variant']):r for r in runs if r.get('completed')and r['phase']!='infrastructure_failure'}
pairs=[]
for key,cand in completed.items():
 phase,case,family,repeat,variant=key;basevar={'A':'resume','B':'sol','C':'checkpoint_sol'}[family]
 if variant==basevar:continue
 base=completed.get((phase,case,family,repeat,basevar))
 if not base:continue
 state=base.get('beforeInterventionStateHash')==cand.get('beforeInterventionStateHash')and base.get('setupStateMatched')and cand.get('setupStateMatched')
 quality=base['qualityPass']and cand['qualityPass']and state
 bc=base.get('postIntervention',{}).get('costUsd');cc=cand.get('postIntervention',{}).get('costUsd')
 pairs.append({'phase':phase,'case':case,'family':family,'repeat':repeat,'baseline':basevar,'candidate':variant,'baselinePath':base['path'],'candidatePath':cand['path'],'qualityPass':bool(quality),'fixtureStatesMatched':bool(state),'baselinePostCostUsd':bc,'candidatePostCostUsd':cc,'deltaCostUsd':cc-bc if bc is not None and cc is not None else None,'baselinePostDurationMs':base['postIntervention']['durationMs'],'candidatePostDurationMs':cand['postIntervention']['durationMs'],'baselinePostWallDurationMs':base['postWallDurationMs'],'candidatePostWallDurationMs':cand['postWallDurationMs'],'baselineClockGapMs':base['clockGapMs'],'candidateClockGapMs':cand['clockGapMs'],'baselineTotalCostUsd':base['totals']['costUsd'],'candidateTotalCostUsd':cand['totals']['costUsd']})
groups=[]
for phase,family,variant in sorted({(p['phase'],p['family'],p['candidate'])for p in pairs}):
 ps=[p for p in pairs if(p['phase'],p['family'],p['candidate'])==(phase,family,variant)];valid=[p for p in ps if p['qualityPass']and p['deltaCostUsd']is not None]
 groups.append({'phase':phase,'family':family,'candidate':variant,'completedPairs':len(ps),'qualityPassingPricedPairs':len(valid),'baselinePostCostUsd':sum(p['baselinePostCostUsd']for p in valid)if valid else None,'candidatePostCostUsd':sum(p['candidatePostCostUsd']for p in valid)if valid else None,'costWins':sum(p['deltaCostUsd']<0 for p in valid),'durationWins':sum(p['candidatePostDurationMs']<p['baselinePostDurationMs']for p in valid),'baselinePostDurationMs':sum(p['baselinePostDurationMs']for p in valid)if valid else None,'candidatePostDurationMs':sum(p['candidatePostDurationMs']for p in valid)if valid else None,'baselinePostWallDurationMs':sum(p['baselinePostWallDurationMs']for p in valid)if valid else None,'candidatePostWallDurationMs':sum(p['candidatePostWallDurationMs']for p in valid)if valid else None,'clockAnomalousPairs':sum(abs(p['baselineClockGapMs']or 0)>5000 or abs(p['candidateClockGapMs']or 0)>5000 for p in valid)})
probes=[]
for p in root.glob('probe*/gpt-*.json'):
 x=json.loads(p.read_text());probes.append({'path':str(p.relative_to(root)),'costUsd':x.get('estimateNoUnreportedWritesUsd'),'durationMs':x.get('durationMs'),'error':x.get('error')})
summary={'createdAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'postprocessorSha256':hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest(),'scenarioAttempts':len(runs),'scenarioCompleted':sum(bool(r.get('completed'))for r in runs),'scenarioQualityPass':sum(r['qualityPass']for r in runs),'scenarioKnownCostSubtotalUsd':sum((r.get('totals')or{}).get('knownCostSubtotalUsd',0)for r in runs),'scenarioTotalCostUsd':sum(r['totals']['costUsd']for r in runs)if all(r.get('totals',{}).get('costUsd')is not None for r in runs)else None,'probeTurns':len(probes),'probeKnownCostUsd':sum(p['costUsd']for p in probes if p['costUsd']is not None),'probes':probes,'groups':groups,'pairs':pairs,'runs':[{k:r.get(k)for k in ['batch','phase','path','neutralId','case','family','variant','repeat','completed','error','qualityPass','grade','totals','postIntervention','wallDurationMs','postWallDurationMs','clockGapMs','followupCostUsd','setupHistoryCharacters','contextBeforeIntervention','beforeInterventionStateHash','setupStateMatched','threadTransitionValidated','summaryThreadValidated','changedFiles','protectedFilesUnchanged','retries']}for r in runs]}
(root/'graded-summary.json').write_text(json.dumps(summary,indent=2,ensure_ascii=False)+'\n')
with(root/'stages.csv').open('w')as f:
 writer=csv.DictWriter(f,fieldnames=list(stages[0]));writer.writeheader();writer.writerows(stages)
print(json.dumps({k:v for k,v in summary.items()if k not in ['runs','pairs','probes']},indent=2))
