import type { Usage } from "@openai/codex-sdk";
import { PRICE_SNAPSHOT } from "../src/core/pricing.js";
import type { Arm, Run } from "./types.js";

export function total(usage?: Usage): number | undefined {
  return usage ? usage.input_tokens + usage.output_tokens : undefined;
}

export function summarize(runs: Run[]) {
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
  const lunaMatched = [...pairs].flatMap(([key, pair]) => {
    const baseline = pair.baseline;
    const luna = pair.luna_low;
    if (!baseline || !luna || baseline.error || luna.error || !baseline.usage || !luna.usage ||
      baseline.estimatedCostUsd === undefined || luna.estimatedCostUsd === undefined ||
      baseline.checks.some(check => check.exitCode !== 0) || luna.checks.some(check => check.exitCode !== 0) ||
      luna.vexShellCommands.length || luna.mcpCalls.some(call => call.startsWith('vex/')))
      return [];
    return [{ key, baselineCostUsd: baseline.estimatedCostUsd, lunaCostUsd: luna.estimatedCostUsd,
      savingFraction: 1 - luna.estimatedCostUsd / baseline.estimatedCostUsd,
      baselineDurationMs: baseline.durationMs, lunaDurationMs: luna.durationMs,
      baselineUsage: baseline.usage, lunaUsage: luna.usage, route: luna.route, rubric: luna.rubric }];
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
    lunaMatched,
    incompleteAutoPairs: runs.some(run => run.arm === 'routed_auto') ? pairs.size - autoMatched.length : 0,
    incompleteLunaPairs: runs.some(run => run.arm === 'luna_low') ? pairs.size - lunaMatched.length : 0,
    incompletePairs: pairs.size - matched.length,
    baselineTokens,
    singleTokens,
    splitTokens,
    singleSavedTokens: baselineTokens - singleTokens,
    splitSavedTokens: baselineTokens - splitTokens,
    priceSnapshot: PRICE_SNAPSHOT,
  };
}

