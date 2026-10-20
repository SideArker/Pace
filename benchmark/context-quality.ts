import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Usage } from "@openai/codex-sdk";
import { AppServerRunner } from "../src/integrations/codex.js";
import { CodexRunError } from "../src/integrations/codex-types.js";
import { checkpointHandoff, checkpointPrompt, parseCheckpoint } from "../src/core/checkpoint.js";
import { costForUsage, PRICE_SNAPSHOT } from "../src/core/routing/pricing.js";
import type { Route } from "../src/shared/types.js";

const exec = promisify(execFile);
type Arm = "resume" | "fresh_replay" | "compact_resume" | "fresh_checkpoint";
const arms: Arm[] = ["resume", "fresh_replay", "compact_resume", "fresh_checkpoint"];
type Case = {
  id: string;
  files?: Record<string, string>;
  repository?: string;
  ref?: string;
  setup: string[];
  followups: string[];
  check?: string;
  checks?: string[][];
  rubric: string;
};
type Stage = { kind: string; prompt: string; answer?: string; usage?: Usage; estimatedCostUsd?: number; durationMs: number; error?: string; threadId?: string; requestedThreadId?: string; approvalsDeclined?: number; lastProgress?: string };
type Run = {
  id: string; repeat: number; arm: Arm; route: Route; fixture: string; sourceCommit?: string;
  setupStatus?: string; setupStateMatched?: boolean; switchThreadValidated?: boolean;
  stages: Stage[]; check?: { passed: boolean; output: string }; checks?: { command: string[]; passed: boolean; output: string }[];
  diff?: string; error?: string; totalEstimatedCostUsd?: number;
  totalDurationMs: number; rubric: string;
};

function options() {
  const values = new Map<string, string>();
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i];
    const value = process.argv[i + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--")) throw new Error(`Invalid option ${key}`);
    values.set(key, value);
  }
  const repeat = Number(values.get("--repeat") ?? "1");
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 10) throw new Error("--repeat must be 1 to 10");
  const turnTimeoutMinutes = Number(values.get("--turn-timeout-minutes") ?? "5");
  if (!Number.isInteger(turnTimeoutMinutes) || turnTimeoutMinutes < 1 || turnTimeoutMinutes > 20)
    throw new Error("--turn-timeout-minutes must be 1 to 20");
  const route: Route = { model: values.get("--model") ?? "gpt-6-sol", effort: (values.get("--effort") ?? "medium") as Route["effort"] };
  const arm = values.get("--arm");
  if (arm && !arms.includes(arm as Arm)) throw new Error(`Unknown arm ${arm}`);
  const selectedArms = values.get("--arms")?.split(",") as Arm[] | undefined;
  if (selectedArms && (!selectedArms.length || selectedArms.some(value => !arms.includes(value)))) throw new Error("--arms contains an unknown arm");
  return {
    suite: resolve(values.get("--suite") ?? "benchmark/suites/context-quality.json"),
    out: resolve(values.get("--out") ?? `benchmark/results/context-quality-${new Date().toISOString().replace(/[:.]/g, "-")}`),
    selected: values.get("--case"), repeat, route, selectedArms: selectedArms ?? (arm ? [arm as Arm] : arms), turnTimeoutMinutes,
  };
}

async function command(file: string, args: string[], cwd: string) {
  try {
    const result = await exec(file, args, { cwd, windowsHide: true, timeout: 120_000, maxBuffer: 2_000_000 });
    return { passed: true, output: `${result.stdout}${result.stderr}`.slice(-10_000) };
  } catch (error) {
    const value = error as Error & { stdout?: string; stderr?: string };
    return { passed: false, output: `${value.stdout ?? ""}${value.stderr ?? ""}${value.message}`.slice(-10_000) };
  }
}

async function fixture(task: Case): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pace-context-quality-"));
  if (task.repository) {
    const source = resolve(task.repository);
    const cloned = await command("git", ["clone", "--quiet", "--no-hardlinks", source, root], process.cwd());
    if (!cloned.passed) throw new Error(`Repository clone failed: ${cloned.output}`);
    const checked = await command("git", ["checkout", "--quiet", task.ref ?? "HEAD"], root);
    if (!checked.passed) throw new Error(`Repository checkout failed: ${checked.output}`);
    if (source === process.cwd()) {
      await symlink(resolve("node_modules"), join(root, "node_modules"), "dir");
      await appendFile(join(root, ".git", "info", "exclude"), "\nnode_modules\n");
    }
    return root;
  }
  for (const [name, content] of Object.entries(task.files ?? {})) {
    if (name.startsWith("/") || name.startsWith("\\") || name.split(/[\\/]/).includes("..")) throw new Error(`Unsafe fixture path ${name}`);
    const path = join(root, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
  }
  for (const args of [["init", "--quiet"], ["add", "."], ["-c", "user.name=Pace Benchmark", "-c", "user.email=pace@example.invalid", "commit", "--quiet", "-m", "fixture"]]) {
    const result = await command("git", args, root);
    if (!result.passed) throw new Error(`Fixture Git setup failed: ${result.output}`);
  }
  return root;
}

async function removeFixture(root: string) {
  const target = await realpath(root);
  const temp = await realpath(tmpdir());
  if (!target.startsWith(temp + sep) || !target.split(sep).at(-1)?.startsWith("pace-context-quality-"))
    throw new Error(`Refusing to remove unexpected fixture ${target}`);
  for (let attempt = 0; attempt < 5; attempt++) {
    try { await rm(target, { recursive: true, force: true }); return; }
    catch (error) {
      if (attempt === 4) throw error;
      await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
}

async function runArm(task: Case, repetition: number, arm: Arm, route: Route, out: string, turnTimeoutMinutes: number): Promise<Run> {
  const root = await fixture(task);
  const run: Run = { id: task.id, repeat: repetition, arm, route, fixture: root, stages: [], totalDurationMs: 0, rubric: task.rubric };
  const runDir = join(out, task.id, String(repetition), arm);
  await mkdir(runDir, { recursive: true });
  const runner = new AppServerRunner();
  let threadId: string | undefined;
  const history: { user: string; assistant: string }[] = [];
  const runTurn = async (kind: string, prompt: string, resume: boolean) => {
    const started = performance.now();
    const stage: Stage = { kind, prompt, durationMs: 0, approvalsDeclined: 0, requestedThreadId: resume ? threadId : undefined };
    run.stages.push(stage);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), turnTimeoutMinutes * 60_000);
    try {
      const result = await runner.run(prompt, root, route, resume ? threadId : undefined, progress => {
        stage.lastProgress = progress.kind === "activity" ? progress.title : progress.kind === "status" ? progress.text : progress.kind;
        if (progress.kind === "approval") { stage.approvalsDeclined = (stage.approvalsDeclined ?? 0) + 1; progress.respond("decline"); }
      }, controller.signal, "main");
      if (!result.threadId || !result.completed) throw new Error("Codex did not complete a thread turn");
      threadId = result.threadId;
      stage.threadId = result.threadId;
      stage.answer = result.result;
      stage.usage = result.usage;
      stage.estimatedCostUsd = costForUsage(route, result.usage);
      return result.result;
    } catch (error) {
      if (error instanceof CodexRunError) {
        stage.usage = error.usage;
        stage.estimatedCostUsd = costForUsage(route, error.usage);
      }
      stage.error = String(error);
      throw error;
    } finally {
      clearTimeout(timer);
      stage.durationMs = Math.round(performance.now() - started);
      console.log(`  ${arm} ${kind}: ${stage.durationMs} ms${stage.error ? ` (${stage.error})` : ""}`);
    }
  };
  try {
    if (task.repository) {
      const commit = await command("git", ["rev-parse", "HEAD"], root);
      if (!commit.passed) throw new Error(`Could not resolve source commit: ${commit.output}`);
      run.sourceCommit = commit.output.trim();
    }
    for (const prompt of task.setup) history.push({ user: prompt, assistant: await runTurn("setup", prompt, !!threadId) });
    const beforeSwitchThreadId = threadId;
    const setupStatus = await command("git", ["status", "--porcelain", "--untracked-files=all"], root);
    if (!setupStatus.passed) throw new Error(`Could not read setup status: ${setupStatus.output}`);
    run.setupStatus = setupStatus.output;
    run.setupStateMatched = setupStatus.output === "";
    if (!run.setupStateMatched) throw new Error(`Setup changed repository state: ${setupStatus.output}`);
    let firstPrompt = task.followups[0]!;
    if (arm === "compact_resume") {
      const compact = await runner.compact(threadId!, root, route, () => {});
      run.stages.push({ kind: "compact", prompt: "/compact", usage: compact.usage,
        estimatedCostUsd: costForUsage(route, compact.usage), durationMs: compact.durationMs, error: compact.error });
      if (compact.outcome !== "completed") throw new Error(`Compaction ${compact.outcome}: ${compact.error}`);
    }
    if (arm === "fresh_checkpoint") {
      let note: ReturnType<typeof parseCheckpoint> | undefined;
      let correction = "";
      for (let attempt = 1; attempt <= 2; attempt++) {
        const answer = await runTurn(attempt === 1 ? "checkpoint" : "checkpoint-retry", checkpointPrompt() + correction, true);
        try { note = parseCheckpoint(answer); break; }
        catch (error) {
          if (attempt === 2) throw error;
          correction = `\n\nThe previous note failed validation: ${String(error)}. Correct the note. Set complete to true when all known relevant facts are captured, even if the implementation is still pending or questions remain. Previous note:\n${answer}`;
        }
      }
      firstPrompt = checkpointHandoff(note!, history, firstPrompt);
      threadId = undefined;
    }
    if (arm === "fresh_replay") {
      firstPrompt = `Continue this conversation using the retained exchanges below.\n\n${JSON.stringify(history)}\n\nCurrent user request:\n${firstPrompt}`;
      threadId = undefined;
    }
    for (let index = 0; index < task.followups.length; index++)
      await runTurn(`followup-${index + 1}`, index === 0 ? firstPrompt : task.followups[index]!, !!threadId);
    const firstFollowup = run.stages.find(stage => stage.kind === "followup-1")!;
    const fresh = arm === "fresh_replay" || arm === "fresh_checkpoint";
    run.switchThreadValidated = fresh
      ? firstFollowup.requestedThreadId === undefined && firstFollowup.threadId !== beforeSwitchThreadId
      : firstFollowup.requestedThreadId === beforeSwitchThreadId && firstFollowup.threadId === beforeSwitchThreadId;
    if (!run.switchThreadValidated) throw new Error(`Unexpected thread transition in ${arm}`);
    if (task.checks) {
      run.checks = [];
      for (const [file, ...args] of task.checks) {
        const check = await command(file!, args, root);
        run.checks.push({ command: [file!, ...args], ...check });
      }
      run.check = { passed: run.checks.every(check => check.passed), output: run.checks.map(check => `${check.command.join(" ")}: ${check.output}`).join("\n") };
    } else if (task.check) run.check = await command(process.execPath, ["--input-type=module", "-e", task.check], root);
    else throw new Error("Case has no checks");
    await command("git", ["add", "-N", "."], root);
    const diff = await command("git", ["diff", "--", "."], root);
    run.diff = diff.output;
    if (!diff.passed) throw new Error(`Could not read diff: ${diff.output}`);
  } catch (error) {
    run.error = String(error);
  } finally {
    run.totalDurationMs = run.stages.reduce((sum, stage) => sum + stage.durationMs, 0);
    run.totalEstimatedCostUsd = run.stages.every(stage => stage.estimatedCostUsd !== undefined)
      ? run.stages.reduce((sum, stage) => sum + stage.estimatedCostUsd!, 0) : undefined;
    await writeFile(join(runDir, "run.json"), JSON.stringify(run, null, 2) + "\n");
    await writeFile(join(runDir, "diff.patch"), run.diff ?? "");
    try { await removeFixture(root); }
    catch (error) { console.warn(`Fixture cleanup failed for ${root}: ${String(error)}`); }
  }
  return run;
}

async function main() {
  const opts = options();
  const suiteText = await readFile(opts.suite, "utf8");
  const suite = JSON.parse(suiteText) as { cases: Case[] };
  if (!Array.isArray(suite.cases) || !suite.cases.length) throw new Error("Suite has no cases");
  const cases = suite.cases.filter(item => !opts.selected || item.id === opts.selected);
  if (!cases.length) throw new Error("No matching case");
  await mkdir(dirname(opts.out), { recursive: true });
  await mkdir(opts.out, { recursive: false });
  const sourceFiles = [fileURLToPath(import.meta.url), resolve("src/integrations/app-server-runner.ts"), resolve("src/core/checkpoint.ts")];
  const source = Buffer.concat(await Promise.all(sourceFiles.map(file => readFile(file))));
  const commit = await command("git", ["rev-parse", "HEAD"], process.cwd());
  await writeFile(join(opts.out, "manifest.json"), JSON.stringify({ suite: opts.suite, route: opts.route,
    suiteSha256: createHash("sha256").update(suiteText).digest("hex"),
    sourceSha256: createHash("sha256").update(source).digest("hex"),
    paceCommit: commit.passed ? commit.output.trim() : undefined,
    repeat: opts.repeat, turnTimeoutMinutes: opts.turnTimeoutMinutes, priceSnapshot: PRICE_SNAPSHOT, runId: randomUUID() }, null, 2) + "\n");
  const runs: Run[] = [];
  for (const task of cases) for (let repetition = 1; repetition <= opts.repeat; repetition++) {
    const order = (repetition % 2 ? arms : [...arms].reverse()).filter(arm => opts.selectedArms.includes(arm));
    for (const arm of order) {
      console.log(`${task.id} ${repetition}/${opts.repeat} ${arm}`);
      const result = await runArm(task, repetition, arm, opts.route, opts.out, opts.turnTimeoutMinutes);
      runs.push(result);
      await writeFile(join(opts.out, "summary.json"), JSON.stringify({
        runs: runs.map(run => ({ id: run.id, repeat: run.repeat, arm: run.arm, checkPassed: run.check?.passed ?? false,
          setupStateMatched: run.setupStateMatched, switchThreadValidated: run.switchThreadValidated,
          error: run.error, totalEstimatedCostUsd: run.totalEstimatedCostUsd, totalDurationMs: run.totalDurationMs })),
        note: "Checks are automatic gates. Review each answer and diff against its rubric before comparing quality or savings.",
      }, null, 2) + "\n");
      if (/hit your usage limit/i.test(result.error ?? "")) {
        console.warn("Codex usage limit reached; remaining arms were not started.");
        console.log(`Results: ${opts.out}`);
        return;
      }
    }
  }
  console.log(`Results: ${opts.out}`);
}

if (process.argv.includes('--study')) {
  const { main } = await import('./context-models.js');
  await main();
} else main().catch(error => { console.error(error); process.exitCode = 1; });
