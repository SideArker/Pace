# Pace benchmark

## Routing decisions

Run the route-only suite before changing workflow guidance:

```powershell
npm run benchmark:routing -- --suite benchmark/routing-suite.json --repeat 3
```

This calls Vex without starting Codex agents. The development suite contains 60 labeled requests across direct answers, repository lookups, implementation, plan-only requests, missing context, and requests resolved by recent conversation. Three repetitions yield 180 workflow choices; stage routing adds calls for non-clarification choices. Use `--case <id>` for one case, `--shape-only` to omit stage choices, or `--out <new-directory>` to choose a result path. Every run writes `runs.jsonl` as it goes, plus `summary.json`, `manifest.json`, and Vex statistics in an ignored results directory. Output directories must be new, so separate runs cannot mix results.

`acceptable` labels encode intent constraints and plausible workflows. `preferred` is a **hypothesis** about cost and quality, not ground truth. A single or scout route can both be acceptable for many repository tasks; only an executed paired benchmark can establish which costs less at equal quality. The suite uses a fixed, simulated report for second-stage routing and records that limitation in the manifest. Only the executed benchmark tests the scout's real report. Inspect per-case choices, probabilities, route pairs, failures, retries, time, and Vex cost. After tuning on the development suite, run the separate 24-case holdout once with `--suite benchmark/routing-holdout.json --repeat 3`. Do not tune on holdout results and report them as independent validation.

For more regular savings, tune guidance only when repeated routing errors point to a clear cause, then run this suite and the executed benchmark below. Require valid routes and plan-only intent compliance on every case. Compare **measured Codex cost among quality-passing runs** for single versus scout versus Sol High, including both stages and latency. Never infer a Codex savings percentage from this route-only suite or from Vex's probabilities alone.

## Executed workflow comparison

The benchmark compares three workflows on the **same literal prompt** and repository commit: plain Sol High, Vex-routed single agent, and Vex-routed scout plus completion. Each arm starts in a fresh Git clone and thread. The order alternates on repeated runs. The benchmark fixes workflow shape so each shape gets measured; Vex still routes every Codex stage. Codex can call Vex in routed arms.

Run the pilot from the Pace checkout:

```powershell
npm run benchmark -- --suite benchmark/pilot.json --repeat 1
```

Add `--include-auto` to execute Pace's actual Vex-selected workflow alongside the three fixed arms. Add `--include-luna` to execute a fixed Luna Low single-agent arm and check whether Vex missed a cheaper quality-passing model. `summary.json` then includes `autoMatched` and `lunaMatched` pairs with routes, cost, usage, and time against Sol High. Review each result and diff against the rubric before treating a pair as quality-passing. A route-only pass cannot substitute for this check.

For broader executed evidence, use the 12-case validation suite. It spans direct answers, repository lookups, plan-only requests, and implementation, all on fixed Git commit `2fad436`:

```powershell
npm run benchmark -- --suite benchmark/validation.json --repeat 3 --include-auto --include-luna
python benchmark/grade.py prepare <results-directory>
```

Review each `run.json` answer, `diff.patch`, and check result. Set every `pass` field in `grades.json` to `true` or `false`, then run:

```powershell
python benchmark/grade.py report <results-directory>
```

`graded-summary.json` compares only pairs where both arms passed manual review and checks. It reports cost wins and regressions, aggregate and median savings, raw and cached tokens, time, selected shapes and routes, and Vex calls and cost separately. The helper refuses incomplete grades and does not overwrite existing grades. Twelve cases, three repetitions, and four arms mean 144 Codex runs; adding `--include-luna` makes 180. Use `--case <id>` for a smaller first pass.

Use `--case usage-trace` for one case, `--repeat 3` for repeated pairs, `--timeout-minutes 12` for a per-run limit, and `--out <directory>` to choose a result directory. Results default to the ignored `benchmark/results/` directory. The suite supports a repository path relative to the invocation directory, suite or per-case Git ref, prompt, optional setup commands, optional check commands, and a review rubric. Setup and checks execute in each clone. If the source repository has `node_modules`, each clone receives a link to it so build and test commands use the same dependencies. A fixed commit is saved in the result manifest even when the suite uses `HEAD`.

Each run saves `run.json`, raw SDK `events.jsonl`, a full `diff.patch`, and Vex stats when Vex made a decision. `summary.json` reports matched triples with complete Codex usage, per-stage routes, token cache breakdown, elapsed time, estimated Standard API cost, and Vex routing and agent call counts. The result manifest embeds the price snapshot. Input tokens include cached and cache-write input; output includes reasoning. Stage cost charges each input class once, using its stage model. Vex cost stays separate and does not influence routing. Actual Codex account billing is not exposed by the SDK, so dollar amounts are API-equivalent estimates for Standard, short-context processing.

Check commands and the rubric help assess quality; passing broad build and test commands does not prove the requested behavior. Review each final answer and diff against its case rubric, record success per arm, then compare cost among successful arms. Repeat each task at least twice before changing routing guidance. A quality failure or cost regression calls for revised choice descriptions and another paired run.

The benchmark runs sequentially and may consume substantial Codex account allowance. It uses the existing Codex login and applies a per-run trust override for the temporary checkout. The baseline SDK configuration disables MCP servers. Do not mention Vex in a benchmark prompt when testing the no-Vex baseline against the Pace repository: the repository itself depends on `vex-mcp`, so an agent could invoke that package through a shell command. Do not share raw event logs without reviewing them: they can contain repository content and command output.
