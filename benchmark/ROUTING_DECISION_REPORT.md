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

## Later calibration, still exploratory

The fixed Luna Low arm exposed a model choice missed by earlier routing guidance. In three direct-answer tasks and two repository lookups, Luna Low answers met the manual rubrics and left Git clean. Its estimated Codex cost was 94.9–97.9% below the matched Sol High runs. These are one repetition per task, so the range describes observed pairs rather than an expected savings rate. The first two lookup prompts also showed that Luna single cost less than Luna scout plus completion.

Stage guidance now describes Luna as suitable for direct factual work and clarifies that Sol High is a quality target, not a required model. In a subsequent 60-case route-only run, Vex chose Luna Low for all ten direct completions and Sol Medium or High for all ten implementation completions. Workflow descriptions now compare a focused Luna lookup in one stage against both scout stages. A later 60-case shape-only run chose single for all ten repository lookups and plan + execute for four large implementation prompts. No Codex work ran in those route-only sweeps, and the development labels were used while tuning. The 24-case holdout remains unrun.

Two executed pairs with both updated prompts checked the end-to-end behavior. On `direct-token-price`, auto chose single Luna Low, answered correctly, and cost $0.000421 versus $0.011625 for Sol High, a 96.4% saving. On `lookup-project-key`, auto chose single Luna Low, met the repository rubric, and cost $0.001448 versus $0.026378, a 94.5% saving. Forced split cost $0.000996 and $0.002285 respectively, more than auto in both cases. Result directories: `benchmark/results/2026-09-26T17-45-15-244Z` and `benchmark/results/2026-09-26T17-46-19-464Z`.

One implementation pair illustrates why cost alone is insufficient. For `build-duplicate-efforts`, auto chose single Sol Medium and cost $0.094702 versus $0.126820 for Sol High, a 25.3% saving. Both diffs preserved the parser's copy-on-parse behavior. Forced Luna scout plus Luna completion cost $0.004735 and passed build/tests, but its diff returned the input effort array directly, changing that behavior. Manual review marked this arm as a quality failure. The validation prompt and rubric now state the preservation requirement explicitly. Raw graded result: `benchmark/results/2026-09-26T17-37-26-678Z`.

The final guidance is promising on these reviewed tasks, but not locked. Run the untouched holdout and repeated executed suite before claiming regular savings. Review code changes beyond green tests; that review caught the cheapest implementation arm's regression.

## Scout report transfer

A later forced-scout lookup validated the report boundary. The Luna scout ran in a fresh read-only thread and returned a structured report with five file findings, line references, checks, and risks. Pace saved the validated report in the scout stage record and passed only that report to the main Luna agent. The main answer met the `lookup-project-key` rubric; no files changed. Raw result: `benchmark/results/2026-09-26T18-21-10-365Z`. This checks report transfer and answer quality for one lookup. It does not prove every scout finding is correct or that a split workflow is cheaper than one Luna agent.
