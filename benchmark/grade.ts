import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Usage } from "@openai/codex-sdk";
import type { Arm, Run } from "./types.js";

export type SavedRun = { run: Run; path: string };
export type Grade = {
  id: string;
  repetition: number;
  arm: Arm;
  runFile: string;
  promptSha256: string;
  commit: string;
  rubric?: string;
  checksPassed: boolean;
  pass: boolean | null;
  notes: string;
};
export type Grades = { version: 1; runs: Grade[] };

const key = (run: Pick<Run, "id" | "repetition" | "arm">) =>
  `${run.id}:${run.repetition}:${run.arm}`;
const pairKey = (run: Pick<Run, "id" | "repetition">) =>
  `${run.id}:${run.repetition}`;
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length ? sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2 : null;
};
const count = (values: string[]) => Object.fromEntries(
  [...new Set(values)].sort().map(value => [value, values.filter(item => item === value).length]),
);

export async function loadRuns(root: string): Promise<Map<string, SavedRun>> {
  const runs = new Map<string, SavedRun>();
  for (const caseId of await readdir(root, { withFileTypes: true })) {
    if (!caseId.isDirectory()) continue;
    for (const repetition of await readdir(join(root, caseId.name), { withFileTypes: true })) {
      if (!repetition.isDirectory()) continue;
      for (const arm of await readdir(join(root, caseId.name, repetition.name), { withFileTypes: true })) {
        if (!arm.isDirectory()) continue;
        const path = join(root, caseId.name, repetition.name, arm.name, "run.json");
        const text = await readFile(path, "utf8").catch(() => undefined);
        if (!text) continue;
        const run = JSON.parse(text) as Run;
        if (run.id !== caseId.name || String(run.repetition) !== repetition.name || run.arm !== arm.name)
          throw new Error(`Run path disagrees with run.json: ${path}`);
        if (runs.has(key(run))) throw new Error(`Duplicate run: ${key(run)}`);
        runs.set(key(run), { run, path });
      }
    }
  }
  if (!runs.size) throw new Error(`No run.json files found in ${root}`);
  return runs;
}

export async function prepareGrades(root: string, runs: Map<string, SavedRun>) {
  const path = join(root, "grades.json");
  const grades: Grades = { version: 1, runs: [...runs.values()]
    .sort((a, b) => key(a.run).localeCompare(key(b.run)))
    .map(({ run, path: runPath }) => ({
      id: run.id, repetition: run.repetition, arm: run.arm,
      runFile: relative(root, runPath).replaceAll("\\", "/"),
      promptSha256: run.promptSha256, commit: run.commit, rubric: run.rubric,
      checksPassed: run.checks.every(check => check.exitCode === 0),
      pass: null, notes: "",
    })) };
  await writeFile(path, JSON.stringify(grades, null, 2) + "\n", { flag: "wx" });
  return path;
}

function tokens(usage: Usage) {
  return {
    raw: usage.input_tokens + usage.output_tokens,
    input: usage.input_tokens,
    cachedInput: usage.cached_input_tokens,
    cacheWriteInput: usage.cache_write_input_tokens,
    output: usage.output_tokens,
    reasoningOutput: usage.reasoning_output_tokens,
  };
}

export function analyzeGrades(root: string, runs: Map<string, SavedRun>, grades: Grades) {
  if (grades.version !== 1 || !Array.isArray(grades.runs))
    throw new Error("grades.json must contain version 1 and runs");
  const marked = new Map<string, Grade>();
  for (const grade of grades.runs) {
    const identity = key(grade);
    const saved = runs.get(identity);
    if (!saved || marked.has(identity)) throw new Error(`Missing or duplicate run: ${identity}`);
    if (grade.runFile !== relative(root, saved.path).replaceAll("\\", "/") ||
      grade.promptSha256 !== saved.run.promptSha256 || grade.commit !== saved.run.commit)
      throw new Error(`Run identity changed: ${identity}`);
    if (typeof grade.pass !== "boolean") throw new Error(`Set pass=true or false for ${identity}`);
    marked.set(identity, grade);
  }
  if (marked.size !== runs.size) throw new Error("grades.json does not cover every run");

  const groups = new Map<string, SavedRun[]>();
  for (const saved of runs.values()) {
    const id = pairKey(saved.run);
    groups.set(id, [...(groups.get(id) ?? []), saved]);
  }
  for (const [id, group] of groups) {
    if (new Set(group.map(item => item.run.promptSha256)).size !== 1 ||
      new Set(group.map(item => item.run.commit)).size !== 1)
      throw new Error(`Compared arms need identical prompt and commit: ${id}`);
  }
  const passed = (run: Run) => marked.get(key(run))?.pass === true && !run.error &&
    run.checks.every(check => check.exitCode === 0);
  const arms = [...new Set([...runs.values()].map(item => item.run.arm))].sort();
  const armQuality = Object.fromEntries(arms.map(arm => {
    const group = [...runs.values()].filter(item => item.run.arm === arm);
    return [arm, { passed: group.filter(item => passed(item.run)).length, total: group.length,
      failures: group.filter(item => !passed(item.run)).map(item => ({
        id: item.run.id, repetition: item.run.repetition,
        error: item.run.error, notes: marked.get(key(item.run))?.notes ?? "",
        checksPassed: item.run.checks.every(check => check.exitCode === 0),
      })) }];
  }));

  const comparisons = Object.fromEntries(arms.filter(arm => arm !== "baseline").map(arm => {
    const excludedPairs = [...groups].flatMap(([id, group]) => {
      const baseline = group.find(item => item.run.arm === "baseline")?.run;
      const candidate = group.find(item => item.run.arm === arm)?.run;
      if (!baseline || !candidate) return [{ id, reason: "missing baseline or candidate" }];
      if (!passed(baseline) || !passed(candidate)) return [{ id, reason: "quality or checks failed" }];
      if (!baseline.usage || !candidate.usage || baseline.estimatedCostUsd === undefined ||
        candidate.estimatedCostUsd === undefined) return [{ id, reason: "missing usage or cost" }];
      return [];
    });
    const pairs = [...groups.values()].flatMap(group => {
      const baseline = group.find(item => item.run.arm === "baseline")?.run;
      const candidate = group.find(item => item.run.arm === arm)?.run;
      if (!baseline || !candidate || !passed(baseline) || !passed(candidate) ||
        !baseline.usage || !candidate.usage || baseline.estimatedCostUsd === undefined ||
        candidate.estimatedCostUsd === undefined) return [];
      return [{
        id: candidate.id, repetition: candidate.repetition,
        baselineCostUsd: baseline.estimatedCostUsd,
        candidateCostUsd: candidate.estimatedCostUsd,
        savingFraction: baseline.estimatedCostUsd ? 1 - candidate.estimatedCostUsd / baseline.estimatedCostUsd : null,
        baselineDurationMs: baseline.durationMs, candidateDurationMs: candidate.durationMs,
        baselineTokens: tokens(baseline.usage), candidateTokens: tokens(candidate.usage),
        shape: candidate.routing.find(choice => choice.objective === "workflow")?.choice,
        routes: candidate.stages.map(stage => `${stage.route.model}:${stage.route.effort}`),
        paceVexCalls: candidate.paceRoutingCalls, agentVexCalls: candidate.agentVexCalls,
        vexCostUsd: candidate.vex?.cost ?? 0,
      }];
    });
    const baselineCostUsd = sum(pairs.map(pair => pair.baselineCostUsd));
    const candidateCostUsd = sum(pairs.map(pair => pair.candidateCostUsd));
    const tokenFields = ["raw", "input", "cachedInput", "cacheWriteInput", "output", "reasoningOutput"] as const;
    const tokenTotals = (side: "baselineTokens" | "candidateTokens") => Object.fromEntries(
      tokenFields.map(field => [field, sum(pairs.map(pair => pair[side][field]))]),
    );
    const caseOutcomes = [...new Set(pairs.map(pair => pair.id))].sort().map(id => {
      const group = pairs.filter(pair => pair.id === id);
      const base = sum(group.map(pair => pair.baselineCostUsd));
      const candidate = sum(group.map(pair => pair.candidateCostUsd));
      return { id, pairs: group.length,
        costWins: group.filter(pair => pair.candidateCostUsd < pair.baselineCostUsd).length,
        aggregateSavingFraction: base ? 1 - candidate / base : null };
    });
    return [arm, {
      qualityPassingPairs: pairs.length,
      excludedPairs,
      costWins: pairs.filter(pair => pair.candidateCostUsd < pair.baselineCostUsd).length,
      costRegressions: pairs.filter(pair => pair.candidateCostUsd >= pair.baselineCostUsd)
        .map(pair => ({ id: pair.id, repetition: pair.repetition })),
      baselineCostUsd, candidateCostUsd,
      aggregateSavingFraction: baselineCostUsd ? 1 - candidateCostUsd / baselineCostUsd : null,
      medianPairSavingFraction: median(pairs.flatMap(pair => pair.savingFraction === null ? [] : [pair.savingFraction])),
      baselineDurationMs: sum(pairs.map(pair => pair.baselineDurationMs)),
      candidateDurationMs: sum(pairs.map(pair => pair.candidateDurationMs)),
      baselineRawTokens: sum(pairs.map(pair => pair.baselineTokens.raw)),
      candidateRawTokens: sum(pairs.map(pair => pair.candidateTokens.raw)),
      baselineTokenTotals: tokenTotals("baselineTokens"), candidateTokenTotals: tokenTotals("candidateTokens"),
      shapes: count(pairs.flatMap(pair => pair.shape ? [pair.shape] : [])),
      routes: count(pairs.map(pair => pair.routes.join(" + "))),
      paceVexCalls: sum(pairs.map(pair => pair.paceVexCalls)),
      agentVexCalls: sum(pairs.map(pair => pair.agentVexCalls)),
      vexCostUsd: sum(pairs.map(pair => pair.vexCostUsd)),
      caseOutcomes, pairs,
    }];
  }));
  return { armQuality, comparisons,
    note: "Only pairs with manual pass grades, passing checks, complete usage, and costs are compared. Dollar amounts are estimated Standard API equivalents. Vex cost is separate." };
}

export async function reportGrades(root: string, runs: Map<string, SavedRun>) {
  const grades = JSON.parse(await readFile(join(root, "grades.json"), "utf8")) as Grades;
  const report = analyzeGrades(root, runs, grades);
  const path = join(root, "graded-summary.json");
  await writeFile(path, JSON.stringify(report, null, 2) + "\n");
  return { path, report };
}

async function main() {
  const [action, directory] = process.argv.slice(2);
  if (!["prepare", "report"].includes(action ?? "") || !directory)
    throw new Error("Usage: npm run benchmark:grade -- <prepare|report> <results-directory>");
  const root = resolve(directory);
  const runs = await loadRuns(root);
  if (action === "prepare") {
    const path = await prepareGrades(root, runs);
    console.log(`Review answers and diffs, then set pass=true/false in ${path} (${runs.size} runs).`);
  } else {
    const { path, report } = await reportGrades(root, runs);
    for (const [arm, item] of Object.entries(report.comparisons)) {
      console.log(`${arm}: ${item.qualityPassingPairs} quality-passing pairs, ${item.costWins} cost wins, ${item.aggregateSavingFraction === null ? "no saving estimate" : `${(item.aggregateSavingFraction * 100).toFixed(1)}% aggregate saving`}`);
    }
    console.log(`Graded report: ${path}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)))
  main().catch(error => { console.error(error); process.exitCode = 1; });
