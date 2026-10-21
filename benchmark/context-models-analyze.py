#!/usr/bin/env python3
"""Read-only aggregation of all attempts; manual grades are separate evidence."""
import argparse, json, pathlib, collections
parser=argparse.ArgumentParser();parser.add_argument('results');args=parser.parse_args();root=pathlib.Path(args.results)
keys=['input_tokens','cached_input_tokens','cache_write_input_tokens','output_tokens','reasoning_output_tokens']
def usage(stages):
 result={k:sum(s['audit']['usage'][k] for s in stages) if stages and all(s.get('audit',{}).get('usage',{}).get(k) is not None for s in stages) else None for k in keys}
 result['ordinary_input_tokens']=result['input_tokens']-result['cached_input_tokens']-result['cache_write_input_tokens'] if all(result[k] is not None for k in keys[:3]) else None
 return result
runs=[]
for p in sorted(root.glob('*/**/run.json')):
 if '/blind/' in str(p):continue
 corrected=p.with_name('accounting-corrected.json');r=json.loads((corrected if corrected.exists() else p).read_text());stages=r['stages'];index=r.get('interventionStageIndex');row={k:r.get(k) for k in ['neutralId','case','family','variant','repeat','completed','error','totals','postIntervention','contextBeforeIntervention','initialStateHash','beforeInterventionStateHash','setupHistoryCharacters','setupStateMatched','threadTransitionValidated','summaryThreadValidated','changedFiles','protectedFilesUnchanged']}
 row['path']=str(p.relative_to(root));row['batch']=p.relative_to(root).parts[0];row['checkPassed']=r.get('check',{}).get('passed');row['usage']=usage(stages);row['postUsage']=usage(stages[index:]) if index is not None else None
 row['stages']=[{'kind':s['kind'],'route':s.get('route'),'threadId':s.get('threadId'),'requestedThreadId':s.get('requestedThreadId'),'durationMs':s.get('durationMs'),'modelRequests':s.get('audit',{}).get('modelRequests'),'aggregationMatches':s.get('audit',{}).get('aggregationMatches'),'usage':s.get('audit',{}).get('usage'),'costUsd':s.get('audit',{}).get('estimateNoUnreportedWritesUsd'),'threads':s.get('audit',{}).get('threads'),'error':s.get('error')} for s in stages]
 row['summary']=r.get('summary');row['checkpoint']=r.get('checkpoint');runs.append(row)
result={'attempts':len(runs),'completed':sum(bool(r['completed'])for r in runs),'externalCheckPassed':sum(bool(r['checkPassed'])for r in runs),'completeCostAttempts':sum((r.get('totals') or {}).get('costUsd')is not None for r in runs),'knownCostSubtotalUsd':sum((r.get('totals') or {}).get('knownCostSubtotalUsd',0)for r in runs),'totalCostUsd':sum(r['totals']['costUsd']for r in runs)if all((r.get('totals')or{}).get('costUsd')is not None for r in runs)else None,'aggregationMismatches':sum(s['aggregationMatches']is False for r in runs for s in r['stages']),'byBatch':dict(collections.Counter(r['batch']for r in runs)),'runs':runs}
(root/'analysis.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({k:v for k,v in result.items()if k!='runs'},indent=2))
