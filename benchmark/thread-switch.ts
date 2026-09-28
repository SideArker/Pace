import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { SdkRunner } from "../src/integrations/codex.js";
import { costForUsage } from "../src/core/routing/pricing.js";
import type { Route } from "../src/shared/types.js";

type ArmName = "fresh-thread" | "same-thread";
type Options = { fromModel: string; fromEffort: string; toModel: string; toEffort: string; repeat: number; out: string };

// A deterministic context-retention task: the follow-up depends on details from
// turn one, but both arms receive the same first prompt and model sequence.
const firstPrompt = `Analyze this fictional routing policy and preserve its exact facts for a follow-up:\n\nProject Pine supports batch exports and incremental exports. Batch exports run nightly, include archived records, and allow a maximum of 500,000 rows. Incremental exports run every 15 minutes, exclude archived records, and allow a maximum of 20,000 changed rows. Both modes use the same encryption key rotation schedule: every 30 days.\n\nExplain the operational tradeoff and list every limit and schedule accurately. Do not modify files.`;
const followupPrompt = `Using the policy we discussed, a customer needs archived records, has 24,000 changed rows, and cannot wait until tonight. Which export mode can meet the request, and why? State the relevant row limits, archive behavior, and timing. Do not invent a workaround or modify files.`;

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
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return {
    fromModel: values.get("--from-model") ?? "gpt-6-sol",
    fromEffort: values.get("--from-effort") ?? "high",
    toModel: values.get("--to-model") ?? "gpt-6-luna",
    toEffort: values.get("--to-effort") ?? "low",
    repeat,
    out: resolve(values.get("--out") ?? `benchmark/results/thread-switch-${stamp}.json`),
  };
}

function retainedPrompt(prompt: string, first: string, answer: string): string {
  return `Continue this conversation using only the retained exchanges below. The current user request follows the history.\n\nRetained conversation:\n${JSON.stringify([{ user: first, assistant: answer }])}\n\nCurrent user request:\n${prompt}`;
}

async function runArm(name: ArmName, options: Options): Promise<Record<string, unknown>> {
  const runner = new SdkRunner({}); // No Vex MCP or other MCP servers.
  const firstRoute: Route = { model: options.fromModel, effort: options.fromEffort as Route["effort"] };
  const nextRoute: Route = { model: options.toModel, effort: options.toEffort as Route["effort"] };
  const startedAt = new Date().toISOString();
  const firstStarted = performance.now();
  let threadId: string | undefined;
  const first = await runner.run(firstPrompt, process.cwd(), firstRoute, undefined, progress => {
    if (progress.kind === "thread") threadId = progress.text;
  }, undefined, "side");
  threadId = first.threadId ?? threadId;
  const followup = name === "fresh-thread" ? retainedPrompt(followupPrompt, firstPrompt, first.result) : followupPrompt;
  const secondStarted = performance.now();
  const second = await runner.run(followup, process.cwd(), nextRoute, name === "same-thread" ? threadId : undefined, () => {}, undefined, "side");
  const durationMs = Math.round(performance.now() - firstStarted);
  const secondDurationMs = Math.round(performance.now() - secondStarted);
  const firstCost = costForUsage(firstRoute, first.usage);
  const secondCost = costForUsage(nextRoute, second.usage);
  return {
    arm: name, startedAt, firstThreadId: threadId, secondThreadId: second.threadId,
    durationMs, turns: [
      { prompt: firstPrompt, route: firstRoute, durationMs: Math.round(secondStarted - firstStarted), usage: first.usage, estimatedCostUsd: firstCost, answer: first.result },
      { prompt: followup, route: nextRoute, durationMs: secondDurationMs, usage: second.usage, estimatedCostUsd: secondCost, answer: second.result },
    ],
    estimatedCostUsd: firstCost === undefined || secondCost === undefined ? undefined : firstCost + secondCost,
  };
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  await mkdir(resolve(options.out, ".."), { recursive: true });
  const runs: Record<string, unknown>[] = [];
  for (let repeat = 0; repeat < options.repeat; repeat++) {
    // Alternate which strategy runs first to reduce order and transient-load bias.
    const order: ArmName[] = repeat % 2 === 0 ? ["fresh-thread", "same-thread"] : ["same-thread", "fresh-thread"];
    for (const arm of order) {
      console.log(`Repeat ${repeat + 1}/${options.repeat}: ${arm}`);
      try {
        runs.push({ repeat: repeat + 1, ...await runArm(arm, options) });
      } catch (error) {
        runs.push({ repeat: repeat + 1, arm, error: String(error), failedAt: new Date().toISOString() });
        console.error(`${arm} failed: ${String(error)}`);
      }
    }
  }
  const result = {
    benchmark: "model-switch-threading",
    createdAt: new Date().toISOString(),
    options,
    prompts: { first: firstPrompt, followup: followupPrompt },
    notes: [
      "fresh-thread replays the successful first exchange in the second prompt, matching Pace's current model-switch behavior.",
      "same-thread resumes the first Codex thread and sends only the follow-up with the new model and effort.",
      "Inspect answers against the prompt facts for quality; this script records outputs and usage but does not auto-grade them.",
      "Usage and dollar amounts are SDK-reported tokens and estimated API equivalents, not account billing.",
    ],
    runs,
  };
  await writeFile(options.out, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
  console.log(`Results: ${options.out}`);
}

void main().catch(error => { console.error(String(error)); process.exitCode = 1; });
