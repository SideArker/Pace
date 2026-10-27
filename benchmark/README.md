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

Routing, executed workflows, task-control, context-quality, thread-switch and context-models share `src/entrypoints/benchmark-provenance.ts`. Manifests record the actual checkout commit, dirty state, Node version, a sorted `sourceHashes` map and its `sourceSha256`. The conservative source set includes all of `src/`, benchmark drivers, skills, the lockfile, shipped prompts and version catalog. `benchmark/results/` and `benchmark/reports/` are excluded. Compiled drivers also hash `dist/`, so a stale build has its own identity. External suites and editable routing profiles retain their separate fingerprints; the routing manifest also records its effective prompts. Hashes identify local bytes, not remote model revisions or unavailable historical artifacts.

Task-control reads the baseline revision from `--baseline-dir` and fingerprints its actual `dist/` and assets. The baseline arm uses that controller and its shipped prompts with the candidate store, runner and Vex client; `baselineScope` records this boundary. Rebuild the baseline checkout before a new comparison if it is intended to represent its source revision.

The strict routing prompt parser validates the current active schema. The file loader fills absent active sections, fields and choices from the shipped defaults in memory, preserving custom settings and the original file bytes. Explicit invalid values and unknown choices still report errors. Retired workflow options are discarded without mapping them to active actions; the old task-relation request, unused plan-handoff fields and historical default-file hashes have been removed.

For local persistence profiling without model calls, run `node --expose-gc --import tsx benchmark/session-persistence.ts 12`. It uses disposable synthetic sessions, checks concurrent main/side writes, prints JSON metrics, and cleans up its files. See [the before/after measurement](../docs/session-persistence-2026-10-22.md).

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

The output records every setup, checkpoint, compaction, and follow-up step, including duration, usage, estimated cost, failures, check output, and diffs. `summary.json` includes every attempted arm. Inspect each `run.json` and `diff.patch` against its rubric, then report task pass rates and critical lost-context errors with cost across all attempts. A passing check alone does not establish quality. Do not introduce new automatic context policies until separate evidence and a user decision support them. Existing production checkpoint triggers remain 16 turns / 75% with the main route as author; this benchmark does not validate or disable them.

The first coding comparison and its limitations are in [the 2026-09-29 context quality report](reports/context-quality-2026-09-29.md).

## Reading cost and safety limits

Codex dollar values are **estimated Standard API equivalents**, since actual account billing is unavailable to the SDK. Stage cost uses its own model's ordinary, cached, cache-write, and output rates; reasoning output is already in output. Workflow cost sums all recorded stages. Vex cost is measured separately and never enters routing optimization. Compare quality-passing pairs for policy decisions, and report all-attempt cost, failures, latency, and raw tokens separately; mark cost unknown when usage was not reported.

Runs are sequential and consume Codex account allowance. They use the existing Codex login. The baseline disables MCP servers; routed arms may call Vex, and those agent-initiated calls are counted separately from Pace routing calls. A repository under test can still invoke installed programs through shell commands. Review raw event logs before sharing them because they may contain source text or command output.

## Durable task control

`npm run benchmark:task-control -- --baseline-dir <built-baseline-checkout> --out <new-directory>` compares the frozen bilingual task cases through the production controller and corrected App Server runner. It saves every inference, answer, check, decision and Vex cost separately. Seeded prior exchanges leave full historical task cost unknown. The routing-only CLI also uses the production `Orchestrator.turn`; its simulated answers do not grade task quality.

See [the 22 October task workflow evaluation](../docs/task-workflow-evaluation-2026-10-22.md) for the paired run, separately retained quality failure and correction, bilingual paraphrase probe, and evidence limits.

## 6. Context and model continuation study (2026-10-20)

The extended study is available through both existing entry points. It uses the
production App Server transport directly from TypeScript source, independent
fixtures and initial threads, fixed Sol Medium/Luna Low routes, and two coding
follow-ups after each intervention. Production routing is unchanged.

```bash
npm run benchmark:context-quality -- --study --help
npm run benchmark:thread-switch -- --study --phase pilot --list
npm run benchmark:context-quality -- --study --phase pilot --out benchmark/results/my-context-model-pilot
```

The pilot contains 16 scenario executions, 83 model turns and two native
compactions, plus at most four checkpoint-repair turns. Family A compares four
context strategies. Family B compares Sol-only, Luna in the main thread, and a
separate Luna side answer using the current `/btw` prompt format. Family C compares
Sol and Luna checkpoint authors before an identical fresh Sol continuation.

The preregistered matrix, quality criteria and selection rule are in
[`protocol/context-models-2026-10-20.md`](protocol/context-models-2026-10-20.md).
After reviewing the pilot, freeze the implementation and explicitly select one
comparison per family for the two held-out cases, for example:

```bash
npm run benchmark:context-quality -- --study --phase confirmation --family A --variants resume,fresh_checkpoint --repeat 3 --out benchmark/results/my-context-confirmation-A
npm run benchmark:thread-switch -- --study --phase confirmation --family B --variants sol,luna_main --repeat 3 --out benchmark/results/my-context-confirmation-B
npm run benchmark:context-quality -- --study --phase confirmation --family C --variants checkpoint_sol,checkpoint_luna --repeat 3 --out benchmark/results/my-context-confirmation-C
```

These are command examples, not predetermined winning variants. Each output
folder must be new. `--case`, `--suite`, and `--timeout-minutes` restrict runs.
The list mode never starts a model. `context-models-probe.ts OUTPUT_DIRECTORY`
checks actual model access and multi-request usage aggregation. Raw JSON-RPC,
requested and observed models/efforts, thread transitions, prompts, responses,
usage categories, durations, diffs, final files, and external checks are saved.
Neutral-ID review bundles are under `blind/`; automated checks do not constitute
manual quality grades. Missing usage remains unknown. Cache-write uncertainty,
if present, is explicit rather than silently reported as zero.

```bash
python3 benchmark/context-models-analyze.py benchmark/results/context-models-2026-10-20
```

The analyzer writes `analysis.json` and includes failed and partial attempts.
It does not grade quality or select policy. Existing non-study benchmark flags
and behavior remain available.

The 2026-10-21 audit found that resumed usage can arrive after `turn/start`.
The study now attributes usage to the active **turn ID**, then sums distinct
request updates. Native compaction's zero billing placeholders remain unknown.
For older captured runs, preserve the originals and create derived accounting:

```bash
./node_modules/.bin/tsx benchmark/context-models-reaccount.ts benchmark/results/context-models-2026-10-20
python3 benchmark/context-models-summarize.py benchmark/results/context-models-2026-10-20
```

The summarizer joins explicit manual `grades.json` files and emits
`graded-summary.json` plus `stages.csv`. It reports both monotonic stage duration
and UTC duration; clock discrepancies must be disclosed, not silently removed.
It does not generate quality grades.

If a benchmark process is interrupted, first check whether it is still running.
The continuation supervisor verifies every frozen source hash and the copied
suite, preserves original repetition/order, and starts only unfinished keys in
a new output directory:

```bash
./node_modules/.bin/tsx benchmark/context-models-continue.ts ORIGINAL_RESULTS NEW_RESULTS
```

Keep the interrupted attempt and its partial usage in the all-attempt audit.
After a usage-limit stop, respect the limit and wait for a new authorized
continuation; do not substitute another model or retry in a loop.

## Benchmark Center (debug checkouts)

`/benchmark` and `pace benchmark` open the same Ink panel. Select Run, a category
and a named profile, review the call/time limits and estimated-cost scope, then
choose **Start**. Preview, list, result browsing and grading never start models.
The panel accepts arrows, Enter and Esc. Esc during execution cancels only that
benchmark. Results remain accessible while Pace has active jobs; Start requires
main/side/title jobs, shells, queues and deferred work to finish (and the remote
host to stop). The normal conversation and its model configuration are unchanged.

```bash
npm run dev -- benchmark --help
npm run dev -- benchmark list
npm run dev -- benchmark run routing --profile quick --preview
npm run dev -- benchmark run diagnostics --profile quick
npm run dev -- benchmark run workflows --profile validation --max-turns 150 --max-usd 5
npm run dev -- benchmark results
npm run dev -- benchmark results RUN_ID --files
npm run dev -- benchmark resume RUN_ID --preview
npm run dev -- benchmark resume RUN_ID
```

A headless `run` requires a category and `--profile`; it is an explicit Start.
Unknown or inapplicable options fail preflight. Installed npm builds reject the
command and execution services before opening a backend, downloading or calling a
model. Debug continues to mean a checkout outside `node_modules/@sidearker/pace`;
it is not a security sandbox.

| Category | Profiles | Measurement boundary |
| --- | --- | --- |
| routing | quick, standard, holdout, shape-only | Production controller/validator, real Vex, simulated Codex reports |
| workflows | quick, standard, validation, agentic | Original arms, resolved Git commits, alternating order, checks and manual rubric |
| task-control | quick, standard, paraphrases | Candidate-only by default; select a built baseline for an explicit comparison |
| context-quality | quick, standard, real-repo | Original four context strategies with independent setup per arm |
| thread-switch | quick, standard | Shared setup, fresh/same thread switch turns; setup remains separately recorded |
| context-models | quick, standard, confirmation-A, confirmation-B, probe | Original pilot matrix and preregistered selected confirmation pairs |
| diagnostics | quick, standard | Synthetic persistence, GC and process metrics; no model/account |
| memory | unavailable | Requires integration in plan 02 |

Quick and Standard retain each family's methodology. For context/model study both
execute the complete preregistered pilot; Quick does not silently truncate its
matrix. Confirmation requires `--source RUN_ID` pointing to a completed frozen
pilot with passing execution, context/note reviews and fixture checks for the selected pair; source, suite and review-evidence hashes must still match. No family C recommendation was
selected by the original protocol, so no automatic confirmation-C profile is
invented. Task-control's baseline wizard discovers sibling built checkouts, accepts
another built checkout, or offers candidate-only. It does not create branches or
worktrees. `baselineScope` still means baseline controller/shipped prompts with
candidate store, runner and Vex client shared.

Each run gets a new ID under the checkout's `benchmark/results/`, independent of
caller cwd. `center-manifest.json` records schema/profile versions, effective
configuration and prompts, prices, source/build and fixture hashes, resolved
commits and ordered trial keys. `events.jsonl`, partial `accounting.json` and
`state.json` preserve progress, failures and unknown usage. `segment-N/` contains
the original family artifact format. The all-attempt ledger includes errors and
uncertain interrupted calls; family comparisons include only compatible,
quality-passing pairs. Vex and Codex are separate. Dollars are Standard API
equivalents, not subscription allowance or account billing. A dollar threshold
stops subsequent calls after reported cost reaches it; missing cost stays unknown
and the current call can exceed the threshold. Call limits include Vex and native
compaction operations as well as Codex turns. Internal model requests within a turn are not separately capped. The per-turn/decision timeout is enforced by benchmark transports.

Resume checks source/config/fixture identity and resource ownership. It skips
completed trial keys. A failed or uncertain trial restarts from an independent
fixture/thread in a new segment, retaining its earlier calls and costs. Completed
artifacts are not overwritten. Changing sources, baseline build, suite, model
settings, prompts or budgets requires a new run. Locks include host/PID/start
identity and worker ownership; an active worker prevents crash recovery. Child
processes are owned by a separate process group on Unix (a process tree on Windows)
and disposable fixtures live in run-scoped scratch directories. Losing the supervisor cancels its worker; orphaned work is stopped and the run remains resumable. Run locks also serialize review and derived-analysis writes. A recovery interrupted while claiming a stale lock reports its marker for inspection instead of guessing ownership.

Results provides raw answers, diffs, checks, usage and family summaries. Review
records a manual decision, context/summary/checkpoint assessments where applicable,
notes, severity (minor/major/critical), evidence and affected behavior. Checks and
manual quality remain separate. Workflow grading retains original prompt/commit
identity validation and its quality-passing pair report. Historical files stay
readable, with their version or an unknown-format limitation; unknown formats do
not receive a fabricated importer or score. The last selections are saved atomically
to `~/.pace/benchmark-center.json`, separate from versioned profiles and model config.

For compatible context/model results the result menu and CLI expose:

```bash
npm run dev -- benchmark analyze RUN_ID
npm run dev -- benchmark summarize RUN_ID
npm run dev -- benchmark reaccount RUN_ID
```

Python 3 is checked before analyze/summarize. Its absence leaves raw results and
review intact. Reaccount writes a separately labeled `accounting-corrected.json`
using the study's recorded price protocol; it preserves `run.json` and refuses to
overwrite an existing correction. A missing or changed recorded price protocol is refused. Original accounting is never replaced by new
catalog prices. Raw study summaries retain within-family variation; they do not
combine families into one universal score.

### Pinned external project datasets

Existing checkout fixtures remain the default. No public dataset URL is assumed.
For workflows, the preview wizard or `--dataset MANIFEST.json` can select:

```json
{
  "version": 1,
  "repository": "https://example.invalid/your-dataset.git",
  "commit": "0123456789abcdef0123456789abcdef01234567",
  "project": "projects/example",
  "scenariosVersion": "v1",
  "checksums": {"host-only/grader.js": "<64-character SHA-256>"}
}
```

Supply your actual repository, full SHA and checksums. HTTPS must not contain
credentials; file URLs support local integration tests. Git downloads to a staged
cache under `~/.cache/pace/benchmark-datasets`, verifies the pinned commit and
checksums, rejects traversal/symlinks/submodules, exports only the selected project,
then publishes the cache atomically. Every cache reuse verifies its content;
`--offline` accepts only an already verified entry. Corrupt cache is an error and
must be removed explicitly before refetching. A trial gets a separate Git repository
with only that project and a new initial commit, without origin or source Git objects.
Host-only memory/graders are excluded from the agent workspace. Download and
preparation events are recorded separately from inference.

The current runners **do not enforce filesystem/network isolation** against the
host's files and remote repository. Consequently every available run is labeled
uncontrolled and `--controlled` fails before downloading or inference, with the
specific missing-isolation reason. Exporting a project and pinning its SHA do not
prove OS isolation. Memory generation, its dataset publication and A/B integration
belong to plan 02.

### Testing Benchmark Center

```bash
npm run build
npm run benchmark:check
npm test -- tests/benchmark-*.test.* benchmark/grading/grade.test.ts tests/build-mode.test.ts tests/app-composition.test.tsx
```

The suites use fake model transports, disposable Git repositories and synthetic
sessions. They cover CLI/panel parity, execution and cancellation, crash recovery,
frozen resume, accounting, grading, dataset verification and debug gates. CLI
regressions also check strict arguments, read-only commands, exit codes and signal
handler cleanup. Storage tests reject private artifact paths and ambiguous lock
recovery; preference tests use a temporary home and preserve the user config.
These tests make no paid model calls and do not establish model quality or OS
isolation. Run `npm test` for the full application regression suite.
