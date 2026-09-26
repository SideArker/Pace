import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, appendFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isRecord } from './config.js';
import { PaceStore } from './core/sessions.js';
import { pricedModels, PRICE_SNAPSHOT } from './core/pricing.js';
import { chosenRoute, validateDecision, type RoutingDecision } from './core/router.js';
import { shapeRequest, stageRequest, VexRouter, type VexRequest } from './integrations/vex.js';
import type { ModelOption, TurnSummary } from './types.js';

export type RoutingCase = {
  id: string;
  category: string;
  prompt: string;
  preferred: 'single' | 'scout' | 'plan_execute' | 'clarify';
  acceptable: string[];
  reason: string;
  conversation?: { user: string; assistant: string }[];
  handoff?: { summary: string; files: string[]; checks: string[]; risks: string[] };
};
export type RoutingSuite = { version: 1; cases: RoutingCase[] };
type DecisionLog = { objective: string; choice: string; probabilities: Record<string, number>; confidence: number; attempts: number; elapsedMs: number; route?: { model?: string; effort?: string } };
export type RoutingRun = { id: string; category: string; repetition: number; promptSha256: string; preferred: string; acceptable: string[]; shape?: string; acceptableHit?: boolean; preferredHit?: boolean; decisions: DecisionLog[]; vexCalls: number; retries: number; elapsedMs: number; error?: string };

const SHAPES = ['single', 'scout', 'plan_execute', 'clarify'];
export function parseRoutingSuite(value: unknown): RoutingSuite {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.cases) || !value.cases.length)
    throw new Error('Routing suite needs version 1 and nonempty cases');
  const ids = new Set<string>();
  for (const item of value.cases) {
    if (!isRecord(item) || typeof item.id !== 'string' || !/^[a-z0-9_-]+$/.test(item.id) || ids.has(item.id) ||
      typeof item.category !== 'string' || !item.category || typeof item.prompt !== 'string' || !item.prompt.trim() ||
      !SHAPES.includes(String(item.preferred)) || !Array.isArray(item.acceptable) || !item.acceptable.length ||
      !item.acceptable.every((shape: unknown) => typeof shape === 'string' && SHAPES.includes(shape)) ||
      !item.acceptable.includes(item.preferred) || typeof item.reason !== 'string' || !item.reason.trim())
      throw new Error(`Invalid routing case ${isRecord(item) ? String(item.id) : ''}`);
    if (item.conversation !== undefined && (!Array.isArray(item.conversation) || !item.conversation.every(turn =>
      isRecord(turn) && typeof turn.user === 'string' && typeof turn.assistant === 'string')))
      throw new Error(`Invalid conversation for ${item.id}`);
    if (item.handoff !== undefined && (!isRecord(item.handoff) || typeof item.handoff.summary !== 'string' ||
      !['files', 'checks', 'risks'].every(key => Array.isArray((item.handoff as Record<string, unknown>)[key]) &&
        ((item.handoff as Record<string, unknown>)[key] as unknown[]).every(value => typeof value === 'string'))))
      throw new Error(`Invalid handoff for ${item.id}`);
    ids.add(item.id);
  }
  return value as RoutingSuite;
}

function args(argv: string[]) {
  if (argv.includes('--help') || !argv.length) {
    console.log('Usage: npm run benchmark:routing -- --suite benchmark/routing-suite.json [--repeat 3] [--case id] [--shape-only] [--out directory]');
    process.exit(argv.includes('--help') ? 0 : 2);
  }
  const get = (key: string) => {
    const index = argv.indexOf(key);
    return index < 0 ? undefined : argv[index + 1];
  };
  const repeat = Number(get('--repeat') ?? '3');
  if (!get('--suite') || !Number.isInteger(repeat) || repeat < 1 || repeat > 20)
    throw new Error('Provide --suite and --repeat between 1 and 20');
  return { suite: resolve(get('--suite')!), repeat, selectedCase: get('--case'), shapeOnly: argv.includes('--shape-only'),
    out: resolve(get('--out') ?? join('benchmark', 'results', `routing-${new Date().toISOString().replace(/[:.]/g, '-')}`)) };
}

function turnsFor(item: RoutingCase): TurnSummary[] {
  return (item.conversation ?? []).map((turn, index) => ({ prompt: turn.user, result: turn.assistant, at: new Date(index * 1000).toISOString() }));
}

export function summarizeRouting(runs: RoutingRun[]) {
  const completed = runs.filter(run => !!run.shape && !run.error);
  const counts = (items: string[]) => Object.fromEntries([...new Set(items)].sort().map(item => [item, items.filter(value => value === item).length]));
  const categories = [...new Set(runs.map(run => run.category))].sort().map(category => {
    const group = runs.filter(run => run.category === category);
    return { category, total: group.length, completed: group.filter(run => !!run.shape && !run.error).length,
      acceptable: group.filter(run => !run.error && run.acceptableHit).length, preferred: group.filter(run => !run.error && run.preferredHit).length,
      selected: counts(group.map(run => run.shape).filter((shape): shape is string => !!shape)) };
  });
  const byCase = [...new Set(runs.map(run => run.id))].sort().map(id => {
    const group = runs.filter(run => run.id === id);
    return { id, selected: counts(group.map(run => run.shape).filter((shape): shape is string => !!shape)),
      acceptable: group.filter(run => !run.error && run.acceptableHit).length, preferred: group.filter(run => !run.error && run.preferredHit).length,
      failures: group.filter(run => !!run.error).length };
  });
  return { total: runs.length, completed: completed.length, errors: runs.length - completed.length,
    acceptable: completed.filter(run => run.acceptableHit).length,
    preferred: completed.filter(run => run.preferredHit).length,
    selectedShapes: counts(completed.map(run => run.shape!)), categories, byCase,
    vexCalls: runs.reduce((sum, run) => sum + run.vexCalls, 0),
    retries: runs.reduce((sum, run) => sum + run.retries, 0),
    elapsedMs: runs.reduce((sum, run) => sum + run.elapsedMs, 0) };
}

async function main() {
  const options = args(process.argv.slice(2));
  const suiteText = await readFile(options.suite, 'utf8');
  const suite = parseRoutingSuite(JSON.parse(suiteText));
  const cases = suite.cases.filter(item => !options.selectedCase || item.id === options.selectedCase);
  if (!cases.length) throw new Error('No matching routing cases');
  const config = await new PaceStore().loadConfig();
  const models = pricedModels(config.models.filter(model => model.enabled !== false));
  if (!models.length || models.reduce((sum, model) => sum + model.efforts.length, 0) > 12)
    throw new Error('Routing benchmark needs 1 to 12 enabled model and effort pairs');
  if (await stat(options.out).then(() => true).catch(() => false)) throw new Error(`Output directory already exists: ${options.out}`);
  await mkdir(options.out, { recursive: true });
  const statsPath = join(options.out, 'vex-stats.json');
  const previousStatsPath = process.env.VEX_STATS_PATH;
  process.env.VEX_STATS_PATH = statsPath;
  const vex = new VexRouter();
  const runs: RoutingRun[] = [];
  try {
    await vex.verify();
    const routerSources = await Promise.all(['src/integrations/vex.ts', 'src/core/router.ts'].map(path => readFile(resolve(path))));
    await writeFile(join(options.out, 'manifest.json'), JSON.stringify({ suiteSha256: createHash('sha256').update(suiteText).digest('hex'),
      routerSourceSha256: createHash('sha256').update(Buffer.concat(routerSources)).digest('hex'),
      suite: options.suite, cases: cases.length, repeats: options.repeat, shapeOnly: options.shapeOnly,
      models, simulatedHandoffForSplitStages: !options.shapeOnly, priceSnapshot: PRICE_SNAPSHOT,
      startedAt: new Date().toISOString() }, null, 2) + '\n');
    const decide = async (request: VexRequest, objective: string, run: RoutingRun): Promise<RoutingDecision> => {
      let failure: unknown;
      const started = performance.now();
      for (let attempt = 1; attempt <= 2; attempt++) {
        run.vexCalls++;
        if (attempt > 1) run.retries++;
        try {
          const decision = validateDecision(await vex.choose(request), request.options);
          run.decisions.push({ objective, choice: decision.choice, confidence: decision.confidence,
            probabilities: decision.probabilities, attempts: attempt, elapsedMs: Math.round(performance.now() - started) });
          return decision;
        } catch (error) { failure = error; }
      }
      throw new Error(`Vex routing failed after 2 attempts: ${String(failure)}`);
    };
    // Alternate order so a time trend does not always favor one category.
    for (let repetition = 1; repetition <= options.repeat; repetition++) {
      const ordered = repetition % 2 ? cases : [...cases].reverse();
      for (const item of ordered) {
        const started = performance.now();
        const run: RoutingRun = { id: item.id, category: item.category, repetition,
          promptSha256: createHash('sha256').update(item.prompt).digest('hex'), preferred: item.preferred,
          acceptable: item.acceptable, decisions: [], vexCalls: 0, retries: 0, elapsedMs: 0 };
        try {
          const turns = turnsFor(item);
          const shape = (await decide(shapeRequest(item.prompt, turns, models), 'workflow', run)).choice;
          run.shape = shape;
          run.acceptableHit = item.acceptable.includes(shape);
          run.preferredHit = item.preferred === shape;
          if (!options.shapeOnly && shape !== 'clarify') {
            let handoff: string | undefined;
            if (shape !== 'single') {
              const sideModels: ModelOption[] = shape === 'scout' ? models.filter(model => model.model === 'gpt-6-luna') : models;
              const objective = shape === 'scout' ? 'Read-only repository scout' : 'Read-only implementation plan';
              const sideRequest = stageRequest(item.prompt, turns, sideModels, objective, undefined, models);
              const side = run.decisions.length;
              const sideDecision = await decide(sideRequest, objective, run);
              run.decisions[side].route = chosenRoute(sideDecision.choice, sideModels);
              handoff = JSON.stringify(item.handoff ?? { summary: 'Fixture handoff: relevant files and checks identified; no files changed.', files: [], checks: [], risks: [] });
            }
            const objective = shape === 'single' ? 'Complete the original user request' : 'Complete the original user request using the prior structured handoff';
            const completionRequest = stageRequest(item.prompt, turns, models, objective, handoff);
            const completion = run.decisions.length;
            const completionDecision = await decide(completionRequest, objective, run);
            run.decisions[completion].route = chosenRoute(completionDecision.choice, models);
          }
        } catch (error) { run.error = String(error); }
        run.elapsedMs = Math.round(performance.now() - started);
        runs.push(run);
        await appendFile(join(options.out, 'runs.jsonl'), JSON.stringify(run) + '\n');
        await writeFile(join(options.out, 'summary.json'), JSON.stringify(summarizeRouting(runs), null, 2) + '\n');
        console.log(`${item.id} ${repetition}/${options.repeat}: ${run.error ?? run.shape} (${run.elapsedMs} ms)`);
      }
    }
    const summary = summarizeRouting(runs);
    console.log(`${summary.acceptable}/${summary.completed} acceptable, ${summary.preferred}/${summary.completed} preferred; ${summary.errors} errors; ${summary.vexCalls} Vex calls`);
    console.log(`Results: ${options.out}`);
  } finally {
    await vex.close().catch(() => {});
    if (runs.length) {
      const vexStats = await readFile(statsPath, 'utf8').then(text => JSON.parse(text) as unknown).catch(() => undefined);
      await writeFile(join(options.out, 'summary.json'), JSON.stringify({ ...summarizeRouting(runs), vex: vexStats }, null, 2) + '\n');
    }
    if (previousStatsPath === undefined) delete process.env.VEX_STATS_PATH;
    else process.env.VEX_STATS_PATH = previousStatsPath;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)))
  main().catch(error => { console.error(error); process.exitCode = 1; });
