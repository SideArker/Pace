# Pace benchmarking

Benchmarks answer three different questions. Keep their results separate.

| Question | Command | Evidence |
| --- | --- | --- |
| Does Vex select a plausible workflow and valid stage routes? | `benchmark:routing` | Choices, probabilities, retries, time, Vex calls and cost. No Codex execution. |
| What do the workflows produce on the same task? | `benchmark` | Answers, diffs, checks, stage usage, cost estimates, time, reports and Vex calls. |
| Which completed runs meet the task rubric at lower cost? | `benchmark:grade` | Manual quality grades and matched, quality-passing comparisons. |

## Source layout

- `routing-suite.json`: 60-case development set for shape and stage choices.
- `routing-holdout.json`: 24-case holdout; do not tune against it.
- `pilot.json`: short executed comparison.
- `validation.json`: 12 executed tasks on a fixed Pace commit.
- `agentic.json`: eight current-repository tasks covering scouting, planning, behavior preservation, report repair, and clarification. Each run records the resolved `HEAD` commit.
- `types.ts`, `suite.ts`, `execute.ts`, `summary.ts`, `workflows.ts`: executed benchmark runner.
- `grade.ts`: manual quality grading and cost analysis.
- `results/`: ignored run artifacts.

The route-only runner remains at `src/routing-benchmark.ts`. It exercises the same routing request builders and validator as Pace. `npm run benchmark:check` type-checks the TypeScript benchmark modules and Pace source.

## 1. Routing decisions

```powershell
npm run benchmark:routing -- --suite benchmark/routing-suite.json --repeat 3
npm run benchmark:routing -- --suite benchmark/routing-holdout.json --repeat 3
```

Use `--case <id>` for one case, `--shape-only` to omit stage choices, or `--out <new-directory>` to set the result path. The runner records `manifest.json`, `runs.jsonl`, `summary.json`, and Vex statistics. It alternates case order on repetitions. Stage routing after a split uses a **simulated** report; this benchmark cannot establish scout quality or Codex savings.

`acceptable` labels encode intent constraints and plausible workflows. `preferred` is a cost hypothesis, not a measured best route. The 60-case development suite was used to tune guidance. Run the holdout after changing guidance, then use executed comparisons before claiming quality or savings. Do not use holdout results for further tuning and still describe them as independent validation.

## 2. Executed workflows

```powershell
npm run benchmark -- --suite benchmark/pilot.json --repeat 2
npm run benchmark -- --suite benchmark/validation.json --repeat 3 --include-auto --include-luna
npm run benchmark -- --suite benchmark/agentic.json --repeat 3 --include-auto
```

Every arm receives the same literal prompt and starts from a fresh clone of the same resolved Git commit. Repetitions alternate arm order. Default arms are Sol High baseline, Vex-routed single, and Vex-routed Luna scout plus completion. `--include-auto` also runs Pace's chosen workflow. `--include-luna` adds fixed Luna Low to detect missed cheap single-agent routes. Vex routes model and effort for each routed Codex stage. The scout's validated report is the only scout context passed to completion.

Use `--list` to preview tasks without starting agents. Use `--case <id>`, `--repeat <1-10>`, `--timeout-minutes <1-120>`, and `--out <directory>` to control a run. The suite may specify a repository, Git ref, setup commands, check commands, and a review rubric. A suite with `HEAD` resolves one commit at the start of a run. Commit source changes before benchmarking them; uncommitted repository changes are not cloned into arms.

Each arm saves `run.json`, `events.jsonl`, `diff.patch`, and Vex statistics where applicable. The manifest saves the model configuration, routing prompt snapshot, resolved commits, and price snapshot. The runner writes `summary.json` after every arm, so interrupted runs still leave results. Run directories should be new; do not mix separate experiments.

## 3. Grade completed work

```powershell
npm run benchmark:grade -- prepare <results-directory>
```

Inspect each answer, `diff.patch`, check output, and rubric. Set every `pass` in `grades.json` to `true` or `false`, with a short `notes` entry for failures. Then run:

```powershell
npm run benchmark:grade -- report <results-directory>
```

`graded-summary.json` compares only pairs where baseline and candidate both pass manual review and checks, with complete usage and cost. It rejects mismatched prompts or commits and incomplete grades. It reports pass counts, cost wins and regressions, aggregate and median savings, raw tokens, cached and cache-write input, output and reasoning tokens, elapsed time, selected shapes and routes, and Vex calls and cost. The script refuses to overwrite an existing `grades.json`.

Build and test success alone do not establish requested behavior. For example, a previous Luna coding run passed tests but changed copy-on-parse behavior; manual review caught it. Grade answers and diffs against each task rubric. Record failures as failures even when they are cheap.

## Reading cost and safety limits

Codex dollar values are **estimated Standard API equivalents**, since actual account billing is unavailable to the SDK. Stage cost uses its own model's ordinary, cached, cache-write, and output rates; reasoning output is already in output. Workflow cost sums all recorded stages. Vex cost is measured separately and never enters routing optimization. Compare cost only among quality-passing runs; report latency and raw tokens separately.

Runs are sequential and consume Codex account allowance. They use the existing Codex login. The baseline disables MCP servers; routed arms may call Vex, and those agent-initiated calls are counted separately from Pace routing calls. A repository under test can still invoke installed programs through shell commands. Review raw event logs before sharing them because they may contain source text or command output.
