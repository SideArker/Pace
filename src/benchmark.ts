import { createHash } from "node:crypto";
import { exec as execCallback } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
  appendFile,
  stat,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { CodexRunner, Progress } from "./integrations/codex.js";
import { SdkRunner, codexOptions } from "./integrations/codex.js";
import { VexRouter, vexServerPath } from "./integrations/vex.js";
import { Orchestrator } from "./core/orchestrator.js";
import { PaceStore, newSession } from "./core/sessions.js";
import type { Config, Route } from "./types.js";
import type { Usage } from "@openai/codex-sdk";
import { costForUsage, PRICE_SNAPSHOT } from './core/pricing.js';
import type { StageRecord, RoutingRecord } from './core/orchestrator.js';
import type { VexRequest } from './integrations/vex.js';

const exec = promisify(execCallback);
type Arm = "baseline" | "routed_single" | "routed_split" | "routed_auto";
type Case = {
  id: string;
  prompt: string;
  ref?: string;
  setup?: string[];
  checks?: string[];
  rubric?: string;
};
type Suite = { repository: string; ref?: string; cases: Case[] };
type CommandResult = { command: string; exitCode: number; output: string };
type Run = {
  id: string;
  repetition: number;
  arm: Arm;
  commit: string;
  promptSha256: string;
  route?: Route;
  routeNote?: string;
  durationMs: number;
  usage?: Usage;
  estimatedCostUsd?: number;
  stages: StageRecord[];
  routing: RoutingRecord[];
  paceRoutingCalls: number;
  agentVexCalls: number;
  rubric?: string;
  subturns: { mode: string; route: Route; durationMs: number; usage?: Usage; estimatedCostUsd?: number; error?: string }[];
  vex?: {
    requests: number;
    inputTokens: number;
    outputTokens: number;
    cost: number;
  };
  mcpCalls: string[];
  vexShellCommands: string[];
  checks: CommandResult[];
  result?: string;
  error?: string;
  gitStatus: string;
  diffFile: string;
};

function args() {
  const values = process.argv.slice(2);
  if (values.includes("--help") || !values.length) {
    console.log(
      "Usage: npm run benchmark -- --suite <file.json> [--repeat 3] [--case id] [--include-auto] [--out directory] [--timeout-minutes 12]",
    );
    process.exit(values.includes("--help") ? 0 : 2);
  }
  const get = (key: string) => {
    const index = values.indexOf(key);
    return index < 0 ? undefined : values[index + 1];
  };
  const suite = get("--suite");
  const repeat = Number(get("--repeat") ?? "1");
  const timeoutMinutes = Number(get("--timeout-minutes") ?? "12");
  if (!suite || !Number.isInteger(repeat) || repeat < 1 || repeat > 10 || !Number.isFinite(timeoutMinutes) || timeoutMinutes < 1 || timeoutMinutes > 120)
    throw new Error("Provide --suite, --repeat between 1 and 10, and --timeout-minutes between 1 and 120");
  return {
    suite: resolve(suite),
    repeat,
    timeoutMinutes,
    selectedCase: get("--case"),
    includeAuto: values.includes('--include-auto'),
    out: resolve(
      get("--out") ??
        join(
          "benchmark",
          "results",
          new Date().toISOString().replace(/[:.]/g, "-"),
        ),
    ),
  };
}

function parseSuite(value: unknown): Suite {
  if (!value || typeof value !== "object")
    throw new Error("Suite must be an object");
  const suite = value as Partial<Suite>;
  if (
    typeof suite.repository !== "string" ||
    !Array.isArray(suite.cases) ||
    !suite.cases.length
  )
    throw new Error("Suite needs a repository and cases");
  if (suite.ref !== undefined && typeof suite.ref !== "string")
    throw new Error("Invalid suite ref");
  const ids = new Set<string>();
  for (const task of suite.cases) {
    if (
      !task ||
      typeof task.id !== "string" ||
      !/^[a-z0-9_-]+$/.test(task.id) ||
      ids.has(task.id) ||
      typeof task.prompt !== "string" ||
      !task.prompt.trim()
    )
      throw new Error("Each case needs a unique slug id and nonempty prompt");
    if (task.ref !== undefined && typeof task.ref !== "string")
      throw new Error(`Invalid ref for ${task.id}`);
    for (const key of ["setup", "checks"] as const)
      if (
        task[key] !== undefined &&
        (!Array.isArray(task[key]) ||
          !task[key].every(
            (command: unknown) => typeof command === "string" && command.trim(),
          ))
      )
        throw new Error(`Invalid ${key} for ${task.id}`);
    ids.add(task.id);
  }
  return suite as Suite;
}

async function command(
  command: string,
  cwd: string,
  timeout = 600_000,
): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await exec(command, {
      cwd,
      timeout,
      maxBuffer: 4_000_000,
      windowsHide: true,
    });
    return {
      command,
      exitCode: 0,
      output: `${stdout}${stderr}`.slice(-12_000),
    };
  } catch (error) {
    const failure = error as Error & {
      code?: number;
      stdout?: string;
      stderr?: string;
    };
    return {
      command,
      exitCode: typeof failure.code === "number" ? failure.code : 1,
      output:
        `${failure.stdout ?? ""}${failure.stderr ?? ""}${failure.message}`.slice(
          -12_000,
        ),
    };
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
    const single = total(pair.routed_single?.usage);
    const split = total(pair.routed_split?.usage);
    if (
      baseline === undefined ||
      single === undefined || split === undefined ||
      baseline === 0 ||
      pair.baseline?.error ||
      pair.routed_single?.error || pair.routed_split?.error ||
      pair.baseline?.vexShellCommands.length ||
      pair.baseline?.mcpCalls.some((call) => call.startsWith("vex/")) ||
      pair.baseline?.subturns.some((turn) => turn.error || !turn.usage) ||
      pair.routed_single?.subturns.some((turn) => turn.error || !turn.usage) ||
      pair.routed_split?.subturns.some((turn) => turn.error || !turn.usage)
    )
      return [];
    return [
      {
        key,
        baselineTokens: baseline,
        singleTokens: single,
        splitTokens: split,
        usage: { baseline: pair.baseline!.usage, single: pair.routed_single!.usage, split: pair.routed_split!.usage },
        baselineCostUsd: pair.baseline!.estimatedCostUsd,
        singleCostUsd: pair.routed_single!.estimatedCostUsd,
        splitCostUsd: pair.routed_split!.estimatedCostUsd,
        durationsMs: { baseline: pair.baseline!.durationMs, single: pair.routed_single!.durationMs, split: pair.routed_split!.durationMs },
        routes: { single: pair.routed_single!.stages.map(stage => stage.route), split: pair.routed_split!.stages.map(stage => stage.route) },
        vexCalls: { singleRouting: pair.routed_single!.paceRoutingCalls, splitRouting: pair.routed_split!.paceRoutingCalls, singleAgent: pair.routed_single!.agentVexCalls, splitAgent: pair.routed_split!.agentVexCalls },
        routingAbstentions: { single: pair.routed_single!.routing.filter(decision => !decision.choice).length, split: pair.routed_split!.routing.filter(decision => !decision.choice).length },
        rubric: pair.baseline!.rubric,
        baselineChecksPassed: pair.baseline!.checks.length
          ? pair.baseline!.checks.every((check) => check.exitCode === 0)
          : null,
        singleChecksPassed: pair.routed_single!.checks.length
          ? pair.routed_single!.checks.every((check) => check.exitCode === 0)
          : null,
        splitChecksPassed: pair.routed_split!.checks.length
          ? pair.routed_split!.checks.every((check) => check.exitCode === 0)
          : null,
      },
    ];
  });
  const autoMatched = [...pairs].flatMap(([key, pair]) => {
    const baseline = pair.baseline;
    const auto = pair.routed_auto;
    if (!baseline || !auto || baseline.error || auto.error || !baseline.usage || !auto.usage ||
      baseline.estimatedCostUsd === undefined || auto.estimatedCostUsd === undefined ||
      baseline.checks.some(check => check.exitCode !== 0) || auto.checks.some(check => check.exitCode !== 0) ||
      baseline.vexShellCommands.length || baseline.mcpCalls.some(call => call.startsWith('vex/')))
      return [];
    return [{ key, baselineCostUsd: baseline.estimatedCostUsd, autoCostUsd: auto.estimatedCostUsd,
      savingFraction: 1 - auto.estimatedCostUsd / baseline.estimatedCostUsd,
      baselineDurationMs: baseline.durationMs, autoDurationMs: auto.durationMs,
      baselineUsage: baseline.usage, autoUsage: auto.usage,
      shape: auto.routing.find(decision => decision.objective === 'workflow')?.choice,
      stages: auto.stages, routing: auto.routing, vexCalls: auto.paceRoutingCalls,
      agentVexCalls: auto.agentVexCalls, rubric: auto.rubric }];
  });
  const baselineTokens = matched.reduce(
    (sum, pair) => sum + pair.baselineTokens,
    0,
  );
  const singleTokens = matched.reduce((sum, pair) => sum + pair.singleTokens, 0);
  const splitTokens = matched.reduce((sum, pair) => sum + pair.splitTokens, 0);
  return {
    matched,
    autoMatched,
    incompleteAutoPairs: runs.some(run => run.arm === 'routed_auto') ? pairs.size - autoMatched.length : 0,
    incompletePairs: pairs.size - matched.length,
    baselineTokens,
    singleTokens,
    splitTokens,
    singleSavedTokens: baselineTokens - singleTokens,
    splitSavedTokens: baselineTokens - splitTokens,
    priceSnapshot: PRICE_SNAPSHOT,
  };
}

async function runArm(
  task: Case,
  repetition: number,
  arm: Arm,
  repository: string,
  commit: string,
  out: string,
  config: Config,
  timeoutMinutes: number,
): Promise<Run> {
  const root = await mkdtemp(join(tmpdir(), "pace-benchmark-"));
  const fixture = join(root, "workspace");
  const runDir = join(out, task.id, String(repetition), arm);
  await mkdir(runDir, { recursive: true });
  const previousStatsPath = process.env.VEX_STATS_PATH;
  const statsPath = join(runDir, "vex-stats.json");
  const started = performance.now();
  const record: Run = {
    id: task.id,
    repetition,
    arm,
    commit,
    promptSha256: createHash("sha256").update(task.prompt).digest("hex"),
    durationMs: 0,
    subturns: [],
    stages: [],
    routing: [],
    paceRoutingCalls: 0,
    agentVexCalls: 0,
    rubric: task.rubric,
    mcpCalls: [],
    vexShellCommands: [],
    checks: [],
    gitStatus: "",
    diffFile: "diff.patch",
  };
  let vex: VexRouter | undefined;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMinutes * 60_000);
  try {
    process.env.VEX_STATS_PATH = statsPath;
    await git(
      repository,
      `clone --quiet --no-hardlinks -- "${repository}" "${fixture}"`,
    );
    await git(fixture, `checkout --quiet --detach ${commit}`);
    if (
      await stat(join(repository, "node_modules"))
        .then((value) => value.isDirectory())
        .catch(() => false)
    )
      await symlink(
        join(repository, "node_modules"),
        join(fixture, "node_modules"),
        process.platform === "win32" ? "junction" : "dir",
      );
    for (const setup of task.setup ?? []) {
      const result = await command(setup, fixture);
      await appendFile(
        join(runDir, "setup.jsonl"),
        JSON.stringify(result) + "\n",
      );
      if (result.exitCode)
        throw new Error(`Setup failed: ${setup}: ${result.output}`);
    }
    const eventLog = join(runDir, "events.jsonl");
    const onEvent = async (event: unknown) => {
      await appendFile(eventLog, JSON.stringify(event) + "\n");
      const item = (
        event as {
          type?: string;
          item?: { type?: string; server?: string; tool?: string; command?: string };
        }
      ).item;
      if (
        (event as { type?: string }).type === "item.completed" &&
        item?.type === "mcp_tool_call"
      )
        record.mcpCalls.push(`${item.server}/${item.tool}`);
      if (arm === "baseline" && (event as { type?: string }).type === "item.completed" && item?.type === "command_execution" &&
        /\bjev(?:\.cmd|\.ps1)?\b|vex-mcp|vex_choose/i.test(item.command ?? ""))
        record.vexShellCommands.push(item.command ?? "");
    };
    const trustPath = fixture.toLowerCase().replace(/'/g, "''");
    const baseOptions = arm !== "baseline" ? codexOptions(vexServerPath()) : {};
    const runner = new SdkRunner({
      ...baseOptions,
      configOverrides: [
        `projects.'${trustPath}'.trust_level="trusted"`,
        ...(arm === "baseline" ? ["mcp_servers={}"] : []),
      ],
    }, onEvent);
    const observed: CodexRunner = {
      async run(
        prompt,
        project,
        route,
        threadId,
        onProgress,
        signal,
        mode,
        trustedFolders,
      ) {
        const subturnStarted = performance.now();
        try {
          const result = await runner.run(
            prompt,
            project,
            route,
            threadId,
            onProgress,
            signal,
            mode,
            trustedFolders,
          );
          record.subturns.push({
            mode: mode ?? "main",
            route,
            durationMs: Math.round(performance.now() - subturnStarted),
            usage: result.usage,
            estimatedCostUsd: costForUsage(route, result.usage),
          });
          return result;
        } catch (error) {
          record.subturns.push({
            mode: mode ?? "main",
            route,
            durationMs: Math.round(performance.now() - subturnStarted),
            error: String(error),
          });
          throw error;
        }
      },
    };
    if (arm === "baseline") {
      record.route = { model: "gpt-6-sol", effort: "high" };
      const result = await observed.run(
        task.prompt,
        fixture,
        record.route,
        undefined,
        () => {},
        controller.signal,
      );
      record.result = result.result;
      record.usage = result.usage;
      record.stages = [{ objective: 'Complete request', route: record.route, durationMs: 0, usage: result.usage, estimatedCostUsd: costForUsage(record.route, result.usage) }];
      record.estimatedCostUsd = record.stages[0]?.estimatedCostUsd;
    } else {
      vex = new VexRouter();
      const session = newSession(fixture, "auto");
      const store = new PaceStore(join(root, "pace-store"));
      const selectedShape = arm === 'routed_single' ? 'single' : arm === 'routed_split' ? 'scout' : undefined;
      const benchmarkVex = {
        verify: () => vex!.verify(),
        choose: (request: VexRequest) => {
          if (selectedShape && request.options.some(option => option.id === 'single'))
            return Promise.resolve({ contractVersion: '1', choice: selectedShape, abstained: false, confidence: 1,
              probabilities: Object.fromEntries(request.options.map(option => [option.id, option.id === selectedShape ? 1 : 0])) });
          record.paceRoutingCalls++;
          return vex!.choose(request);
        },
      };
      const outcome = await new Orchestrator(store, observed, benchmarkVex).turn(
        task.prompt,
        session,
        config,
        (_progress: Progress) => {},
        controller.signal,
      );
      record.result = outcome.result;
      record.route = outcome.route;
      record.routeNote = outcome.note;
      record.usage = outcome.usage;
      record.stages = outcome.stages;
      record.routing = outcome.routing;
      record.estimatedCostUsd = outcome.estimatedCostUsd;
    }
  } catch (error) {
    record.error = String(error);
  } finally {
    clearTimeout(timeout);
    await vex?.close().catch(() => {});
    record.durationMs = Math.round(performance.now() - started);
    if (record.estimatedCostUsd === undefined && record.subturns.length && record.subturns.every(turn => turn.estimatedCostUsd !== undefined))
      record.estimatedCostUsd = record.subturns.reduce((sum, turn) => sum + turn.estimatedCostUsd!, 0);
    record.agentVexCalls = record.mcpCalls.filter(call => call.startsWith('vex/')).length;
    if (record.result) {
      for (const check of task.checks ?? [])
        record.checks.push(await command(check, fixture));
    }
    record.gitStatus = (await command("git status --short", fixture)).output;
    await command("git add -N .", fixture);
    try {
      const { stdout } = await exec("git diff --binary HEAD", {
        cwd: fixture,
        maxBuffer: 16_000_000,
        windowsHide: true,
      });
      await writeFile(join(runDir, record.diffFile), stdout);
    } catch (error) {
      record.error ??= `Could not capture diff: ${String(error)}`;
    }
    try {
      const stats = JSON.parse(await readFile(statsPath, "utf8")) as {
        total_requests?: number;
        total_input_tokens?: number;
        total_output_tokens?: number;
        total_cost?: number;
      };
      record.vex = {
        requests: stats.total_requests ?? 0,
        inputTokens: stats.total_input_tokens ?? 0,
        outputTokens: stats.total_output_tokens ?? 0,
        cost: stats.total_cost ?? 0,
      };
    } catch {
      /* No Vex decision was recorded. */
    }
    await writeFile(
      join(runDir, "run.json"),
      JSON.stringify(record, null, 2) + "\n",
    );
    if (previousStatsPath === undefined) delete process.env.VEX_STATS_PATH;
    else process.env.VEX_STATS_PATH = previousStatsPath;
    const safeRoot = await realpath(root);
    const withinTemp = relative(await realpath(tmpdir()), safeRoot);
    if (
      !withinTemp.startsWith("..") &&
      !isAbsolute(withinTemp) &&
      basename(safeRoot).startsWith("pace-benchmark-")
    )
      await rm(safeRoot, { recursive: true, force: true });
  }
  return record;
}

async function main() {
  const options = args();
  const suite = parseSuite(JSON.parse(await readFile(options.suite, "utf8")));
  const repository = resolve(suite.repository);
  const cases = suite.cases.filter(
    (task) => !options.selectedCase || task.id === options.selectedCase,
  );
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
    if (!commits.has(ref))
      commits.set(ref, await git(repository, `show -s --format=%H ${ref}`));
  }
  await writeFile(
    join(options.out, "manifest.json"),
    JSON.stringify(
      {
        suite,
        repository,
        config,
        commits: Object.fromEntries(commits),
        repeats: options.repeat,
        timeoutMinutes: options.timeoutMinutes,
        includeAuto: options.includeAuto,
        priceSnapshot: PRICE_SNAPSHOT,
      },
      null,
      2,
    ) + "\n",
  );
  for (const task of cases)
    for (let repetition = 1; repetition <= options.repeat; repetition++) {
      for (const arm of (repetition % 2
        ? ["baseline", "routed_single", "routed_split", ...(options.includeAuto ? ["routed_auto"] : [])]
        : [...(options.includeAuto ? ["routed_auto"] : []), "routed_split", "routed_single", "baseline"]) as Arm[]) {
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
    `${summary.matched.length} matched triples; ${summary.incompletePairs} incomplete; ${summary.autoMatched.length} matched auto pairs. Review quality before selecting guidance.`,
  );
  console.log(`Results: ${options.out}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
