import { createHash } from "node:crypto";
import { exec as execCallback } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile, appendFile, stat, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { CodexRunner, Progress } from "./integrations/codex.js";
import { SdkRunner, codexOptions } from "./integrations/codex.js";
import { VexRouter, vexServerPath } from "./integrations/vex.js";
import { Orchestrator } from "./core/orchestrator.js";
import { PaceStore, newSession } from "./core/sessions.js";
import type { Config, Route } from "./types.js";
import type { Usage } from "@openai/codex-sdk";

const exec = promisify(execCallback);
type Arm = "baseline" | "pace";
type Case = { id: string; prompt: string; ref?: string; setup?: string[]; checks?: string[]; rubric?: string };
type Suite = { repository: string; ref?: string; cases: Case[] };
type CommandResult = { command: string; exitCode: number; output: string };
type Run = {
  id: string; repetition: number; arm: Arm; commit: string; promptSha256: string;
  route?: Route; routeNote?: string; durationMs: number; usage?: Usage;
  subturns: { mode: string; route: Route; usage?: Usage; error?: string }[];
  vex?: { requests: number; inputTokens: number; outputTokens: number; cost: number };
  mcpCalls: string[]; checks: CommandResult[]; result?: string; error?: string;
  gitStatus: string; diffFile: string;
};

function args() {
  const values = process.argv.slice(2);
  if (values.includes("--help") || !values.length) {
    console.log("Usage: npm run benchmark -- --suite <file.json> [--repeat 3] [--case id] [--out directory]");
    process.exit(values.includes("--help") ? 0 : 2);
  }
  const get = (key: string) => {
    const index = values.indexOf(key);
    return index < 0 ? undefined : values[index + 1];
  };
  const suite = get("--suite");
  const repeat = Number(get("--repeat") ?? "1");
  if (!suite || !Number.isInteger(repeat) || repeat < 1 || repeat > 10)
    throw new Error("Provide --suite and --repeat between 1 and 10");
  return { suite: resolve(suite), repeat, selectedCase: get("--case"), out: resolve(get("--out") ?? join("benchmark", "results", new Date().toISOString().replace(/[:.]/g, "-"))) };
}

function parseSuite(value: unknown): Suite {
  if (!value || typeof value !== "object") throw new Error("Suite must be an object");
  const suite = value as Partial<Suite>;
  if (typeof suite.repository !== "string" || !Array.isArray(suite.cases) || !suite.cases.length)
    throw new Error("Suite needs a repository and cases");
  if (suite.ref !== undefined && typeof suite.ref !== "string") throw new Error("Invalid suite ref");
  const ids = new Set<string>();
  for (const task of suite.cases) {
    if (!task || typeof task.id !== "string" || !/^[a-z0-9_-]+$/.test(task.id) || ids.has(task.id) || typeof task.prompt !== "string" || !task.prompt.trim())
      throw new Error("Each case needs a unique slug id and nonempty prompt");
    if (task.ref !== undefined && typeof task.ref !== "string") throw new Error(`Invalid ref for ${task.id}`);
    for (const key of ["setup", "checks"] as const)
      if (task[key] !== undefined && (!Array.isArray(task[key]) || !task[key].every((command: unknown) => typeof command === "string" && command.trim())))
        throw new Error(`Invalid ${key} for ${task.id}`);
    ids.add(task.id);
  }
  return suite as Suite;
}

async function command(command: string, cwd: string, timeout = 600_000): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await exec(command, { cwd, timeout, maxBuffer: 4_000_000, windowsHide: true });
    return { command, exitCode: 0, output: `${stdout}${stderr}`.slice(-12_000) };
  } catch (error) {
    const failure = error as Error & { code?: number; stdout?: string; stderr?: string };
    return { command, exitCode: typeof failure.code === "number" ? failure.code : 1, output: `${failure.stdout ?? ""}${failure.stderr ?? ""}${failure.message}`.slice(-12_000) };
  }
}

async function git(cwd: string, arguments_: string): Promise<string> {
  const result = await command(`git ${arguments_}`, cwd);
  if (result.exitCode) throw new Error(`${result.command}: ${result.output}`);
  return result.output.trim();
}

function total(usage?: Usage): number | undefined {
  return usage ? usage.input_tokens + usage.output_tokens : undefined;
}

function summarize(runs: Run[]) {
  const pairs = new Map<string, Partial<Record<Arm, Run>>>();
  for (const run of runs) {
    const key = `${run.id}:${run.repetition}`;
    const pair = pairs.get(key) ?? {};
    pair[run.arm] = run;
    pairs.set(key, pair);
  }
  const matched = [...pairs].flatMap(([key, pair]) => {
    const baseline = total(pair.baseline?.usage);
    const pace = total(pair.pace?.usage);
    if (baseline === undefined || pace === undefined || baseline === 0 || pair.baseline?.error || pair.pace?.error ||
      pair.baseline?.subturns.some(turn => turn.error || !turn.usage) || pair.pace?.subturns.some(turn => turn.error || !turn.usage)) return [];
    return [{ key, baselineTokens: baseline, paceTokens: pace, savedTokens: baseline - pace,
      savedPercent: 100 * (baseline - pace) / baseline,
      baselineChecksPassed: pair.baseline!.checks.length ? pair.baseline!.checks.every(check => check.exitCode === 0) : null,
      paceChecksPassed: pair.pace!.checks.length ? pair.pace!.checks.every(check => check.exitCode === 0) : null }];
  });
  const baselineTokens = matched.reduce((sum, pair) => sum + pair.baselineTokens, 0);
  const paceTokens = matched.reduce((sum, pair) => sum + pair.paceTokens, 0);
  return { matched, incompletePairs: pairs.size - matched.length,
    baselineTokens, paceTokens, savedTokens: baselineTokens - paceTokens,
    savedPercent: baselineTokens ? 100 * (baselineTokens - paceTokens) / baselineTokens : null };
}

async function runArm(task: Case, repetition: number, arm: Arm, repository: string, commit: string, out: string, config: Config): Promise<Run> {
  const root = await mkdtemp(join(tmpdir(), "pace-benchmark-"));
  const fixture = join(root, "workspace");
  const codexHome = join(root, "codex-home");
  const runDir = join(out, task.id, String(repetition), arm);
  await mkdir(runDir, { recursive: true });
  await mkdir(codexHome);
  const previousCodexHome = process.env.CODEX_HOME;
  const previousStatsPath = process.env.VEX_STATS_PATH;
  const statsPath = join(runDir, "vex-stats.json");
  const started = performance.now();
  const record: Run = { id: task.id, repetition, arm, commit, promptSha256: createHash("sha256").update(task.prompt).digest("hex"), durationMs: 0, subturns: [], mcpCalls: [], checks: [], gitStatus: "", diffFile: "diff.patch" };
  let vex: VexRouter | undefined;
  try {
    const authPath = join(previousCodexHome || join(homedir(), ".codex"), "auth.json");
    await copyFile(authPath, join(codexHome, "auth.json")).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !process.env.OPENAI_API_KEY) throw error;
    });
    process.env.CODEX_HOME = codexHome;
    process.env.VEX_STATS_PATH = statsPath;
    await git(repository, `clone --quiet --no-hardlinks -- "${repository}" "${fixture}"`);
    await git(fixture, `checkout --quiet --detach ${commit}`);
    if (await stat(join(repository, "node_modules")).then(value => value.isDirectory()).catch(() => false))
      await symlink(join(repository, "node_modules"), join(fixture, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    if (process.platform === "win32") {
      const projectKey = fixture.toLowerCase().replace(/'/g, "''");
      await writeFile(join(codexHome, "config.toml"), `[windows]\nsandbox = "unelevated"\n\n[projects.'${projectKey}']\ntrust_level = "trusted"\n`);
    }
    for (const setup of task.setup ?? []) {
      const result = await command(setup, fixture);
      await appendFile(join(runDir, "setup.jsonl"), JSON.stringify(result) + "\n");
      if (result.exitCode) throw new Error(`Setup failed: ${setup}: ${result.output}`);
    }
    const eventLog = join(runDir, "events.jsonl");
    const onEvent = async (event: unknown) => {
      await appendFile(eventLog, JSON.stringify(event) + "\n");
      const item = (event as { type?: string; item?: { type?: string; server?: string; tool?: string } }).item;
      if ((event as { type?: string }).type === "item.completed" && item?.type === "mcp_tool_call")
        record.mcpCalls.push(`${item.server}/${item.tool}`);
    };
    const runner = new SdkRunner(arm === "pace" ? codexOptions(vexServerPath()) : { configOverrides: ["mcp_servers={}"] }, onEvent);
    const observed: CodexRunner = {
      async run(prompt, project, route, threadId, onProgress, signal, mode, trustedFolders) {
        try {
          const result = await runner.run(prompt, project, route, threadId, onProgress, signal, mode, trustedFolders);
          record.subturns.push({ mode: mode ?? "main", route, usage: result.usage });
          return result;
        } catch (error) {
          record.subturns.push({ mode: mode ?? "main", route, error: String(error) });
          throw error;
        }
      },
    };
    if (arm === "baseline") {
      record.route = { model: "gpt-6-sol", effort: "high" };
      const result = await observed.run(task.prompt, fixture, record.route, undefined, () => {});
      record.result = result.result;
      record.usage = result.usage;
    } else {
      vex = new VexRouter();
      const session = newSession(fixture, "auto");
      const store = new PaceStore(join(root, "pace-store"));
      const outcome = await new Orchestrator(store, observed, vex).turn(task.prompt, session, config, (_progress: Progress) => {});
      record.result = outcome.result;
      record.route = outcome.route;
      record.routeNote = outcome.note;
      record.usage = outcome.usage;
    }
  } catch (error) {
    record.error = String(error);
  } finally {
    await vex?.close().catch(() => {});
    record.durationMs = Math.round(performance.now() - started);
    if (record.result) {
      for (const check of task.checks ?? []) record.checks.push(await command(check, fixture));
    }
    record.gitStatus = (await command("git status --short", fixture)).output;
    await command("git add -N .", fixture);
    try {
      const { stdout } = await exec("git diff --binary HEAD", { cwd: fixture, maxBuffer: 16_000_000, windowsHide: true });
      await writeFile(join(runDir, record.diffFile), stdout);
    } catch (error) {
      record.error ??= `Could not capture diff: ${String(error)}`;
    }
    try {
      const stats = JSON.parse(await readFile(statsPath, "utf8")) as { total_requests?: number; total_input_tokens?: number; total_output_tokens?: number; total_cost?: number };
      record.vex = { requests: stats.total_requests ?? 0, inputTokens: stats.total_input_tokens ?? 0, outputTokens: stats.total_output_tokens ?? 0, cost: stats.total_cost ?? 0 };
    } catch { /* No Vex decision was recorded. */ }
    await writeFile(join(runDir, "run.json"), JSON.stringify(record, null, 2) + "\n");
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    if (previousStatsPath === undefined) delete process.env.VEX_STATS_PATH;
    else process.env.VEX_STATS_PATH = previousStatsPath;
    const safeRoot = await realpath(root);
    const withinTemp = relative(await realpath(tmpdir()), safeRoot);
    if (!withinTemp.startsWith("..") && !isAbsolute(withinTemp) && basename(safeRoot).startsWith("pace-benchmark-"))
      await rm(safeRoot, { recursive: true, force: true });
  }
  return record;
}

async function main() {
  const options = args();
  const suite = parseSuite(JSON.parse(await readFile(options.suite, "utf8")));
  const repository = resolve(suite.repository);
  const cases = suite.cases.filter(task => !options.selectedCase || task.id === options.selectedCase);
  if (!cases.length) throw new Error("No matching cases");
  if (!vexServerPath()) throw new Error("Vex MCP server is unavailable");
  const config = await new PaceStore().loadConfig();
  config.routingMode = "auto";
  config.trustedFolders = [];
  config.skillFolder = undefined;
  await mkdir(options.out, { recursive: true });
  const runs: Run[] = [];
  const commits = new Map<string, string>();
  for (const task of cases) {
    const ref = task.ref ?? suite.ref ?? "HEAD";
    if (!commits.has(ref)) commits.set(ref, await git(repository, `show -s --format=%H ${ref}`));
  }
  await writeFile(join(options.out, "manifest.json"), JSON.stringify({ suite, repository, config, commits: Object.fromEntries(commits), repeats: options.repeat }, null, 2) + "\n");
  for (const task of cases) for (let repetition = 1; repetition <= options.repeat; repetition++) {
    for (const arm of (repetition % 2 ? ["baseline", "pace"] : ["pace", "baseline"]) as Arm[]) {
      console.log(`${task.id} ${repetition}/${options.repeat} ${arm}`);
      const run = await runArm(task, repetition, arm, repository, commits.get(task.ref ?? suite.ref ?? "HEAD")!, options.out, config);
      runs.push(run);
      console.log(run.error ?? `${total(run.usage) ?? "missing"} Codex tokens, ${run.durationMs} ms`);
      await writeFile(join(options.out, "summary.json"), JSON.stringify(summarize(runs), null, 2) + "\n");
    }
  }
  const summary = summarize(runs);
  console.log(`${summary.matched.length} matched pairs; ${summary.incompletePairs} incomplete; ${summary.savedTokens} Codex tokens saved (${summary.savedPercent?.toFixed(1) ?? "n/a"}%)`);
  console.log(`Results: ${options.out}`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
