import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { PaceStore } from "../../src/core/sessions.js";
import { PRICE_SNAPSHOT } from "../../src/core/routing/pricing.js";
import { loadRoutingPrompts } from "../../src/core/routing/routing-prompts.js";
import { vexServerPath } from "../../src/core/vex/client.js";
import { args, parseSuite } from "./suite.js";
import { runArm, git } from "./execute.js";
import { total, summarize } from "./summary.js";
import type { Arm, Run } from "../types.js";

async function main() {
  const options = args();
  const suiteText = await readFile(options.suite, "utf8");
  const suite = parseSuite(JSON.parse(suiteText));
  const repository = resolve(suite.repository);
  const cases = suite.cases.filter(
    (task) => !options.selectedCase || task.id === options.selectedCase,
  );
  if (!cases.length) throw new Error("No matching cases");
  if (options.list) {
    for (const task of cases)
      console.log(`${task.id}\t${task.ref ?? suite.ref ?? "HEAD"}\t${task.rubric ?? "No rubric"}`);
    return;
  }
  if (!vexServerPath()) throw new Error("Vex MCP server is unavailable");
  const config = await new PaceStore().loadConfig();
  const routingPrompts = loadRoutingPrompts();
  config.routingMode = "auto";
  config.trustedFolders = [];
  config.skillFolder = undefined;
  if (await stat(options.out).then(() => true).catch(() => false))
    throw new Error(`Output directory already exists: ${options.out}`);
  await mkdir(options.out, { recursive: true });
  const runs: Run[] = [];
  const commits = new Map<string, string>();
  for (const task of cases) {
    const ref = task.ref ?? suite.ref ?? "HEAD";
    if (!commits.has(ref))
      commits.set(ref, await git(repository, `show -s --format=%H ${ref}`));
  }
  const sourcePaths = [
    "benchmark/runner/workflows.ts", "benchmark/runner/execute.ts", "benchmark/runner/summary.ts",
    "src/core/orchestrator.ts",
    "src/core/orchestrator-artifacts.ts", "src/core/orchestrator-clarification.ts", "src/core/orchestrator-prompts.ts", "src/core/orchestrator-routing.ts", "src/core/orchestrator-skills.ts", "src/core/vex/client.ts", "src/integrations/codex.ts",
  ];
  const sourceContents = await Promise.all(sourcePaths.map(path => readFile(resolve(path))));
  await writeFile(
    join(options.out, "manifest.json"),
    JSON.stringify(
      {
        suite,
        suiteSha256: createHash("sha256").update(suiteText).digest("hex"),
        runnerSourceSha256: createHash("sha256").update(Buffer.concat(sourceContents)).digest("hex"),
        routingPromptsSha256: createHash("sha256").update(JSON.stringify(routingPrompts)).digest("hex"),
        repository,
        config,
        commits: Object.fromEntries(commits),
        repeats: options.repeat,
        timeoutMinutes: options.timeoutMinutes,
        includeAuto: options.includeAuto,
        includeLuna: options.includeLuna,
        priceSnapshot: PRICE_SNAPSHOT,
        routingPrompts,
      },
      null,
      2,
    ) + "\n",
  );
  for (const task of cases)
    for (let repetition = 1; repetition <= options.repeat; repetition++) {
      for (const arm of (repetition % 2
        ? ["baseline", ...(options.includeLuna ? ['luna_low'] : []), "routed_single", "routed_split", ...(options.includeAuto ? ["routed_auto"] : [])]
        : [...(options.includeAuto ? ["routed_auto"] : []), "routed_split", "routed_single", ...(options.includeLuna ? ['luna_low'] : []), "baseline"]) as Arm[]) {
        console.log(`${task.id} ${repetition}/${options.repeat} ${arm}`);
        const run = await runArm(
          task,
          repetition,
          arm,
          repository,
          commits.get(task.ref ?? suite.ref ?? "HEAD")!,
          options.out,
          config,
          options.timeoutMinutes,
          routingPrompts,
        );
        runs.push(run);
        console.log(
          run.error ??
            `${total(run.usage) ?? "missing"} Codex tokens, $${run.estimatedCostUsd?.toFixed(4) ?? 'unknown'} estimated, ${run.durationMs} ms`,
        );
        await writeFile(
          join(options.out, "summary.json"),
          JSON.stringify(summarize(runs), null, 2) + "\n",
        );
      }
    }
  const summary = summarize(runs);
  console.log(
    `${summary.matched.length} matched triples; ${summary.incompletePairs} incomplete; ${summary.autoMatched.length} matched auto pairs; ${summary.lunaMatched.length} matched Luna pairs. Review quality before selecting guidance.`,
  );
  console.log(`Results: ${options.out}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
