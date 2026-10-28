# Fresh completion after a real scout

Fresh completion compares an existing Codex thread against a fresh completion thread after an identical real scout report. Memory is a separate profile family in the same runner and panel, described below. Neither experiment changes production routing automatically.

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

## Memory

`/memory` is a normal product command; `/benchmark` remains checkout-only. Memory uses the production App Server, adapter, role enforcement, prompts and policy. The retired SDK path and benchmark families are not recreated.

For authoring, freezing and sharing datasets, see [Creating and publishing memory datasets](../docs/memory-datasets.md). It covers direct GitHub distribution and the Supabase Storage bundle/restore workflow supported by the current Git-based downloader.

```sh
npm run benchmark -- run memory --profile prepare --preview
npm run benchmark -- run memory --profile prepare --max-usd 2
npm run benchmark -- run memory --profile quick --preview
npm run benchmark -- run memory --profile quick
npm run benchmark -- run memory --profile standard --preview
npm run benchmark -- run memory --profile confirm --repeats 7 --preview
npm run benchmark -- run memory --profile full-cycle --preview
```

Preparation runs three earlier tasks through Pace, then freezes confirmed linked notes and source sessions into `../pace-memory-dataset`. Future prompts, graders and expected answers remain in Pace's evaluator suite, outside agent access. A failed preparation preserves its accounting and remains unconfigured; it does not fabricate a seed. Existing dataset directories are never replaced. `benchmark/memory/dataset.json` pins the full Git commit and export checksum only after successful preparation. Publication requires the user's owner/URL and public/private choice. `remote: null` is intentional until then. `PACE_MEMORY_EXECUTABLE` can select a validated pinned installation without changing the user's project configuration.

The Linux pilot requires bubblewrap and Codex named permission profiles. Model transport retains authenticated host routing; agent commands have only minimal runtime reads and their assigned project copy. Before every agent invocation, real non-model `command/exec` probes verify host/auth/symlink denial, workspace writes, network isolation and historical read-only permissions. Git extraction/grading run in separate networkless bubblewrap processes. Agents receive a new project-only Git history, never the dataset's Git history or preparation transcripts. Unsupported enforcement fails before a model call. Basic Memory uses a new isolated project, and B imports a fresh snapshot for every seeded repetition; A has no memory process or snapshot.

Quick is one pair (two calls). Standard is six scenarios × three repetitions × two arms (36 calls). Confirm uses a separate frozen holdout and requires a repetition count selected before Start, based on pilot variance. `full-cycle` is a distinct experiment: three earlier tasks in each arm, then six different future tasks in fresh sessions (18 calls). Start/CLI consume allowance; preview does not. No larger experiment is started implicitly after a smoke run.

Review answer, diff, tests and external checks. Record quality, severity, affected behavior and evidence. Continuity tasks are reported separately from equal-information tasks. Reports retain failed and unknown usage, historical preparation, import time, current usage/cache/model cost, backend operations and whole-cycle model accounting. Amortization uses distinct future tasks rather than repetition count. Backend/indexing billing remains unknown and prevents a complete savings claim. The independent holdout must not be used for tuning. One pair cannot establish general benefit.

```sh
npm test -- tests/benchmark-*.test.*
npm run benchmark:check
npm run build
```
