# Routing decision pilot, 2026-09-26

This is exploratory data from the 60-case development suite. Vex made 180 workflow decisions, three repetitions per case, with the final routing prompt. No Codex agents ran in this route-only sweep. The local result directory is `benchmark/results/routing-2026-09-26T16-55-53-500Z`. The 24-case holdout was created before this report and has not been run.

| Category | Single | Scout | Clarify | Plan + execute | Acceptable after label review |
| --- | ---: | ---: | ---: | ---: | ---: |
| Direct answer | 30 | 0 | 0 | 0 | 30/30 |
| Repository lookup | 3 | 27 | 0 | 0 | 30/30 |
| Implementation | 6 | 24 | 0 | 0 | 30/30 |
| Plan only | 21 | 9 | 0 | 0 | 30/30 |
| Missing context | 0 | 0 | 30 | 0 | 30/30 |
| Conversation follow-up | 26 | 0 | 4 | 0 | 29/30 |
| **Total** | **86** | **60** | **34** | **0** | **179/180** |

The original run summary says 175/180 acceptable. Four implementation labels wrongly excluded single-agent completion despite no executed evidence that single would fail or cost more. The suite now accepts single, scout, and plan + execute for those cases; re-scoring the saved choices against the corrected labels gives 179/180. Preferred-shape agreement remained 135/180. Preferred labels are cost hypotheses, not measured optimal routes.

The remaining miss was `context-05`: Vex asked for clarification in one of three repetitions of “Where is it stored?” after a discussion of token usage. It selected single in the other two. That follow-up interpretation remains unstable. There were no Vex tool errors or retries in 180 calls. Vex cost was $0.009259, recorded separately from Codex cost. This development suite was used to tune prompt wording and cannot validate that tuning independently.

The new `--include-auto` arm also completed one paired execution of `project-path`. Vex chose Luna Low scout then Sol Low completion. The answer met the lookup rubric and left Git clean. Estimated Codex cost was $0.018750 versus $0.039184 for Sol High, a 52.2% saving on this run; elapsed time was 31.5 seconds versus 28.6 seconds. The fixed single and split arms cost $0.021296 and $0.019888. This one pair checks the measurement path, not regular savings. Raw result directory: `benchmark/results/2026-09-26T16-52-35-406Z`.

A second paired smoke test used `direct-token-price` from the expanded suite. Vex chose single. All four answers gave the correct $0.00258 calculation and left Git clean. Auto cost $0.011211 versus Sol High $0.011739, a 4.5% saving; forced split cost $0.019527, a 66.3% regression. This shows why selecting split for every request would lose money. Raw result directory: `benchmark/results/2026-09-26T17-19-05-276Z`. Both smoke tests were manually graded with `benchmark/grade.py`; neither establishes a population savings rate.

Next validation: run the 24-case holdout three times, then run `--include-auto` on the 12-case executed validation suite with identical snapshots and manual quality review. Only execution can establish the cheapest quality-passing shape and stage route. These numbers do not justify always selecting split or plan + execute.
