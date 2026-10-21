# Task workflow evaluation — 22 October 2026

Implemented the durable controller and exercised actual Vex decisions separately from the earlier fixed-route context benchmark. This is a bounded development evaluation, not evidence of general quality improvement or guaranteed savings.

## Protocol and provenance

The frozen fixture contains CSV serialization, a queue that drops operation metadata, a report that collapses unknown cost to zero, and one basic test. Seven cases cover open analysis, an unfulfilled implementation, a short follow-up, a planner correction after a completed scout, a new task, an independent side question, and full analysis coverage. Four development cases and three holdout cases were labelled before execution; English and Polish are both represented. No model or prompt-profile tuning followed the holdout.

Both arms use the same literal case request, fixture, and model configuration: Luna Low and Sol 6.1 Medium/High. The baseline controller and its shipped prompts come from `f967efb48ef73a52d8f0273751a9864bae39f7a2`. Both arms use the corrected production App Server runner, so the baseline does not inherit the old usage-attribution defect. Each case alternates which arm runs first. Calls are sequential.

The candidate was loaded from edited code above commit `688430f`; its source hash, rather than that commit alone, identifies the tested snapshot. Later changes to role isolation, queue recipients, history transactions, stage metadata and audit records are covered by the final automated checks. The post-hoc repair uses core code committed through `60b60b2`. This is not a claim that every final source byte had a second live paired run.

Frozen hashes:

- Suite: `c5af31dd7e60778440c07a35756276f45f4db3ae6b1e75af1ced3d96ce3fb14c`.
- Fixture: `939fab7f2c84b8030555467fee6fd309caadcbc8c7eb0375a774d8f6a9f83e1d`.
- Initial candidate source: `77f069d9dbaf51ff612105c47f0213e0b60953b41b121593f59f3674f21d2f03`.

Prior exchanges and workflow state are synthetic seeds. Their historical inference cost is unknown. Reported dollars cover all actual calls from the evaluated request onward, including the separately retained correction. They do not establish full historical task cost or Codex subscription usage. The price source and rates are in the manifest. Codex/App Server is the installed pinned 0.160.0 package; backend weight revisions are unavailable.

## Outcomes

| Case | Candidate control | Initial outcome | Baseline Codex subtotal | Initial candidate subtotal |
| --- | --- | --- | ---: | ---: |
| Open analysis, EN | continue | Technical checks pass; factual error, Vex partial | $0.078329 | $0.002381 |
| Unfulfilled CSV implementation, PL | continue | External edge-case assertions and review pass | $0.036735 | $0.003126 |
| Short follow-up, EN | continue | Correct example, preserved lead | $0.001624 | $0.001626 |
| Planner correction, PL | continue | Updated saved plan; no repeated scout or source edits | $0.088160 | $0.082599 |
| New goal, EN | replace | Queue metadata survives JSON round trip | $0.003167 | $0.057771 |
| Independent aside, PL | aside | Main ownership preserved | $0.049022 | $0.000514 |
| Full analysis coverage, EN | continue | All modules covered; limits disclosed | $0.074938 | $0.002416 |

All 14 initial invocations passed their scripted technical assertions. Reviewing the actual answers found a factual error in the first candidate analysis: `enqueue(queue, undefined)` throws rather than appending undefined; an object without `text` appends undefined. Its task assessment was `partial`, not complete. Initial candidate quality therefore passed 6/7 cases; baseline passed 7/7 under this review. Review was performed by the implementation agent, without independence or blinding.

The initial failed-quality result remains in `grades.json` and its original run. One explicitly recorded, post-hoc development correction reproduced the distinction, inspected the root test file, ran validation, and received `closed`. It cost another approximately $0.001134 in Codex inference and 19.594 seconds. No earlier attempt was deleted or relabelled as an initial pass. Final completion required eight candidate Codex invocations versus seven baseline invocations.

Observed Codex subtotals were $0.331976 baseline and $0.150434 initial candidate; the candidate subtotal including correction was $0.151568. The new-goal case was materially more expensive on the candidate. Those values are descriptive measurements on a tiny fixture with seeded history; they are not a savings estimate for real tasks, and do not establish successful escalation on a difficult unresolved repository investigation.

Vex is separate: baseline 21 calls, $0.00104496 reported provider cost, 8.704 seconds; initial candidate 16 calls, $0.002600388, 13.618 seconds; correction adds two calls, $0.000626724, 2.236 seconds. Assessment and richer evidence incur real overhead. All initial calls and the correction have usable attributed Codex usage; there were no discarded infrastructure failures in this run.

A separate frozen bilingual paraphrase probe ran the production controller on 14 requests. All 14 selected the expected action and acceptable workflow; 16 real Vex calls, no errors. Its Codex outputs are simulated and it stops before inference. It validates control decisions only, not implementation or final-answer quality. A production-controller smoke case also selected `single` successfully.

## Artifacts and limits

Local ignored raw results:

- `benchmark/results/task-control-2026-10-22/`: manifest, every answer, session snapshot, diff, event log, attempt accounting, Vex statistics, summary, grades, and the separate repair.
- `benchmark/results/task-control-paraphrases-2026-10-22/`: production-controller manifest, per-request decisions and summary.
- `benchmark/results/production-control-smoke-2026-10-22/`: routing CLI smoke check.

Run the executed evaluation with `npm run benchmark:task-control -- --baseline-dir <built-f967efb-checkout> --out <new-directory>`. It consumes actual model allowance. The baseline checkout was made under `/tmp`, without resetting the user's checkout. See `benchmark/suites/task-control.json` for the frozen cases. The bilingual probe uses `task-control-paraphrases.json` and the model configuration copied from the executed evaluation manifest.

This evaluation does not validate context thresholds, checkpoint authorship, native-compaction full cost, parallel latency, long histories, or general model capability profiles. The earlier October context report was read; its historical raw worktree was unavailable and was not recomputed. No new automatic context migration was introduced. Checkpoints still use 16 turns / 75% and the main route as author, with auxiliary-role isolation.
