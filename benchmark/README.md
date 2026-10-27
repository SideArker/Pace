# Fresh completion after a real scout

This is the only active Pace benchmark. It compares completion on an existing Codex thread against a fresh completion thread after an identical real scout report. It does not change production routing or thread policy.

```sh
npm run benchmark -- list
npm run benchmark -- run fresh-completion --profile quick --preview
npm run benchmark -- run fresh-completion --profile standard --preview
npm run benchmark -- run fresh-completion --profile quick --max-turns 12 --max-usd 2
npm run benchmark -- results
```

`/benchmark` exposes the same profiles, preview, Start, results and manual review in a debug checkout. Preview/list/results do not invoke models. Quick runs three tasks once (12 calls maximum, $2 estimated API threshold); Standard runs three repetitions (36 calls maximum, $6 threshold). The per-call timeout is four minutes. Start consumes Codex allowance. The threshold stops subsequent calls; the current call may exceed it. Missing usage remains unknown. Estimates are Standard API equivalents, not account billing or subscription usage. There are no Vex decisions in this fixed-route comparison.

Each pair creates a temporary Git fixture from the versioned suite, records its exact commit and content hash, then runs one read-only history/setup turn and one real read-only scout. Both completion arms receive the same original request, validated full handoff, model/effort route and effective prompt. They run sequentially at the same workspace path, resetting the fixture between arms. Only the same-thread arm resumes the setup thread. Arm order alternates by repetition. The scout is a separate thread in both cases. The tasks cover CSV aliasing/delimiters, retry ordering/exhaustion and unsafe report keys/numeric boundaries. Standard provides repeated observations; this initial small suite does not establish general production quality or savings.

`benchmark/results/<run-id>/center-manifest.json` freezes source/config/suite/price provenance and ordered pair keys. Each segment records:

- `pair.json`: every setup/scout/completion attempt, raw scout output, prompt and handoff sizes/hashes, routes, thread IDs, usage, timings and failures.
- `scout.json`: the canonical validated report received by both arms.
- `<arm>/run.json`: actual `turn/start` input, full completion prompt, fixture/commit/verification identity, answer, final source files and external checks.
- `<arm>/diff.patch`: the complete diff, including added regression tests.

The shared runner retains all-attempt accounting, ownership locks, cancellation, source validation and immutable segments. Resume skips completed pairs; unfinished/uncertain pairs restart from a fresh fixture and preserve earlier attempts and their costs. Failed setup/scout prevents that pair's completions and remains a recorded failure. A malformed scout is a failure; this benchmark does not repair away evidence of poor handoffs. There is no filesystem/network isolation from the host; these are uncontrolled local experiments.

Review every answer, diff, added test and external check against the saved rubric. In the result UI record both task quality and context preservation, notes, severity, evidence and affected behavior. Automatic checks alone do not establish correctness. Cost comparison requires matching actual inputs, routes, thread identities, fixture/commit, request, handoff and verification hashes, passing checks and explicit manual quality/context grades. Completion cost excludes shared setup/scout, which remain in the ledger. Review failed and unknown-usage attempts separately. Do not switch production policy based on a build, fake transport test or one cheap answer.

The old routing/workflow/context/model/diagnostic experiments, their family-specific drivers/tests/docs and stored results were removed after a path/hash inventory. The unrelated steering recovery fixture now lives under `tests/fixtures/`.

```sh
npm test -- tests/benchmark-*.test.*
npm run benchmark:check
npm run build
```
