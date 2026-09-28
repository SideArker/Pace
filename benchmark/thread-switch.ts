import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Usage } from "@openai/codex-sdk";
import { AppServerRunner, type CodexRunner } from "../src/integrations/codex.js";
import { costForUsage, PRICE_SNAPSHOT } from "../src/core/routing/pricing.js";
import type { Route } from "../src/shared/types.js";

type ArmName = "fresh-thread" | "same-thread";
type Options = { fromModel: string; fromEffort: string; toModel: string; toEffort: string; repeat: number; historyTurns: number[]; out: string };
type SavedTurn = { prompt: string; promptCharacters: number; route: Route; threadId: string; durationMs: number; usage?: Usage; estimatedCostUsd?: number; answer: string; answerCharacters: number };
type ArmResult = { arm: ArmName; prompt: string; promptCharacters: number; startedAt: string; turn?: SavedTurn; error?: string; failedAt?: string };
type SwitchDelta = { inputTokens: number; cachedInputTokens: number; cacheWriteInputTokens: number; ordinaryInputTokens: number; outputTokens: number; reasoningOutputTokens: number; durationMs: number; estimatedCostUsd?: number };
type Trial = { repeat: number; historyTurns: number; startedAt: string; setupTurns: SavedTurn[]; setupPromptCharacters: number; setupAnswerCharacters: number; firstThreadId?: string; setupError?: string; arms: ArmResult[]; switchDeltaFreshMinusSame?: SwitchDelta };

// Each extra prompt adds one prior Codex turn. The final question still requires
// the batch/incremental limits and timing introduced in the first turn.
const setupPrompts = [
  "Analyze this fictional routing policy and preserve its exact facts for a follow-up:\n\nProject Pine supports batch exports and incremental exports. Batch exports run nightly, include archived records, and allow a maximum of 500,000 rows. Incremental exports run every 15 minutes, exclude archived records, and allow a maximum of 20,000 changed rows. Both modes use the same encryption key rotation schedule: every 30 days.\n\nExplain the operational tradeoff and list every limit and schedule accurately. Do not modify files.",
  "Add this fact to the same policy: export schedules are measured in UTC. A support team is writing examples for customers in several time zones. One customer reads a nightly schedule from Warsaw and another reads it from New York; both need to understand that the written schedule names the same UTC clock rather than their local wall clock. The examples should describe the schedule without promising a delivery time or inventing a daylight-saving rule. A customer can still ask whether an export will be ready before a particular local deadline, but the answer must first identify which export mode is involved and then compare that mode's stated timing with the deadline. Keep the distinction between a scheduled run and a completed file clear. This addition changes how time is described; it does not change the batch or incremental schedule, row limits, or archive behavior. Confirm the new fact in two sentences and keep the earlier policy in context. Do not modify files.",
  "Add this fact to the same policy: completed exports are retained for seven days. The support team wants a short explanation for customers who may download a file several days after requesting it. Retention begins when the export completes, so a pending request has no completed file to retain yet. The seven-day window concerns availability of the produced file; it says nothing about how far back the source records may reach. If a customer asks for archived records, support must still select a mode according to the archive rule from the original policy. If the selected mode cannot meet a requested deadline, the retention window does not make it faster. The policy does not describe permanent storage, automatic redelivery, or a grace period, so avoid promising any of those. This addition changes file availability only; the existing schedules and row caps remain in force. Confirm the new fact in two sentences and keep the earlier policy in context. Do not modify files.",
  "Add this fact to the same policy: exports use CSV files. An onboarding guide is comparing the export with a spreadsheet view in the product. Explain that CSV identifies the file format and does not imply a different record selection rule. The guide can tell customers to import the file into a spreadsheet or another system, but it should not claim that the export includes a workbook, embedded formulas, or multiple tabs. The number of rows allowed still comes from the chosen export mode, regardless of which program opens the file afterward. Likewise, a CSV file produced by an incremental export does not acquire archived records merely because the recipient combines files locally. A customer who needs archives and a customer who needs fast changes may face different choices even when both want CSV. This addition affects the delivered format only; it leaves schedules, limits, and archive behavior as previously stated. Confirm the new fact in two sentences and keep the earlier policy in context. Do not modify files.",
  "Add this fact to the same policy: a request over a mode's row limit is rejected rather than truncated. The support team is preparing a response for a customer whose requested range is just above the selected mode's cap. The response should say that the request fails validation instead of quietly producing a shorter file. It should not claim that the system automatically splits a large request, raises the limit, or moves it to another mode. The customer may need to change the request, but no specific workaround is authorized by this policy. Compare the requested row count with the exact cap of the selected mode before discussing timing or archive behavior. This matters especially when a customer wants the shorter incremental schedule but asks for more changed rows than incremental permits. Rejection is an outcome of the limit; it does not alter the original limits or schedules. Confirm the new fact in two sentences and keep the earlier policy in context. Do not modify files.",
  "Add this fact to the same policy: customers receive an email when an export completes. An operations note explains that the notification is a completion signal, not a separate export mode or a promise about when a file will finish. A customer who requests a batch export may receive the email after the scheduled batch job completes, while an incremental request follows its own schedule. The policy gives no delivery guarantee for email, so support should avoid turning the notice into an exact service-level deadline. The notification also does not alter which records the file contains, the row count that can be requested, or the availability of archived records. If a customer has a strict deadline, compare that deadline with the underlying export schedule rather than with the existence of the email. Keep the original mode comparison intact. Confirm the new fact in two sentences and keep the earlier policy in context. Do not modify files.",
  "Add this fact to the same policy: export files are encrypted at rest. A security FAQ needs to distinguish stored-file protection from the separate key rotation schedule in the original policy. The FAQ may state that files are encrypted while stored, but it should not infer a new encryption algorithm, a different rotation interval, or special handling for one export mode. Batch and incremental files follow the same stated rotation schedule. A customer choosing between modes still needs to decide based on rows, timing, and archive inclusion; encryption at rest does not make the modes interchangeable. The FAQ should also avoid claims about network transfer, customer-managed keys, and download authorization, because those topics are not specified here. This addition supplies one storage fact and leaves all previously stated limits and schedules in place. Confirm the new fact in two sentences and keep the earlier policy in context. Do not modify files.",
  "Add this fact to the same policy: a failed export can be retried once. An incident guide is explaining what happens after a job fails for an operational reason. One retry is available for that failed job, but the guide should not claim unlimited attempts, an automatic retry time, or a promise that the retry will succeed. A request rejected before execution for exceeding a row cap is different from a running job that fails; the retry rule does not authorize a request over a mode's limit. The retry also does not change a batch job into an incremental job or grant an incremental job access to archives. Customers planning around a deadline should use the published mode schedule and treat any retry as uncertainty, not as a faster path. This addition is about handling a failure after a valid request. Confirm the new fact in two sentences and keep the earlier policy in context. Do not modify files.",
];
const followupPrompt = "Using the policy we discussed, a customer needs archived records, has 24,000 changed rows, and cannot wait until tonight. Which export mode can meet the request, and why? State the relevant row limits, archive behavior, and timing. Do not invent a workaround or modify files.";

function parseOptions(argv: string[]): Options {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key?.startsWith("--")) throw new Error(`Unexpected argument: ${key}`);
    const value = argv[++i];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}`);
    values.set(key, value);
  }
  const repeat = Number(values.get("--repeat") ?? "3");
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 10) throw new Error("--repeat must be 1 to 10");
  const historyTurns = (values.get("--history-turns") ?? "1,4,8").split(",").map(Number);
  if (!historyTurns.length || historyTurns.some(n => !Number.isInteger(n) || n < 1 || n > setupPrompts.length) || new Set(historyTurns).size !== historyTurns.length)
    throw new Error(`--history-turns must be unique comma-separated integers from 1 to ${setupPrompts.length}`);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return {
    fromModel: values.get("--from-model") ?? "gpt-6-sol",
    fromEffort: values.get("--from-effort") ?? "high",
    toModel: values.get("--to-model") ?? "gpt-6-luna",
    toEffort: values.get("--to-effort") ?? "low",
    repeat, historyTurns,
    out: resolve(values.get("--out") ?? `benchmark/results/thread-switch-${stamp}.json`),
  };
}

function retainedPrompt(prompt: string, turns: SavedTurn[]): string {
  const history = turns.map(turn => ({ user: turn.prompt, assistant: turn.answer }));
  return `Continue this conversation using only the retained exchanges below. The current user request follows the history.\n\nRetained conversation:\n${JSON.stringify(history)}\n\nCurrent user request:\n${prompt}`;
}

async function runTurn(runner: CodexRunner, prompt: string, route: Route, expectedThreadId?: string): Promise<SavedTurn> {
  const started = performance.now();
  const execution = await runner.run(prompt, process.cwd(), route, expectedThreadId, () => {}, undefined, "side");
  if (!execution.threadId) throw new Error("Codex did not return a thread ID");
  const turn: SavedTurn = {
    prompt, promptCharacters: prompt.length, route, threadId: execution.threadId,
    durationMs: Math.round(performance.now() - started), usage: execution.usage,
    estimatedCostUsd: costForUsage(route, execution.usage), answer: execution.result, answerCharacters: execution.result.length,
  };
  return turn;
}

function switchDelta(arms: ArmResult[]): SwitchDelta | undefined {
  const fresh = arms.find(arm => arm.arm === "fresh-thread")?.turn;
  const same = arms.find(arm => arm.arm === "same-thread")?.turn;
  if (!fresh?.usage || !same?.usage) return undefined;
  return {
    inputTokens: fresh.usage.input_tokens - same.usage.input_tokens,
    cachedInputTokens: fresh.usage.cached_input_tokens - same.usage.cached_input_tokens,
    cacheWriteInputTokens: fresh.usage.cache_write_input_tokens - same.usage.cache_write_input_tokens,
    ordinaryInputTokens: (fresh.usage.input_tokens - fresh.usage.cached_input_tokens - fresh.usage.cache_write_input_tokens) - (same.usage.input_tokens - same.usage.cached_input_tokens - same.usage.cache_write_input_tokens),
    outputTokens: fresh.usage.output_tokens - same.usage.output_tokens,
    reasoningOutputTokens: fresh.usage.reasoning_output_tokens - same.usage.reasoning_output_tokens,
    estimatedCostUsd: fresh.estimatedCostUsd === undefined || same.estimatedCostUsd === undefined ? undefined : fresh.estimatedCostUsd - same.estimatedCostUsd,
    durationMs: fresh.durationMs - same.durationMs,
  };
}

function summaryByHistoryTurns(trials: Trial[], historyTurns: number[]) {
  return historyTurns.map(count => {
    const group = trials.filter(trial => trial.historyTurns === count);
    const paired = group.filter(trial => trial.switchDeltaFreshMinusSame);
    const totals = (armName: ArmName) => paired.reduce((sum, trial) => {
      const turn = trial.arms.find(arm => arm.arm === armName)!.turn!;
      const usage = turn.usage!;
      sum.inputTokens += usage.input_tokens;
      sum.cachedInputTokens += usage.cached_input_tokens;
      sum.cacheWriteInputTokens += usage.cache_write_input_tokens;
      sum.ordinaryInputTokens += usage.input_tokens - usage.cached_input_tokens - usage.cache_write_input_tokens;
      sum.outputTokens += usage.output_tokens;
      sum.reasoningOutputTokens += usage.reasoning_output_tokens;
      return sum;
    }, { inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, ordinaryInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 });
    const priced = paired.filter(trial => trial.switchDeltaFreshMinusSame!.estimatedCostUsd !== undefined);
    return {
      historyTurns: count, trials: group.length,
      setupFailures: group.filter(trial => trial.setupError).length,
      switchFailures: {
        freshThread: group.filter(trial => trial.arms.some(arm => arm.arm === "fresh-thread" && arm.error)).length,
        sameThread: group.filter(trial => trial.arms.some(arm => arm.arm === "same-thread" && arm.error)).length,
      },
      pairedWithCompleteUsage: paired.length,
      pairedWithPrices: priced.length,
      pairedSwitchCostDeltaUsd: priced.map(trial => trial.switchDeltaFreshMinusSame!.estimatedCostUsd!),
      pricedPairSwitchCostTotalsUsd: {
        freshThread: priced.reduce((sum, trial) => sum + trial.arms.find(arm => arm.arm === "fresh-thread")!.turn!.estimatedCostUsd!, 0),
        sameThread: priced.reduce((sum, trial) => sum + trial.arms.find(arm => arm.arm === "same-thread")!.turn!.estimatedCostUsd!, 0),
      },
      pairedSwitchTokenTotals: { freshThread: totals("fresh-thread"), sameThread: totals("same-thread") },
    };
  });
}

async function runTrial(runner: CodexRunner, repeat: number, historyTurns: number, options: Options): Promise<Trial> {
  const trial: Trial = { repeat, historyTurns, startedAt: new Date().toISOString(), setupTurns: [], setupPromptCharacters: 0, setupAnswerCharacters: 0, arms: [] };
  const firstRoute: Route = { model: options.fromModel, effort: options.fromEffort as Route["effort"] };
  const nextRoute: Route = { model: options.toModel, effort: options.toEffort as Route["effort"] };
  try {
    for (const prompt of setupPrompts.slice(0, historyTurns)) {
      const turn = await runTurn(runner, prompt, firstRoute, trial.firstThreadId);
      trial.setupTurns.push(turn);
      trial.setupPromptCharacters += turn.promptCharacters;
      trial.setupAnswerCharacters += turn.answerCharacters;
      trial.firstThreadId ??= turn.threadId;
      if (turn.threadId !== trial.firstThreadId) throw new Error(`Setup thread changed from ${trial.firstThreadId} to ${turn.threadId}`);
    }
  } catch (error) {
    trial.setupError = String(error);
    return trial;
  }
  const order: ArmName[] = (repeat + historyTurns) % 2 === 0 ? ["fresh-thread", "same-thread"] : ["same-thread", "fresh-thread"];
  for (const arm of order) {
    const prompt = arm === "fresh-thread" ? retainedPrompt(followupPrompt, trial.setupTurns) : followupPrompt;
    const result: ArmResult = { arm, prompt, promptCharacters: prompt.length, startedAt: new Date().toISOString() };
    trial.arms.push(result);
    try {
      const turn = await runTurn(runner, prompt, nextRoute, arm === "same-thread" ? trial.firstThreadId : undefined);
      result.turn = turn;
      if (arm === "same-thread" && turn.threadId !== trial.firstThreadId)
        throw new Error(`Same-thread arm did not resume ${trial.firstThreadId}; got ${turn.threadId}`);
      if (arm === "fresh-thread" && turn.threadId === trial.firstThreadId)
        throw new Error("Fresh-thread arm reused the setup thread");
    } catch (error) {
      result.error = String(error);
      result.failedAt = new Date().toISOString();
    }
  }
  if (trial.arms.every(arm => !arm.error)) trial.switchDeltaFreshMinusSame = switchDelta(trial.arms);
  return trial;
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  await mkdir(resolve(options.out, ".."), { recursive: true });
  const runner = new AppServerRunner();
  const trials: Trial[] = [];
  const createdAt = new Date().toISOString();
  const result = () => ({
    benchmark: "model-switch-threading",
    createdAt, options,
    prompts: { setup: setupPrompts, followup: followupPrompt },
    priceSnapshot: PRICE_SNAPSHOT,
    descriptiveSummary: summaryByHistoryTurns(trials, options.historyTurns),
    notes: [
      "Each trial creates one setup thread. Both switch strategies use that exact successful conversation; the fresh arm replays it and the same arm resumes it.",
      "Each setup turn uses the first route. Both switch turns request the second route. The switch delta is fresh minus same; positive cost means fresh cost more.",
      "The production App Server transport is used in read-only side mode for this synthetic task; coding turns in Pace use main mode.",
      "Inspect both answers for factual quality before treating a cost difference as a win. This script does not auto-grade quality.",
      "Usage is App Server-reported per-turn tokens and dollars are estimated API equivalents, not account billing.",
    ],
    trials,
  });
  await writeFile(options.out, `${JSON.stringify(result(), null, 2)}\n`, { flag: "wx" });
  for (let repeat = 1; repeat <= options.repeat; repeat++) {
    for (const historyTurns of options.historyTurns) {
      console.log(`Repeat ${repeat}/${options.repeat}, ${historyTurns} prior turns`);
      const trial = await runTrial(runner, repeat, historyTurns, options);
      trials.push(trial);
      await writeFile(options.out, `${JSON.stringify(result(), null, 2)}\n`);
      if (trial.setupError) console.error(`Setup failed: ${trial.setupError}`);
      for (const arm of trial.arms) if (arm.error) console.error(`${arm.arm} failed: ${arm.error}`);
    }
  }
  console.log(`Results: ${options.out}`);
}

void main().catch(error => { console.error(String(error)); process.exitCode = 1; });
