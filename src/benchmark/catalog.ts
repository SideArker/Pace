import type { Category, Profile } from './types.js';
export const categories: { id: Category; label: string; unavailable?: string }[] = [
  { id: 'routing', label: 'Routing · Vex only' }, { id: 'workflows', label: 'Executed workflows' },
  { id: 'task-control', label: 'Task control' }, { id: 'context-quality', label: 'Context quality' },
  { id: 'thread-switch', label: 'Model/thread switch' }, { id: 'context-models', label: 'Context/model study' },
  { id: 'diagnostics', label: 'Local persistence · no models' },
  { id: 'memory', label: 'Memory', unavailable: 'Requires memory integration — plan 02' },
];
const profiles: Profile[] = [];
function add(category: Category, name: string, driver: string, suite: string | undefined, args: string[], variants: string[], repeats: number, route: string, evaluation: string, timeoutMinutes = 5) {
  profiles.push({ category, name, driver, suite: suite && `benchmark/suites/${suite}.json`, args, variants, repeats, route, evaluation, version: 1, label: name, paid: category !== 'diagnostics', timeoutMinutes });
}
for (const [name, suite, repeat, shape] of [['quick','routing-suite',1,false],['standard','routing-suite',3,false],['holdout','routing-holdout',3,false],['shape-only','routing-suite',1,true]] as const)
  add('routing',name,'routing',suite,['--repeat',String(repeat),...(shape?['--shape-only']:[])],['production controller; simulated Codex'],repeat,'Enabled local Vex routes; no Codex execution','Routing labels; simulated reports do not grade code');
for (const [name,suite,repeat,extra] of [['quick','pilot',1,[]],['standard','pilot',2,[]],['validation','validation',3,['--include-auto','--include-luna']],['agentic','agentic',3,['--include-auto']]] as const)
  add('workflows',name,'runner/workflows',suite,['--repeat',String(repeat),'--timeout-minutes','12',...extra],['baseline',...(extra.includes('--include-luna' as never)?['luna_low']:[]),'routed_single','routed_split',...(extra.includes('--include-auto' as never)?['routed_auto']:[])],repeat,'Sol High baseline; Vex-routed stages','Checks + manual rubric; quality-passing pairs only',12);
for (const [name,suite] of [['quick','task-control'],['standard','task-control'],['paraphrases','task-control-paraphrases']] as const)
  add('task-control',name,'task-control',suite,[],['candidate'],1,'Seeded Luna Low / Sol Medium; Vex control','External checks + manual review; candidate-only unless a built baseline is selected',3);
for (const [name,repeats] of [['quick',1],['standard',3]] as const) {
  add('context-quality',name,'context-quality','context-quality',['--repeat',String(repeats)],['resume','fresh_replay','compact_resume','fresh_checkpoint'],repeats,'gpt-6-sol / medium','Checks, thread transition, rubric and lost-context review');
  add('thread-switch',name,'thread-switch',undefined,['--repeat',String(repeats),'--history-turns',name==='quick'?'1':'1,4,8'],['fresh-thread','same-thread'],repeats,'gpt-6-sol / high → gpt-6-luna / low','Shared successful setup; switch deltas + manual factual review');
}
add('context-quality','real-repo','context-quality','context-real-repo',['--repeat','1'],['resume','fresh_replay','compact_resume','fresh_checkpoint'],1,'gpt-6-sol / medium','Fixed repository commits, independent setup, external checks and manual rubric');
const studyVariants=['A/resume','A/compact_resume','A/fresh_replay','A/fresh_checkpoint','B/sol','B/luna_main','B/luna_side','C/checkpoint_sol','C/checkpoint_luna'];
add('context-models','quick','context-models','context-models-2026-10-20',['--phase','pilot','--repeat','1'],studyVariants,1,'Sol Medium / Luna Low; frozen study routes','Full preregistered pilot: families A/B/C, 16 scenarios, 83 turns + up to 4 repairs');
add('context-models','standard','context-models','context-models-2026-10-20',['--phase','pilot','--repeat','1'],studyVariants,1,'Sol Medium / Luna Low','Full preregistered pilot; no changed methodology');
for (const [family,variants] of [['A',['resume','fresh_checkpoint']],['B',['sol','luna_side']]] as const)
  add('context-models',`confirmation-${family}`,'context-models','context-models-2026-10-20',['--phase','confirmation','--family',family,'--variants',variants.join(','),'--repeat','3'],[...variants],3,'Frozen selected comparison; requires a compatible frozen pilot','Held-out cases; rotated order; manual execution/context/summary quality');
add('context-models','probe','context-models-probe',undefined,[],['gpt-6.1-sol','gpt-6-luna'],1,'Sol Medium / Luna Low','Infrastructure and usage audit only',1.5);
add('diagnostics','quick','session-persistence',undefined,['2'],['10 attempts','100 attempts','500 attempts'],1,'No models or account','Synthetic concurrent persistence assertions, process metrics and GC');
add('diagnostics','standard','session-persistence',undefined,['12'],['10 attempts','100 attempts','500 attempts'],1,'No models or account','Synthetic persistence assertions, process metrics and GC');
export const catalog: readonly Profile[] = profiles;
export function getProfile(category: string, name: string): Profile {
  const profile = catalog.find(p=>p.category===category && p.name===name);
  if (!profile) throw new Error(categories.find(c=>c.id===category)?.unavailable ?? `Unknown benchmark profile: ${category}/${name}`);
  return structuredClone(profile);
}
