# Initial benchmark results

All results below used the same literal prompt and Git commit (`2fad436`) within each pair. Each arm had a fresh clone and Codex thread. Raw run records, event streams, Vex stats, and diffs are under the ignored `benchmark/results/` directory.

Result directories: `usage-trace` → `2026-09-26T11-54-25-817Z`; `doctor-json` → `2026-09-26T11-58-03-584Z`; repeated `project-path` → `2026-09-26T12-14-44-124Z`.

| Case | Baseline: Sol High | Pace | Pace route | Result |
| --- | ---: | ---: | --- | --- |
| `usage-trace` (one pair) | 118,757 | 241,010 | Luna Low scan, then Sol High | Pace used 102.9% more Codex tokens; both answers correctly traced the code. |
| `doctor-json` (one pair) | 391,149 | 931,876 | Sol High after Vex abstained | Pace used 138.2% more Codex tokens; both builds and test suites passed. |
| `project-path` (three repeated pairs) | 149,557 | 148,397 | Luna Low | Pace saved 1,160 Codex tokens, or 0.8%; all six answers identified the right function. |

The first one-off `project-path` pair saved 27.2%, but that did not hold across the three repeated pairs. The repeated result is the better estimate for this short lookup. The `usage-trace` prompt included “Do not change files”; Pace's current keyword router treated `change` as an implementation signal and added a Luna scan before a Sol High turn. This is part of the measured behavior, and it explains much of that pair's extra usage.

The `doctor-json` route made one Vex decision call: 631 input tokens, 52 output tokens, and $0.000026502 recorded cost. Vex abstained, so Pace used its Sol High fallback. Neither valid substantive case showed a Codex-initiated Vex MCP call. Raw Codex input counts include cached tokens, and output counts include reasoning tokens; the table uses input plus output once. Cached input was a large share of these runs.

These are exploratory measurements, not a claim about overall Pace savings. The cases cover only one repository and were run while the harness was being refined. The `project-path` repetitions used the final authentication and trust setup; the two single-pair cases used an earlier isolated Codex home. Results from those harness revisions should not be pooled into one headline percentage. A Vex-specific prompt was excluded after the baseline agent found and invoked the Vex package through the repository dependency, contaminating the no-Vex arm. The harness now flags such baseline shell activity and excludes the pair.

For a stable overall estimate, curate a larger set of independent tasks, run at least three paired repetitions per task, grade the diffs against each task's rubric, and compare success as well as usage. Include both lookup and coding tasks: routing to Luna did not substantially reduce *raw token counts* on the repeated short lookup, while the Sol High coding case consumed substantially more tokens under Pace in its single trial.
