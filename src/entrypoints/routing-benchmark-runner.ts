import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, appendFile, stat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { PaceStore } from "../core/sessions.js";
import { completionObjective, loadRoutingPrompts } from "../core/routing/routing-prompts.js";
import { pricedModels, PRICE_SNAPSHOT } from "../core/routing/pricing.js";
import {
  chosenRoute,
  validateDecision,
  type RoutingDecision,
} from "../core/routing/router.js";
import {
  shapeRequest,
  stageRequest,
  VexRouter,
  type VexRequest,
} from "../core/vex/client.js";
import type { ModelOption } from "../shared/types.js";
import { parseRoutingSuite } from "./routing-suite.js";
import { benchmarkArgs } from "./routing-benchmark-cli.js";
import { summarizeRouting, turnsFor } from "./routing-summary.js";
import type { RoutingRun } from "./routing-types.js";
export async function main() {
  const options = benchmarkArgs(process.argv.slice(2));
  const suiteText = await readFile(options.suite, "utf8");
  const suite = parseRoutingSuite(JSON.parse(suiteText));
  const cases = suite.cases.filter(
    (item) => !options.selectedCase || item.id === options.selectedCase,
  );
  if (!cases.length) throw new Error("No matching routing cases");
  const config = await new PaceStore().loadConfig();
  const prompts = loadRoutingPrompts();
  const models = pricedModels(
    config.models.filter((model) => model.enabled !== false),
  );
  if (
    !models.length ||
    models.reduce((sum, model) => sum + model.efforts.length, 0) > 12
  )
    throw new Error(
      "Routing benchmark needs 1 to 12 enabled model and effort pairs",
    );
  if (
    await stat(options.out)
      .then(() => true)
      .catch(() => false)
  )
    throw new Error(`Output directory already exists: ${options.out}`);
  await mkdir(options.out, { recursive: true });
  const statsPath = join(options.out, "vex-stats.json");
  const previousStatsPath = process.env.VEX_STATS_PATH;
  process.env.VEX_STATS_PATH = statsPath;
  const vex = new VexRouter();
  const runs: RoutingRun[] = [];
  try {
    await vex.verify();
    const routerSources = await Promise.all(
      ["src/core/vex/client.ts", "src/core/routing/router.ts"].map((path) =>
        readFile(resolve(path)),
      ),
    );
    await writeFile(
      join(options.out, "manifest.json"),
      JSON.stringify(
        {
          suiteSha256: createHash("sha256").update(suiteText).digest("hex"),
          routerSourceSha256: createHash("sha256")
            .update(Buffer.concat(routerSources))
            .digest("hex"),
          routingPromptsSha256: createHash("sha256")
            .update(JSON.stringify(prompts))
            .digest("hex"),
          suite: options.suite,
          cases: cases.length,
          repeats: options.repeat,
          shapeOnly: options.shapeOnly,
          models,
          simulatedHandoffForSplitStages: !options.shapeOnly,
          priceSnapshot: PRICE_SNAPSHOT,
          startedAt: new Date().toISOString(),
        },
        null,
        2,
      ) + "\n",
    );
    const decide = async (
      request: VexRequest,
      objective: string,
      run: RoutingRun,
    ): Promise<RoutingDecision> => {
      let failure: unknown;
      const started = performance.now();
      for (let attempt = 1; attempt <= 2; attempt++) {
        run.vexCalls++;
        if (attempt > 1) run.retries++;
        try {
          const decision = validateDecision(
            await vex.choose(request),
            request.options,
          );
          run.decisions.push({
            objective,
            choice: decision.choice,
            confidence: decision.confidence,
            probabilities: decision.probabilities,
            attempts: attempt,
            elapsedMs: Math.round(performance.now() - started),
          });
          return decision;
        } catch (error) {
          failure = error;
        }
      }
      throw new Error(
        `Vex routing failed after 2 attempts: ${String(failure)}`,
      );
    };
    // Alternate order so a time trend does not always favor one category.
    for (let repetition = 1; repetition <= options.repeat; repetition++) {
      const ordered = repetition % 2 ? cases : [...cases].reverse();
      for (const item of ordered) {
        const started = performance.now();
        const run: RoutingRun = {
          id: item.id,
          category: item.category,
          repetition,
          promptSha256: createHash("sha256").update(item.prompt).digest("hex"),
          preferred: item.preferred,
          acceptable: item.acceptable,
          decisions: [],
          vexCalls: 0,
          retries: 0,
          elapsedMs: 0,
        };
        try {
          const turns = turnsFor(item);
          const shape = (
            await decide(
              shapeRequest(item.prompt, turns, models, prompts),
              "workflow",
              run,
            )
          ).choice;
          run.shape = shape;
          run.acceptableHit = item.acceptable.includes(shape);
          run.preferredHit = item.preferred === shape;
          if (!options.shapeOnly && shape !== "clarify") {
            let handoff: string | undefined;
            if (shape === "scout" || shape === "scout_plan") {
              const sideModels: ModelOption[] =
                models.filter((model) => model.model === "gpt-6-luna");
              const objective = prompts.objectives.scout;
              const sideRequest = stageRequest(
                item.prompt,
                turns,
                sideModels,
                objective,
                undefined,
                models,
                prompts,
              );
              const side = run.decisions.length;
              const sideDecision = await decide(sideRequest, objective, run);
              run.decisions[side].route = chosenRoute(
                sideDecision.choice,
                sideModels,
              );
              handoff = JSON.stringify(
                item.handoff ?? {
                  summary:
                    "Fixture report: relevant files and checks identified; no files changed.",
                  findings: [],
                  nextSteps: [],
                  checks: [],
                  risks: [],
                },
              );
            }
            const objective = completionObjective(shape, prompts);
            const completionRequest = stageRequest(
              item.prompt,
              turns,
              models,
              objective,
              handoff,
              models,
              prompts,
            );
            const completion = run.decisions.length;
            const completionDecision = await decide(
              completionRequest,
              objective,
              run,
            );
            run.decisions[completion].route = chosenRoute(
              completionDecision.choice,
              models,
            );
          }
        } catch (error) {
          run.error = String(error);
        }
        run.elapsedMs = Math.round(performance.now() - started);
        runs.push(run);
        await appendFile(
          join(options.out, "runs.jsonl"),
          JSON.stringify(run) + "\n",
        );
        await writeFile(
          join(options.out, "summary.json"),
          JSON.stringify(summarizeRouting(runs), null, 2) + "\n",
        );
        console.log(
          `${item.id} ${repetition}/${options.repeat}: ${run.error ?? run.shape} (${run.elapsedMs} ms)`,
        );
      }
    }
    const summary = summarizeRouting(runs);
    console.log(
      `${summary.acceptable}/${summary.completed} acceptable, ${summary.preferred}/${summary.completed} preferred; ${summary.errors} errors; ${summary.vexCalls} Vex calls`,
    );
    console.log(`Results: ${options.out}`);
  } finally {
    await vex.close().catch(() => {});
    if (runs.length) {
      const vexStats = await readFile(statsPath, "utf8")
        .then((text) => JSON.parse(text) as unknown)
        .catch(() => undefined);
      await writeFile(
        join(options.out, "summary.json"),
        JSON.stringify({ ...summarizeRouting(runs), vex: vexStats }, null, 2) +
          "\n",
      );
    }
    if (previousStatsPath === undefined) delete process.env.VEX_STATS_PATH;
    else process.env.VEX_STATS_PATH = previousStatsPath;
  }
}
