import { assertDebug } from "../../storage.js";
import { createHash } from "node:crypto";
import { execFile, exec as execCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile, appendFile, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";
import type { CodexRunner, Progress } from "../../transports.js";
import { SdkRunner, codexOptions } from "../../transports.js";
import { VexRouter, vexServerPath } from "../../transports.js";
import { Orchestrator } from "../../../core/orchestrator.js";
import { PaceStore, newSession } from "../../../core/sessions.js";
import { costForUsage } from "../../../core/routing/pricing.js";
import { routingPromptFile, type RoutingPrompts } from "../../../core/routing/routing-prompts.js";
import type { VexRequest } from "../../transports.js";
import type { Config } from "../../../shared/types.js";
import type { Arm, BenchmarkCase as Case, CommandResult, Run } from "../types.js";

const exec = promisify(execCallback);

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

export async function git(cwd: string, arguments_: string): Promise<string> {
  const result = await command(`git ${arguments_}`, cwd);
  if (result.exitCode) throw new Error(`${result.command}: ${result.output}`);
  return result.output.trim();
}

export async function runArm(
  task: Case,
  repetition: number,
  arm: Arm,
  repository: string,
  commit: string,
  out: string,
  config: Config,
  timeoutMinutes: number,
  routingPrompts: RoutingPrompts,
): Promise<Run> {
  assertDebug();
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
    const execGit = promisify(execFile);
    await execGit('git', ['clone', '--quiet', '--no-hardlinks', '--', repository, fixture], { cwd: repository });
    await execGit('git', ['checkout', '--quiet', '--detach', commit], { cwd: fixture });
    if(process.env.PACE_BENCHMARK_DATASET_PROJECT===repository)await execGit('git',['remote','remove','origin'],{cwd:fixture});
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
      if ((arm === "baseline" || arm === 'luna_low') && (event as { type?: string }).type === "item.completed" && item?.type === "command_execution" &&
        /\bjev(?:\.cmd|\.ps1)?\b|vex-mcp|vex_choose/i.test(item.command ?? ""))
        record.vexShellCommands.push(item.command ?? "");
    };
    const trustPath = fixture.toLowerCase().replace(/'/g, "''");
    const baseOptions = arm !== "baseline" && arm !== 'luna_low' ? codexOptions(vexServerPath()) : {};
    const runner = new SdkRunner({
      ...baseOptions,
      configOverrides: [
        `projects.'${trustPath}'.trust_level="trusted"`,
        ...(arm === "baseline" || arm === 'luna_low' ? ["mcp_servers={}"] : []),
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
    if (arm === "baseline" || arm === 'luna_low') {
      record.route = arm === 'luna_low' ? { model: 'gpt-6-luna', effort: 'low' } : { model: "gpt-6-sol", effort: "high" };
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
      await mkdir(store.baseDir, { recursive: true });
      await writeFile(join(store.baseDir, routingPromptFile), JSON.stringify(routingPrompts));
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
