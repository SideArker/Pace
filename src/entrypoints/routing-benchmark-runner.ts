import { benchmarkProvenance } from "./benchmark-provenance.js";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, appendFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { newSession, PaceStore } from "../core/sessions.js";
import { Orchestrator } from "../core/orchestrator.js";
import { loadRoutingPrompts } from "../core/routing/routing-prompts.js";
import { pricedModels, PRICE_SNAPSHOT } from "../core/routing/pricing.js";
import { validateDecision } from "../core/routing/router.js";
import { VexRouter, type VexRequest } from "../core/vex/client.js";
import type { CodexRunner } from "../integrations/codex-types.js";
import { parseRoutingSuite } from "./routing-suite.js";
import { benchmarkArgs } from "./routing-benchmark-cli.js";
import { summarizeRouting, turnsFor } from "./routing-summary.js";
import type { RoutingRun } from "./routing-types.js";

/** Real production control flow with simulated Codex output. This does not grade task quality. */
export async function main() {
  const options = benchmarkArgs(process.argv.slice(2));
  const suiteText = await readFile(options.suite, "utf8");
  const cases = parseRoutingSuite(JSON.parse(suiteText)).cases.filter(item => !options.selectedCase || item.id === options.selectedCase);
  if (!cases.length) throw new Error("No matching routing cases");
  const config = await new PaceStore().loadConfig();
  const prompts = loadRoutingPrompts();
  const models = pricedModels(config.models.filter(model => model.enabled !== false));
  if (!models.length || models.reduce((sum, model) => sum + model.efforts.length, 0) > 12) throw new Error("Routing benchmark needs 1 to 12 enabled model and effort pairs");
  if (await stat(options.out).then(() => true).catch(() => false)) throw new Error(`Output directory already exists: ${options.out}`);
  await mkdir(options.out, { recursive: true });
  const statsPath = join(options.out, "vex-stats.json");
  const previousStatsPath = process.env.VEX_STATS_PATH;
  process.env.VEX_STATS_PATH = statsPath;
  const vex = new VexRouter();
  const runs: RoutingRun[] = [];
  try {
    await vex.verify();
    const provenance = await benchmarkProvenance();
    await writeFile(join(options.out, "manifest.json"), JSON.stringify({ suiteSha256: createHash("sha256").update(suiteText).digest("hex"), ...provenance, routingPromptsSha256: createHash("sha256").update(JSON.stringify(prompts)).digest("hex"), routingPrompts: prompts, suite: options.suite, cases: cases.length, repeats: options.repeat, shapeOnly: options.shapeOnly, models, simulatedCodexResults: true, productionController: "Orchestrator.turn", priceSnapshot: PRICE_SNAPSHOT, startedAt: new Date().toISOString() }, null, 2) + "\n");
    for (let repetition = 1; repetition <= options.repeat; repetition++) {
      for (const item of repetition % 2 ? cases : [...cases].reverse()) {
        const started = performance.now();
        const run: RoutingRun = { id: item.id, category: item.category, repetition, promptSha256: createHash("sha256").update(item.prompt).digest("hex"), preferred: item.preferred, acceptable: item.acceptable, decisions: [], vexCalls: 0, retries: 0, elapsedMs: 0 };
        const caseDir = join(options.out, "cases", item.id, String(repetition));
        const store = new PaceStore(join(caseDir, "store"));
        const workspace = join(caseDir, "workspace");
        await mkdir(workspace, { recursive: true }); await mkdir(store.baseDir, { recursive: true });
        await writeFile(join(store.baseDir, "routing-prompts.json"), JSON.stringify(prompts));
        const session = newSession(workspace, "auto", item.task?.workflow?.stage === "plan" ? "planning" : "normal");
        session.turns = turnsFor(item); session.activeTask = item.task ? structuredClone(item.task) : undefined;
        session.route = session.activeTask?.workflow?.mainRoute ?? {};
        const originalRoute = { ...session.route };
        let stoppedAtRoute = false;
        let lastFailure = false;
        const observed = { verify: async () => {}, choose: async (request: VexRequest) => {
          const stage = request.context.stageObjective;
          if (options.shapeOnly && typeof stage === "string") { stoppedAtRoute = true; throw new Error("Routing-only probe stopped before route selection"); }
          const objective = typeof stage === "string" ? stage : request.options.some(option => option.id === "closed") ? "task completion assessment" : request.options.some(option => option.id === "reroute") ? "task control" : "workflow";
          const decisionStarted = performance.now(); run.vexCalls++;
          if (lastFailure) run.retries++;
          try {
            const decision = validateDecision(await vex.choose(request), request.options);
            run.decisions.push({ objective, choice: decision.choice, confidence: decision.confidence, probabilities: decision.probabilities, attempts: lastFailure ? 2 : 1, elapsedMs: Math.round(performance.now() - decisionStarted) });
            lastFailure = false; return decision;
          } catch (error) { lastFailure = true; throw error; }
        } };
        const simulated: CodexRunner = { run: async (prompt, _project, route, _thread, _progress, _signal, mode) => {
          if (options.shapeOnly) { stoppedAtRoute = true; throw new Error("Routing-only probe stopped before simulated inference"); }
          if (mode === "planning") {
            const path = prompt.match(/The saved plan path is ([^\n]+?\.pace-plan\.md)/)?.[1];
            if (path) await writeFile(path, "# Simulated routing benchmark plan\nNo repository work executed.\n");
          }
          const scout = mode === "side" && prompt.includes(prompts.handoff.instructions);
          const report = item.handoff ?? { summary: "Fixture report: relevant files and checks identified; no work executed.", findings: [], nextSteps: [], checks: [], risks: [] };
          const decision = run.decisions.at(-1); if (decision && typeof route.model === "string") decision.route = route;
          return { completed: true, result: scout ? JSON.stringify(report) : "Simulated routing-only answer; no task implementation or verification performed." };
        } };
        try {
          const outcome = await new Orchestrator(store, simulated, observed).turn(item.prompt, session, { ...config, models, skillFolder: null }, () => {});
          if (outcome.role === "aside") run.shape = "aside";
        } catch (error) { if (!stoppedAtRoute) run.error = String(error); }
        run.controlAction = run.decisions.find(decision => decision.objective === "task control")?.choice ?? "replace";
        if (item.expectedAction) run.controlHit = run.controlAction === item.expectedAction;
        run.shape ??= run.controlAction === "aside" || run.controlAction === "clarify" ? run.controlAction : session.activeTask?.workflow?.shape ?? run.decisions.find(decision => decision.objective === "workflow")?.choice;
        if (run.controlAction === "continue" && item.task?.workflow?.mainRoute) run.retainedRoute = originalRoute;
        run.acceptableHit = !!run.shape && item.acceptable.includes(run.shape);
        run.preferredHit = item.preferred === run.shape;
        run.elapsedMs = Math.round(performance.now() - started); runs.push(run);
        await appendFile(join(options.out, "runs.jsonl"), JSON.stringify(run) + "\n");
        await writeFile(join(options.out, "summary.json"), JSON.stringify(summarizeRouting(runs), null, 2) + "\n");
        console.log(`${item.id} ${repetition}/${options.repeat}: ${run.error ?? run.shape} (${run.elapsedMs} ms)`);
      }
    }
    const summary = summarizeRouting(runs);
    console.log(`${summary.acceptable}/${summary.completed} acceptable, ${summary.preferred}/${summary.completed} preferred; ${summary.errors} errors; ${summary.vexCalls} Vex calls`);
    console.log(`Results: ${options.out}`);
  } finally {
    await vex.close().catch(() => {});
    const stats = await readFile(statsPath, "utf8").then(text => JSON.parse(text) as unknown).catch(() => undefined);
    if (runs.length) await writeFile(join(options.out, "summary.json"), JSON.stringify({ ...summarizeRouting(runs), vex: stats }, null, 2) + "\n");
    if (previousStatsPath === undefined) delete process.env.VEX_STATS_PATH; else process.env.VEX_STATS_PATH = previousStatsPath;
  }
}
