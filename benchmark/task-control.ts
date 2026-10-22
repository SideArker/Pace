import { baselineBuildPaths, benchmarkProvenance } from "../src/entrypoints/benchmark-provenance.js";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile, appendFile, mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { Orchestrator } from "../src/core/orchestrator.js";
import { PaceStore, newSession } from "../src/core/sessions.js";
import { AppServerRunner } from "../src/integrations/app-server-runner.js";
import { CodexRunError, type CodexRunner } from "../src/integrations/codex-types.js";
import { VexRouter } from "../src/core/vex/client.js";
import { costForUsage, PRICE_SNAPSHOT } from "../src/core/routing/pricing.js";
import { DEFAULT_ROUTING_PROMPTS } from "../src/core/routing/routing-prompts.js";
import type { ActiveTask, Config, Session } from "../src/shared/types.js";
const command = promisify(execFile);
type Case = { id: string; split: "development" | "holdout"; language: string; goal: string; previous: string; prompt: string; shape: "single" | "scout_plan"; lead: "low" | "medium"; checks: "analysis" | "csv" | "queue" | "example" | "plan" | "aside"; expectedActions: string[] };
const argument = (name: string) => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const out = resolve(argument("--out") ?? `benchmark/results/task-control-${Date.now()}`);
const baselineDir = argument("--baseline-dir");
const suitePath = resolve(argument("--suite") ?? "benchmark/suites/task-control.json");
const suiteText = await readFile(suitePath, "utf8");
const suite = JSON.parse(suiteText) as { version: 1; cases: Case[] };
const config: Config = { routingMode: "auto", defaultRoute: { model: "gpt-6.1-sol", effort: "medium" }, models: [{ model: "gpt-6-luna", efforts: ["low"] }, { model: "gpt-6.1-sol", efforts: ["medium", "high"] }], skillFolder: null };
await mkdir(out, { recursive: false });
const baseline = baselineDir ? await import(pathToFileURL(join(resolve(baselineDir), "dist/core/orchestrator.js")).href) as { Orchestrator: typeof Orchestrator } : undefined;
const oldPrompts = baselineDir ? JSON.parse(await readFile(join(resolve(baselineDir), "routing-prompts.default.json"), "utf8")) as unknown : undefined;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const fixture: Record<string, string> = {
  "package.json": JSON.stringify({ type: "module", scripts: { test: "node tests.mjs" } }),
  "src/csv.js": "export function csvRow(values) { return values.join(',') + '\\n'; }\n",
  "src/queue.js": "export function enqueue(queue, operation) { queue.push(operation.text); }\n",
  "src/report.js": "export function summary(attempts) { return { totalCost: attempts.reduce((sum, item) => sum + (item.cost ?? 0), 0), complete: attempts.every(item => item.completed) }; }\n",
  "tests.mjs": "import assert from 'node:assert/strict'; import {csvRow} from './src/csv.js'; assert.equal(csvRow(['a','b']), 'a,b\\n'); console.log('basic fixture tests passed');\n",
};
const codeSha = hash(JSON.stringify(fixture));
const candidateProvenance = await benchmarkProvenance();
const baselineProvenance = baselineDir ? await benchmarkProvenance(resolve(baselineDir), baselineBuildPaths) : undefined;
await writeFile(join(out, "manifest.json"), JSON.stringify({ version: 1, suitePath, suiteSha256: hash(suiteText), fixtureSha256: codeSha, baselineCommit: baselineProvenance?.commit, baselineProvenance, baselineScope: "Baseline controller and shipped prompts; candidate store, runner and Vex client are shared", candidateCommit: candidateProvenance.commit, ...candidateProvenance, config, priceSnapshot: PRICE_SNAPSHOT, syntheticPriorHistory: true, fullHistoricalTaskCost: "unknown: seeded prior exchanges have no paid setup usage", measuredCostScope: "All actual model attempts from the evaluated request through its result, including errors; Vex separate", reviewLimit: "Scripted checks plus unblinded human/agent review; no general quality or savings claim", startedAt: new Date().toISOString() }, null, 2));
const results: Record<string, unknown>[] = [];
for (const [index, item] of suite.cases.entries()) {
  if (argument("--case") && argument("--case") !== item.id) continue;
  const arms = baseline ? (index % 2 ? ["candidate", "baseline"] : ["baseline", "candidate"]) : ["candidate"];
  for (const arm of arms) {
    const dir = join(out, item.id, arm); await mkdir(dir, { recursive: true });
    const root = await mkdtemp(join(tmpdir(), "pace-control-live-")); const workspace = join(root, "workspace");
    await mkdir(join(workspace, "src"), { recursive: true });
    for (const [path, text] of Object.entries(fixture)) await writeFile(join(workspace, path), text);
    await command("git", ["init", "-q"], { cwd: workspace });
    await command("git", ["add", "."], { cwd: workspace });
    await command("git", ["-c", "user.name=Pace Benchmark", "-c", "user.email=benchmark@localhost", "commit", "-qm", "Frozen fixture"], { cwd: workspace });
    const store = new PaceStore(join(dir, "store")); await mkdir(store.baseDir, { recursive: true });
    await writeFile(join(store.baseDir, "routing-prompts.json"), JSON.stringify(arm === "baseline" ? oldPrompts : DEFAULT_ROUTING_PROMPTS));
    const session = newSession(workspace, "auto", item.checks === "plan" ? "planning" : "normal");
    const route = item.lead === "low" ? { model: "gpt-6-luna", effort: "low" as const } : { model: "gpt-6.1-sol", effort: "medium" as const };
    session.route = route;
    const task: ActiveTask = { id: "seed-task", originalRequest: item.goal, instructions: [], latestOutcome: item.previous, assessment: "partial", workflow: { version: 1, generation: 1, shape: item.shape, stage: item.checks === "plan" ? "plan" : "final", mainRoute: route, source: "vex" } };
    if (item.shape === "scout_plan") task.workflow!.scoutHandoff = JSON.stringify({ summary: "Located all three fixture modules; implementation is not done", findings: [], checks: ["npm test"], risks: [], nextSteps: ["Draft complete plan"] });
    session.activeTask = task;
    session.turns = [{ prompt: item.goal, result: item.previous, at: "2026-10-20T00:00:00Z", route }];
    if (item.checks === "plan") session.plan = "# Fixture plan\nInspect src/csv.js, src/queue.js and src/report.js. Implement later after /execute.\n";
    const before = structuredClone({ task: session.activeTask, route: session.route, thread: session.threadId, tasks: session.tasks, checkpoint: session.checkpoint });
    const stats = join(dir, "vex-stats.json"); process.env.VEX_STATS_PATH = stats;
    const vex = new VexRouter(); const transport = new AppServerRunner();
    const attempts: Record<string, unknown>[] = [];
    const runner: CodexRunner = { run: async (...args) => {
      const started = performance.now();
      try {
        const result = await transport.run(...args);
        attempts.push({ route: result.route ?? args[2], mode: args[6] ?? "main", durationMs: Math.round(performance.now() - started), usage: result.usage, knownUsage: result.knownUsage, usageComplete: result.usageComplete, cost: costForUsage(result.route ?? args[2], result.usage), knownCost: costForUsage(result.route ?? args[2], result.knownUsage), threadId: result.threadId, turnId: result.turnId });
        await writeFile(join(dir, "attempts.json"), JSON.stringify(attempts, null, 2)); return result;
      } catch (error) {
        const failure = error instanceof CodexRunError ? error : undefined;
        attempts.push({ route: failure?.accounting?.route ?? args[2], mode: args[6] ?? "main", durationMs: Math.round(performance.now() - started), error: String(error), usage: failure?.usage, knownUsage: failure?.accounting?.knownUsage, usageComplete: failure?.accounting?.usageComplete, cost: costForUsage(args[2], failure?.usage), knownCost: costForUsage(args[2], failure?.accounting?.knownUsage) });
        await writeFile(join(dir, "attempts.json"), JSON.stringify(attempts, null, 2)); throw error;
      }
    } };
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 180000);
    const started = performance.now(); let result = "", error: string | undefined;
    try {
      const Controller = arm === "baseline" ? baseline!.Orchestrator : Orchestrator;
      const outcome = await new Controller(store, runner, vex).turn(item.prompt, session, config, event => {
        if (event.kind === "approval") event.respond("decline");
        if (event.kind === "question") event.respond({});
        // Serialized event payloads omit callbacks and remain local artifacts.
        void appendFile(join(dir, "events.jsonl"), JSON.stringify(event) + "\n");
      }, controller.signal);
      result = outcome.result;
    } catch (cause) { error = String(cause); }
    finally { clearTimeout(timer); await vex.close(); }
    let checksPassed = !error; let checkOutput = "";
    try {
      if (item.checks === "csv") {
        const check = `import assert from 'node:assert/strict'; import {csvRow} from ${JSON.stringify(pathToFileURL(join(workspace, "src/csv.js")).href)}; assert.equal(csvRow(['a,b','x"y','a\\nb',null]), '"a,b","x""y","a\\nb",\\n'); assert.equal(csvRow(['a','b']), 'a,b\\n');`;
        await command(process.execPath, ["--input-type=module", "-e", check]);
      } else if (item.checks === "queue") {
        const check = `import assert from 'node:assert/strict'; import {enqueue} from ${JSON.stringify(pathToFileURL(join(workspace, "src/queue.js")).href)}; const queue=[]; const value={id:'op',text:'/verify',intent:'verify_plan',sessionId:'s',taskId:'t',role:'verifier',sourceSideId:'side'}; enqueue(queue,value); assert.deepEqual(JSON.parse(JSON.stringify(queue[0])),value);`;
        await command(process.execPath, ["--input-type=module", "-e", check]);
      } else if (item.checks === "analysis") {
        for (const path of ["csv.js", "queue.js", "report.js"]) if (!result.includes(path)) throw new Error(`Answer omitted ${path}`);
      } else if (item.checks === "plan") {
        if (!session.plan?.includes("CSV") && !session.plan?.includes("csv")) throw new Error("Saved plan omitted CSV requirements");
        if (arm === "candidate" && attempts.some(attempt => attempt.mode === "side")) throw new Error("Repeated completed scout");
      } else if (!result.trim()) throw new Error("No answer");
      if (!["csv", "queue"].includes(item.checks)) {
        const diff = (await command("git", ["diff", "--", "src"], { cwd: workspace })).stdout;
        if (diff) throw new Error("Read-only request modified source files");
      }
      if (item.checks === "aside" && arm === "candidate") {
        if (JSON.stringify({ task: session.activeTask, route: session.route, thread: session.threadId, tasks: session.tasks, checkpoint: session.checkpoint }) !== JSON.stringify(before)) throw new Error("Aside took over main ownership");
      }
      checkOutput = "External assertions passed";
    } catch (cause) { checksPassed = false; checkOutput = String(cause); }
    await writeFile(join(dir, "answer.md"), result || error || "No answer");
    await writeFile(join(dir, "diff.patch"), (await command("git", ["diff", "--", "."], { cwd: workspace })).stdout);
    await writeFile(join(dir, "session.json"), JSON.stringify(session, null, 2));
    const control = session.controlDecisions?.find(item => item.objective === "task control")?.choice;
    const record = { id: item.id, arm, split: item.split, language: item.language, workspace, promptSha256: hash(item.prompt), fixtureSha256: codeSha, expectedActions: item.expectedActions, action: control, actionPass: control ? item.expectedActions.includes(control) : undefined, checksPassed, checkOutput, error, attempts, durationMs: Math.round(performance.now() - started), knownSubtotal: attempts.reduce((sum, attempt) => sum + Number(attempt.knownCost ?? attempt.cost ?? 0), 0), evaluatedCostComplete: attempts.length > 0 && attempts.every(attempt => attempt.usageComplete && attempt.cost !== undefined), fullHistoricalTaskCost: "unknown", review: "pending manual outcome review" };
    results.push(record); await writeFile(join(dir, "run.json"), JSON.stringify(record, null, 2));
    await writeFile(join(out, "summary.json"), JSON.stringify(results, null, 2));
    console.log(`${item.id} ${arm}: ${error ?? checkOutput}; ${control ?? "legacy control"}; ${record.durationMs} ms`);
  }
}
console.log(`Results: ${out}`);
