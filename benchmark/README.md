# Pace benchmarking

Benchmarks answer three different questions. Keep their results separate.

| Question | Command | Evidence |
| --- | --- | --- |
| Does Vex select a plausible workflow and valid stage routes? | `benchmark:routing` | Choices, probabilities, retries, time, Vex calls and cost. No Codex execution. |
| What do the workflows produce on the same task? | `benchmark` | Answers, diffs, checks, stage usage, cost estimates, time, reports and Vex calls. |
| Which completed runs meet the task rubric at lower cost? | `benchmark:grade` | Manual quality grades and matched, quality-passing comparisons. |

## Source layout

- `suites/routing-suite.json`: 64-case development set for shape and stage choices.
- `suites/routing-holdout.json`: 24-case holdout; do not tune against it.
- `suites/pilot.json`: short executed comparison.
- `suites/validation.json`: 12 executed tasks on a fixed Pace commit.
- `suites/agentic.json`: eight current-repository tasks covering scouting, planning, behavior preservation, report repair, and clarification. Each run records the resolved `HEAD` commit.
- `types.ts` and `runner/`: shared types and executed benchmark runner.
- `grading/`: manual quality grading and cost analysis.
- `reports/`: written results from earlier benchmark runs.
- `results/`: ignored run artifacts.

The route-only runner is at `src/entrypoints/routing-benchmark.ts`. It exercises the same routing request builders and validator as Pace. `npm run benchmark:check` type-checks the TypeScript benchmark modules and Pace source.

## 1. Routing decisions

```powershell
npm run benchmark:routing -- --suite benchmark/suites/routing-suite.json --repeat 3
npm run benchmark:routing -- --suite benchmark/suites/routing-holdout.json --repeat 3
```

Use `--case <id>` for one case, `--shape-only` to omit stage choices, or `--out <new-directory>` to set the result path. The runner records `manifest.json`, `runs.jsonl`, `summary.json`, and Vex statistics. It alternates case order on repetitions. Stage routing after a split uses **simulated** reports; this benchmark cannot establish scout quality or Codex savings.

`acceptable` labels encode intent constraints and plausible workflows. `preferred` is a cost hypothesis, not a measured best route. Run the holdout after changing guidance, then use executed comparisons before claiming quality or savings. Do not use holdout results for further tuning and still describe them as independent validation.

## 2. Executed workflows

```powershell
npm run benchmark -- --suite benchmark/suites/pilot.json --repeat 2
npm run benchmark -- --suite benchmark/suites/validation.json --repeat 3 --include-auto --include-luna
npm run benchmark -- --suite benchmark/suites/agentic.json --repeat 3 --include-auto
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

## 4. Model switch: fresh thread vs same thread

```powershell
npm run benchmark:thread-switch -- --repeat 3
```

Each trial builds one conversation with 1, 4, or 8 successful prior turns. The later turns each provide a substantial, coherent policy update, so the 8-turn case has a longer history. The same-thread arm requests Luna Low while resuming that Codex thread; the fresh-thread arm requests Luna Low in a new thread and replays the **identical** saved exchanges in Pace's current handoff format. The final question always needs facts from the first turn. Both switch turns request the same route. Arm order alternates, and the script checks that the resumed and fresh thread IDs have the expected relationship.

The result file records every setup turn, both switch prompts and answers, actual prompt and answer character counts, raw per-turn usage (including cached and ordinary input), estimated costs, timings, and partial data when an arm fails. It is updated after every trial to preserve completed trials if a later one stops. `switchDeltaFreshMinusSame` is the paired **switch-turn** difference; a positive cost delta means the fresh arm cost more. Token deltas remain available for unpriced models, while cost deltas require prices for both arms. `descriptiveSummary` groups complete-usage pairs and failure counts by history length. Setup cost is shared by the two arms and is recorded separately. Review both answers for correctness before interpreting any cost difference; the script does not grade them.

Use `--history-turns 1,4,8`, `--from-model`, `--from-effort`, `--to-model`, `--to-effort`, `--repeat 1-10`, and `--out <file>` to vary routes and output. For example, `npm run benchmark:thread-switch -- --history-turns 4,8 --from-model gpt-6-luna --from-effort low --to-model gpt-6-sol --to-effort high --repeat 5`. The script uses Pace's production App Server transport in read-only side mode for this synthetic task; Pace's coding completion uses main mode. A rejected same-thread model change is a recorded failure. App Server usage is not account billing, and one synthetic policy task does not establish general coding quality or long-session performance.

Build and test success alone do not establish requested behavior. For example, a previous Luna coding run passed tests but changed copy-on-parse behavior; manual review caught it. Grade answers and diffs against each task rubric. Record failures as failures even when they are cheap.

## 5. Context actions on coding tasks

```powershell
npm run benchmark:context-quality -- --repeat 1
```

This runner uses the fixed model and effort for four arms: resume, fresh replay, native compact and resume, and fresh thread with a validated checkpoint. Each arm starts from the same generated Git fixture, receives the same setup prompts and follow-ups, and runs the same external check. Arm order reverses on even repetitions. The two cases cover earlier tool output, a user correction, partial code, exact constraints, and two coding follow-ups. Use `--case <id>`, `--repeat <1-10>`, `--model`, `--effort`, `--turn-timeout-minutes <1-20>`, and `--out <new-directory>` to control a run. `--arm <name>` runs one arm for debugging and does not produce a paired comparison. Approval requests are declined and counted rather than left pending.

The output records every setup, checkpoint, compaction, and follow-up step, including duration, usage, estimated cost, failures, check output, and diffs. `summary.json` includes every attempted arm. Inspect each `run.json` and `diff.patch` against its rubric, then report task pass rates and critical lost-context errors with cost across all attempts. A passing check alone does not establish quality. Keep automatic context policies disabled until a separate holdout shows meaningful net savings without a material quality regression.

The first coding comparison and its limitations are in [the 2026-09-29 context quality report](reports/context-quality-2026-09-29.md).

## Reading cost and safety limits

Codex dollar values are **estimated Standard API equivalents**, since actual account billing is unavailable to the SDK. Stage cost uses its own model's ordinary, cached, cache-write, and output rates; reasoning output is already in output. Workflow cost sums all recorded stages. Vex cost is measured separately and never enters routing optimization. Compare quality-passing pairs for policy decisions, and report all-attempt cost, failures, latency, and raw tokens separately; mark cost unknown when usage was not reported.

Runs are sequential and consume Codex account allowance. They use the existing Codex login. The baseline disables MCP servers; routed arms may call Vex, and those agent-initiated calls are counted separately from Pace routing calls. A repository under test can still invoke installed programs through shell commands. Review raw event logs before sharing them because they may contain source text or command output.
