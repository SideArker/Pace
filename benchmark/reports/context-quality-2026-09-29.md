# Context action coding benchmark — 2026-09-29

## Method

Two coding cases used identical fixture files, setup requests, user corrections, and two follow-up requests per arm. Each arm used `gpt-6-sol` at medium effort. The actions were: resume the existing thread; replay retained exchanges in a fresh thread; compact and resume; or generate a validated checkpoint in the original thread and pass it to a fresh thread. Each fixture ran an external behavior check. I also reviewed every completed diff against its rubric for unrelated edits and lost constraints.

The corrected-accounting runs are [export correction](../results/context-quality-2026-09-29T13-36-42-957Z/summary.json) and [copy on parse](../results/context-quality-2026-09-29T18-05-41-406Z/summary.json). Their manifests record the suite hash, source hash, Pace commit, route, and price snapshot. Costs are estimated Standard API equivalents from observed input, cached input, and output tokens, including setup, context actions, retries, and follow-ups. They are not actual Codex charges. Failed calls with no reported usage have unknown cost.

## Corrected paired results

| Action | Export correction | Copy on parse | Combined estimated cost | Combined time | Checks |
| --- | ---: | ---: | ---: | ---: | ---: |
| Resume | $0.1674 | $0.1419 | $0.3092 | 251 s | 2/2 |
| Fresh replay | $0.1701 | $0.1594 | $0.3295 | 270 s | 2/2 |
| Compact and resume | $0.1433 | $0.1480 | $0.2913 | 254 s | 2/2 |
| Fresh checkpoint | $0.1948 | $0.1512 | $0.3460 | 333 s | 2/2 |

The combined known cost of all eight corrected attempts is **$1.2761**. Relative to resume, compact and resume cost 5.8% less across these two cases, but cost 4.3% more in copy on parse. Fresh replay cost 6.6% more and fresh checkpoint 11.9% more in total. These are observations from one repetition of each case, not reliable savings estimates. The harness alternates arm order on even repetitions, but these runs had only one repetition and therefore used the same order. No holdout or Vex-selected policy was run.

All eight corrected diffs preserved the prior user correction, exact constraints, and unfinished-code intent. Export changes kept the configured caps and schedules and made archive rejection take precedence. Parser changes rejected invalid fields and unknown keys while returning independent objects on both cache hits and misses. Some arms added focused tests; the differences did not violate the rubrics. **Critical lost-context errors: 0 in 8 completed corrected attempts.**

## All-attempt audit

The exploratory development runs are retained locally under `benchmark/results/context-quality-*`. Across **22 started arm attempts**, 16 passed external checks and manual diff review, one produced an invalid checkpoint note (`complete:false`) before the follow-ups, one timed out, and four hit the Codex usage limit. Thus the raw all-attempt check pass rate is **16/22**. Among attempts that reached a completed, graded diff, it was **16/16**; neither rate estimates future reliability from this small, repeatedly tuned sample. The invalid note, timeout, and quota failures do not provide a graded lost-context result.

The earlier passing runs used a runner that undercounted turns with multiple model requests, so their dollar figures are excluded from the comparative table. A later [quota-interrupted run](../results/context-quality-2026-09-29T13-46-26-423Z/summary.json) preserved two setup costs, about $0.0417, but the failed follow-up had no usage record in that runner version; the other arms failed at setup. Consequently **total cost across all 22 attempts is unknown**, with $1.2761 measured for the eight corrected attempts and additional known or unreported development costs. The runner now retains observed usage from failed turns and stops starting new arms once a usage-limit failure occurs.

## Decision

Keep manual `/compact`, measured context, checkpoint storage, and the quality-preserving resume behavior. Do not automatically compact or start a fresh thread. The two corrected cases do not establish a stable savings advantage or a quality non-regression bound. Vex context-choice and tip shadow evaluations, including their own cost and a holdout comparison, remain gated on broader paired evidence. A valid checkpoint is stored for recovery and future evaluation; it does not trigger an automatic fresh thread.
