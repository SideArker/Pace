# Routing benchmark, 2026-09-26

This benchmark uses identical literal prompts and Git snapshot `2fad436` within each comparison. Every arm has a fresh clone and Codex thread. Two repetitions alternate arm order. The three arms are Sol High, a Vex-routed single agent, and a Vex-routed Luna scout plus completion. Workflow shape is fixed per arm; Vex chooses the model and effort for each Codex stage. The separate live shape probes at the end test the first routing choice.

Costs below are estimated Standard API equivalents, not billed Codex amounts. Prices use the [OpenAI snapshot](https://developers.openai.com/api/docs/pricing) checked 2026-09-26 and assume short-context processing. Each result manifest stores that snapshot. Ordinary input is `input - cached - cache-write`; output already includes reasoning. Vex cost is measured separately and never used to optimize routes.

| Task, two repetitions | Arm | Rubric pass | Estimated Codex cost | Raw tokens | Elapsed | Stage routes |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| `project-path` | Sol High | 2/2 | $0.081652 | 102,299 | 40.2 s | Sol High |
| `project-path` | Routed single | 2/2 | $0.088822 | 99,948 | 34.9 s | Sol Low |
| `project-path` | Routed split | 2/2 | $0.037891 | 185,625 | 69.4 s | Luna Low, Sol Low |
| `usage-trace` | Sol High | 2/2 | $0.269418 | 367,758 | 125.1 s | Sol High |
| `usage-trace` | Routed single | 2/2 | $0.171279 | 315,022 | 87.2 s | Sol Low |
| `usage-trace` | Routed split | 2/2 | $0.115860 | 272,978 | 113.6 s | Luna Low, Sol Low |
| `doctor-json` | Sol High | 2/2 | $0.555008 | 1,228,189 | 433.8 s | Sol High |
| `doctor-json` | Routed single | 2/2 | $0.485181 | 1,002,324 | 387.2 s | Sol Medium |
| `doctor-json` | Routed split | 2/2 | $0.381961 | 838,116 | 358.7 s | Luna Low, Sol High |

`project-path` passed when answers named `normalizeProject` in `src/core/sessions.ts` and explained lowercase Windows paths; all six did so, with clean Git status. Its split workflow saved 53.6% cost but took 72.6% more time and used more raw tokens. The routed single agent cost 8.8% more than Sol High across the two repetitions. `usage-trace` passed when answers identified the SDK `turn.completed` usage, the field-by-field Luna scan aggregation, and the saved session summary. Review found those points in all six answers; Git status stayed clean. `doctor-json` passed when one parseable JSON object covered all existing checks, including Vex and Codex SDK, while text output remained usable. All six coding diffs included a focused test and passed `npm run build` and `npm test`. Review found the requested behavior in every diff. The split coding workflow saved 31.2% estimated Codex cost and 17.3% elapsed time relative to Sol High across both repetitions. One single-agent coding repetition cost 3.7% more than its baseline; the second cost less. The split workflow saved cost in each coding repetition.

| Task, two repetitions | Arm | Input | Cached input | Cache write input | Output | Pace Vex calls | Agent Vex calls | Vex cost |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `project-path` | Sol High | 101,424 | 72,192 | 0 | 875 | 0 | 0 | $0 |
| `project-path` | Routed single | 99,461 | 63,872 | 0 | 487 | 2 | 0 | $0.000099 |
| `project-path` | Routed split | 184,350 | 153,344 | 0 | 1,275 | 4 | 0 | $0.000202 |
| `usage-trace` | Sol High | 363,409 | 278,272 | 0 | 4,349 | 0 | 0 | $0 |
| `usage-trace` | Routed single | 312,406 | 266,496 | 0 | 2,616 | 2 | 0 | $0.000100 |
| `usage-trace` | Routed split | 269,581 | 198,784 | 0 | 3,397 | 4 | 0 | $0.000205 |
| `doctor-json` | Sol High | 1,211,297 | 1,131,392 | 0 | 16,892 | 0 | 0 | $0 |
| `doctor-json` | Routed single | 987,259 | 911,104 | 0 | 15,065 | 2 | 0 | $0.000101 |
| `doctor-json` | Routed split | 824,326 | 733,824 | 0 | 13,790 | 4 | 0 | $0.000186 |

No routing abstentions, retries, or agent-initiated Vex calls occurred in these matched runs. The benchmark fixes workflow shape, so the Pace Vex call counts cover stage routing only. Raw `run.json`, SDK events, checks, and diffs are in ignored result directories `2026-09-26T16-32-31-497Z`, `2026-09-26T16-04-08-083Z`, and `2026-09-26T16-09-58-119Z`. An interrupted lookup run was excluded before this complete rerun.

After tuning descriptions against all three tasks, separate live Vex shape calls chose scout for each repository task and single for a plan-only payment-system request. These calls did not execute Codex. Across these tasks, the split workflow matched Sol High quality and reduced estimated Codex cost in each repeated pair. The evidence supports this guidance for these tasks; broader task sets remain needed before claiming general savings. Time is a separate tradeoff: the short lookup's split route was slower.
