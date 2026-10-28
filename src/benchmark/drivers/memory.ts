import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppServer } from '../../integrations/app-server-process.js';
import { AppServerRunner, type CodexRunner } from '../transports.js';
import { isolatedAppServer, isolatedCommand } from '../isolation.js';
import { datasetProject, fetchMemoryDataset, memoryInputs } from '../memory-dataset.js';
import { runMemoryAgent } from '../memory-agent.js';
import { prepareMemoryDataset, writeFixture } from '../memory-prepare.js';
import { atomicJson, assertDebug, hash } from '../storage.js';
import { beginTrial, checkControl, emit, finishTrial } from '../control.js';
import { MEMORY_POLICY } from '../../core/memory/config.js';
import { memorySetupService } from '../../core/memory/setup.js';
import { freezeMemory, importMemory } from '../../core/memory/snapshot.js';
import { PaceStore } from '../../core/sessions.js';
import { costForUsage } from '../../core/routing/pricing.js';
import type { Preview } from '../types.js';

export async function memoryRunner(workspace: string, root: string): Promise<CodexRunner> {
  const launch = await isolatedAppServer(workspace, root);
  return new AppServerRunner((message, exit) => new AppServer(message, exit, false, launch), undefined, false, 'pace-memory');
}
export async function runMemoryBenchmark({ preview, out, signal, runnerFactory = memoryRunner }: {
  preview: Preview; out: string; signal?: AbortSignal; runnerFactory?: typeof memoryRunner;
}) {
  assertDebug();
  const executable = (preview.effectiveConfig as { executable: string }).executable;
  if (preview.profile.name === 'prepare') {
    if (!beginTrial('preparation/1')) return;
    await mkdir(out, { recursive: true }); let failed = true;
    try { await atomicJson(join(out, 'dataset.json'), await prepareMemoryDataset(executable, signal)); failed = false; }
    finally { finishTrial(failed); }
    return;
  }
  const { pin, suite } = await memoryInputs(), downloaded = await fetchMemoryDataset(pin, preview.selection.offline, signal);
  const tasks = preview.profile.name === 'quick' ? suite.cases.filter(task => task.id === 'similar-bug') : preview.profile.name === 'confirm' ? suite.holdout : suite.cases;
  await mkdir(out, { recursive: true });
  for (let repetition = 1; repetition <= preview.profile.repeats; repetition++) {
    const cycle = preview.profile.name === 'full-cycle';
    if (cycle && !beginTrial(`cycle/${repetition}`)) continue;
    const root = await mkdtemp(join(tmpdir(), 'pace-memory-benchmark-'));
    let cycleFailed = false;
    try {
      const cycleWorkspaces = { baseline: join(root, 'cycle-A/workspace'), memory: join(root, 'cycle-B/workspace') };
      const cycleBases = { baseline: join(root, 'cycle-A/store'), memory: join(root, 'cycle-B/store') };
      let cycleConfig: Awaited<ReturnType<typeof memorySetupService.setup>> | undefined;
      const cyclePreparation: Record<string, { modelCostUsd: number | null; durationMs: number; calls: number }> = {};
      if (cycle) {
        const files = await datasetProject(downloaded.directory, pin.commit!, 'base', signal), preparation = [];
        for (const arm of repetition % 2 ? ['baseline', 'memory'] as const : ['memory', 'baseline'] as const) {
          const workspace = cycleWorkspaces[arm], baseDir = cycleBases[arm]; await writeFixture(workspace, files);
          if (arm === 'memory') cycleConfig = await memorySetupService.setup(workspace, join(root, 'cycle-notes'), executable, baseDir, signal);
          for (let stage = 0; stage < suite.preparation.length; stage++) {
            checkControl();
            const runner = await runnerFactory(workspace, join(root, `${arm}-preparation-${stage}`)), started = performance.now();
            const result = await runMemoryAgent({ prompt: suite.preparation[stage]!, workspace, baseDir, route: suite.route, runner, memory: arm === 'memory', signal });
            preparation.push({ arm, stage, ...result.execution, prompt: suite.preparation[stage], durationMs: Math.round(performance.now() - started), costUsd: costForUsage(suite.route, result.execution.usage) ?? null });
            const calls = preparation.filter(call => call.arm === arm);
            cyclePreparation[arm] = { calls: calls.length, modelCostUsd: calls.every(call => call.costUsd !== null) ? calls.reduce((sum, call) => sum + call.costUsd!, 0) : null, durationMs: calls.reduce((sum, call) => sum + call.durationMs, 0) };
            await atomicJson(join(out, `preparation-${repetition}.json`), preparation);
          }
        }
      }
      for (const task of tasks) {
        signal?.throwIfAborted(); checkControl();
        if (!cycle && !beginTrial(`${task.id}/${repetition}`)) continue;
        let failed = false;
        const pairId = randomUUID(), directory = join(out, task.id, String(repetition)); await mkdir(directory, { recursive: true });
        const files = await datasetProject(downloaded.directory, pin.commit!, task.stage, signal);
        const order = repetition % 2 ? ['baseline', 'memory'] as const : ['memory', 'baseline'] as const;
        try {
          for (const arm of order) {
            const armRoot = join(root, task.id, arm), workspace = cycle ? cycleWorkspaces[arm] : join(armRoot, 'workspace'), baseDir = cycle ? cycleBases[arm] : join(armRoot, 'store');
            // Each assigned snapshot exposes only project code and a fresh Git history.
            await rm(workspace, { recursive: true, force: true });
            const fixture = await writeFixture(workspace, files, task.stage === 'base' ? 'main' : 'rates-v2');
            const runDir = join(directory, arm); await mkdir(runDir, { recursive: true });
            const started = performance.now();
            const record: Record<string, any> = { version: 1, benchmark: 'memory', pairId, id: task.id, repetition, arm, group: task.group, language: task.language, stage: task.stage, experiment: cycle ? 'full-cycle' : 'seeded',
              datasetCommit: pin.commit, seedSha256: pin.seedSha256, policy: MEMORY_POLICY, fixtureSha256: hash(JSON.stringify(files)), commit: fixture.commit, originalPromptSha256: hash(task.prompt), verificationSha256: hash(task.verification),
              route: suite.route, rubric: task.rubric, severity: task.severity, backendVersion: arm === 'memory' ? '0.24.1' : null, preparationCostUsd: downloaded.snapshot.preparation.costUsd,
              importDurationMs: 0, backendCostUsd: null, qualityRegressionAllowed: 0, ...(cycle ? { cyclePreparation } : {}) };
            try {
              let config = cycle && arm === 'memory' ? cycleConfig : undefined;
              if (arm === 'memory' && !cycle) {
                const importStart = performance.now();
                config = await memorySetupService.setup(workspace, join(armRoot, 'notes'), executable, baseDir, signal);
                await importMemory(downloaded.snapshot, config, new PaceStore(baseDir), signal);
                record.importDurationMs = Math.round(performance.now() - importStart);
              }
              const runner = await runnerFactory(workspace, join(armRoot, 'agent'));
              const result = await runMemoryAgent({ prompt: task.prompt, workspace, baseDir, route: suite.route, runner, signal, memory: arm === 'memory', progress: event => { if (event.kind === 'prompt') record.input = event.input; } });
              Object.assign(record, result.execution, { prompt: result.prompt, estimatedCostUsd: costForUsage(suite.route, result.execution.usage) });
              if (config) {
                const telemetry = await readFile(join(config.configDirectory, 'pace-events.jsonl'), 'utf8').catch(() => '');
                record.memoryTelemetry = telemetry.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(event => result.session.attempts?.some(attempt => attempt.id === event.attemptId));
                if (cycle) await atomicJson(join(out, `cycle-memory-${repetition}.json`), await freezeMemory(config, new PaceStore(baseDir), { model: suite.route.model, effort: suite.route.effort, usage: null, costUsd: null, durationMs: Math.round(performance.now() - started) }));
              }
            } catch (error) { record.error = String(error); failed = true; }
            record.durationMs = Math.round(performance.now() - started);
            record.checks = [];
            for (const args of [['test.mjs'], ['--input-type=module', '-e', task.verification]]) {
              try { const check = await isolatedCommand(workspace, process.execPath, args, signal); record.checks.push({ command: args[0] === 'test.mjs' ? 'node test.mjs' : 'external verification', exitCode: 0, output: check.stdout + check.stderr }); }
              catch (error) { record.checks.push({ command: 'verification', exitCode: 1, output: String(error) }); }
            }
            record.checksPassed = record.checks.every((check: { exitCode: number }) => check.exitCode === 0);
            await fixture.git('add', '-N', '.');
            await writeFile(join(runDir, 'diff.patch'), await fixture.git('diff', '--binary', 'HEAD'));
            await atomicJson(join(runDir, 'run.json'), record);
            emit('memory-arm-finished', { key: `${task.id}/${repetition}`, arm, error: record.error, importDurationMs: record.importDurationMs, backendCostUsd: null });
          }
        } finally { if (!cycle) finishTrial(failed); else cycleFailed ||= failed; }
      }
    } catch (error) { cycleFailed = true; throw error; }
    finally { await rm(root, { recursive: true, force: true }); if (cycle) finishTrial(cycleFailed); }
  }
}
