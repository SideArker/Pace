import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { analyzeGrades, loadRuns, prepareGrades, reportGrades, type Grade, type Grades, type SavedRun } from "./grade.js";
import type { Arm, Run } from "./types.js";

const root = "C:/results";
const usage = {
  input_tokens: 100,
  cached_input_tokens: 20,
  cache_write_input_tokens: 10,
  output_tokens: 25,
  reasoning_output_tokens: 5,
};

function makeRun(id: string, arm: Arm, cost: number): Run {
  return {
    id, arm, repetition: 1, commit: "same-commit", promptSha256: `hash-${id}`,
    durationMs: 100, usage, estimatedCostUsd: cost,
    stages: [{ objective: "Complete request", route: { model: "gpt-6-sol", effort: "high" }, durationMs: 100, usage, estimatedCostUsd: cost }],
    routing: [], paceRoutingCalls: 0, agentVexCalls: 0, subturns: [], mcpCalls: [],
    vexShellCommands: [], checks: [{ command: "npm test", exitCode: 0, output: "" }],
    gitStatus: "", diffFile: "diff.patch",
  };
}

function fixture(runs: Run[], gradesById: Record<string, boolean>) {
  const saved = new Map<string, SavedRun>();
  const grades: Grade[] = [];
  for (const run of runs) {
    const runFile = `${run.id}/${run.repetition}/${run.arm}/run.json`;
    saved.set(`${run.id}:${run.repetition}:${run.arm}`, { run, path: join(root, runFile) });
    grades.push({ id: run.id, repetition: run.repetition, arm: run.arm, runFile,
      promptSha256: run.promptSha256, commit: run.commit, checksPassed: true,
      pass: gradesById[`${run.id}:${run.arm}`] ?? false, notes: "" });
  }
  return { saved, grades: { version: 1, runs: grades } as Grades };
}

describe("executed benchmark grading", () => {
  it("compares only manually passing pairs and reports token classes separately", () => {
    const { saved, grades } = fixture([
      makeRun("passing", "baseline", 0.10), makeRun("passing", "routed_split", 0.06),
      makeRun("failed", "baseline", 0.10), makeRun("failed", "routed_split", 0.03),
    ], { "passing:baseline": true, "passing:routed_split": true, "failed:baseline": true });
    const report = analyzeGrades(root, saved, grades);
    const split = report.comparisons.routed_split;
    expect(split?.qualityPassingPairs).toBe(1);
    expect(split?.aggregateSavingFraction).toBeCloseTo(0.4);
    expect(split?.baselineRawTokens).toBe(125);
    expect(split?.baselineTokenTotals.cachedInput).toBe(20);
    expect(split?.baselineTokenTotals.cacheWriteInput).toBe(10);
    expect(report.armQuality.routed_split?.passed).toBe(1);
    expect(report.armQuality.routed_split?.total).toBe(2);
    expect(report.armQuality.routed_split?.failures).toHaveLength(1);
    expect(split?.excludedPairs).toEqual([{ id: "failed:1", reason: "quality or checks failed" }]);
  });

  it("rejects comparisons from different repository snapshots", () => {
    const baseline = makeRun("case", "baseline", 0.10);
    const candidate = makeRun("case", "routed_single", 0.05);
    candidate.commit = "other-commit";
    const { saved, grades } = fixture([baseline, candidate], {
      "case:baseline": true, "case:routed_single": true,
    });
    expect(() => analyzeGrades(root, saved, grades)).toThrow("identical prompt and commit");
  });

  it("requires a grade for every run", () => {
    const { saved, grades } = fixture([makeRun("case", "baseline", 0.10)], {});
    grades.runs[0]!.pass = null;
    expect(() => analyzeGrades(root, saved, grades)).toThrow("Set pass=true or false");
  });

  it("prepares grades and writes a report from saved run files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pace-grade-test-"));
    try {
      for (const [arm, cost] of [["baseline", 0.10], ["routed_single", 0.05]] as const) {
        const runDir = join(directory, "case", "1", arm);
        await mkdir(runDir, { recursive: true });
        await writeFile(join(runDir, "run.json"), JSON.stringify(makeRun("case", arm, cost)));
      }
      const runs = await loadRuns(directory);
      const gradesPath = await prepareGrades(directory, runs);
      await expect(prepareGrades(directory, runs)).rejects.toMatchObject({ code: "EEXIST" });
      const grades = JSON.parse(await readFile(gradesPath, "utf8")) as Grades;
      for (const grade of grades.runs) grade.pass = true;
      await writeFile(gradesPath, JSON.stringify(grades));
      const { path, report } = await reportGrades(directory, runs);
      expect(report.comparisons.routed_single?.qualityPassingPairs).toBe(1);
      expect(JSON.parse(await readFile(path, "utf8")).comparisons.routed_single.costWins).toBe(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
