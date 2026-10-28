# Memory implementation evidence — 2026-10-27

The user stopped further memory benchmarking after the preparation and Quick runs below had finished. No Standard, Confirm or full-cycle model runs were started. Those experiments remain for the user to run. Verification tests use mocks and non-model command probes.

## Scope and acceptance coverage

| Requested behavior | Implementation and evidence | Remaining limits |
| --- | --- | --- |
| Reuse Benchmark Center | Existing catalog, preflight, worker, control/accounting, panel, results and review were extended. `fresh-completion` remains. | The user approved adapting the obsolete plan-01 dependency. The retired families and SDK runner were not restored. |
| `/memory` setup and distinct states | Normal product command, help/autocomplete, modal composition, detection, directory choice, review, confirmation, progress, cancellation, enable/disable and repair. State/config and Ink tests cover absent/incomplete/empty/ready/disabled/unavailable. | A malformed configuration whose identity cannot be validated fails closed and requires restoring its configuration before replacement. |
| Optional installation | Explicit setup installs pinned Basic Memory into a user venv through uv, reusing compatible Python. No new npm dependency or runtime-install lifecycle hook. | Linux was exercised. Windows/macOS execution remains unverified. |
| Project and role enforcement | Separate one-project backend config, explicit routing, verified local provider config, strict dynamic tool arguments and immutable per-agent scopes. Read-only roles reject writes before connecting. Raw Basic Memory MCP detection/overrides have controlled App Server tests. | The live model runs used a clean MCP configuration. A live third-party global MCP configuration was not modified or tested. |
| Selective bounded recall | Existing task relation/new-thread decision controls recall. Five results, two reads, depth one, eight explicit expansions; independent byte bounds. App Server tests prove ordinary continuation skips recall and unrelated MCP servers remain configured. | Token counts are estimates. Text-search PL/EN effectiveness requires the user's experiment. |
| Capture and provenance | Existing checkpoints plus explicit findings; source IDs, task/attempt/role/time/branch/commit/files/type/status/relations. Confirmed writes, stable deduplication, lost-ack recovery and external-edit detection. Existing-checkpoint test proves capture does not invoke another model. | A semantic change in user intent still requires the main agent to choose the correct durable key or `supersedes` relation. Current instructions/code always take precedence. |
| Retractions and concurrent writers | Persistent undo/deletion retractions include all captured main stages of a turn; redo cannot reactivate them. Branch decisions remain separate. Source checks, serialized writers, timestamp plus stable attempt-ID tie breaking, stale-setting rejection and dead-owner lock repair have controlled tests. | Deleted source sessions invalidate dependent reads. Unknown/live writer ownership is preserved for manual inspection. |
| Independent dataset | Separate local Git repository, three actual earlier-agent sessions, eight active notes and six relations. Prompts, usage, costs and provenance are frozen. Future prompts/graders are absent from the seed. | Publication is blocked on owner/URL and public/private choice. No remote is fabricated. |
| A/B isolation | Independent workspaces, stores and namespaces; project-only Git history; fresh import in B; A has no Pace memory adapter. Real App Server command probes deny host/auth/symlink reads and host networking while permitting workspace writes; preparation commands are read-only. Downloader/cache/checksum and fake A/B tests exercise the shared production policy. | The controlled pilot requires Linux bubblewrap and a Codex runtime supporting named permission profiles. Unsupported enforcement fails before the model. |
| Experiment profiles/reporting | Quick, fixed 36-call Standard, Confirm with a preselected repetition count, and a separate 18-call full cycle. Reports separate continuity, equal-information tasks, preparation/import, current and cycle costs, quality/context review, severity, affected behavior, failures, unknowns and uncertainty. | Only preparation and one Quick pair were live-run before the user's stop instruction. Confirm repetitions remain unset; no broad economy or quality conclusion is supported. |

## Backend and terminal integration

Basic Memory **0.24.1**, Python **3.12.15**, SQLite, local FastEmbed **bge-small-en-v1.5**, reranker disabled. Source contract and process ownership details are in [memory.md](memory.md).

Actual read/write/delete and constrained project listing worked in disposable data/config directories. Quick then imported all eight seed notes into a fresh namespace through confirmed backend writes. Its recall performed one search and two reads, with provider diagnostics recorded after configuration verification. Project/role rejection, stale writes and cancellation are tested without a paid model.

Run manifests preserve the source actually used. Final hardening of import confirmation, writer ties/repair and external-note navigation was checked with controlled tests; the live benchmark was not repeated after the user's stop instruction.

Terminal checks used temporary HOME/CODEX_HOME and a copied built package at `node_modules/@sidearker/pace`, with its existing dependencies linked locally. `/memory` opened first setup in both debug and installed layouts; Escape cancelled in the debug checkout. The installed layout completed real setup, opened the empty ready panel, disabled memory, then showed unavailable after an intentionally missing executable. Repair detected the existing pinned runtime and returned to ready with the **same** backend project and notes directory. No real user project memory was used. This was a local package-layout smoke, not publication to npm.

## Frozen local dataset

- Dataset: **parcel-desk-v1**, repository `../pace-memory-dataset`.
- Full Git SHA: `8f4ae82f963564e6f4ff9042b23a4bb7379432b9`.
- Export SHA-256: `d63bd7b1748158c622cb0d04983afea2b3419243a058c67d129c5dedbd7d24c5`.
- Production policy: **v1**, parameters pinned in `benchmark/memory/dataset.json` and the run manifests.
- Earlier agent: **gpt-6.1-sol / medium**, three calls, eight active notes, six relations, three source sessions.
- Successful seed preparation: **$0.2156988** estimated Standard API model cost, **237.819 s** including setup. Backend billing is unknown.
- Future task prompts and grader strings were checked against the export and are absent. Evaluation material stays in Pace; the agent receives only its assigned code snapshot and current prompt. The private fictional audit decision is intentionally classified as continuity.

Preparation run: `benchmark/results/memory-20261027172930575-c28b39f1`. Earlier interrupted attempts and their failure summaries are retained as separate Center runs; empty sibling `.interrupted-*` directories were removed after transferring those summaries. Across all preparation attempts there are six model attempts: four have a combined known subtotal **$0.2812708**, and two routing failures have unknown usage/cost. Three other preparation failures reached no model call. Their indexing/startup/repair time and backend billing do not become zero. The first rejected preparation did not retain its raw completion/diff, because its guard ran before artifact persistence; subsequent preparation now persists those artifacts first. The selected seed's preparation figure is not the complete implementation/repair cost.

## Quick result recorded before the stop instruction

Run: `benchmark/results/memory-20261027173419731-fea12eb2`, scenario `similar-bug`, one matched A/B pair, same code/request/model/effort. Full answers, diffs, checks, raw usage, timing, telemetry and agent review are retained there.

| Measure | A: baseline | B: memory |
| --- | ---: | ---: |
| Current model estimate | $0.0612756 | $0.0595256 |
| Input / cached input tokens | 102359 / 84096 | 106449 / 87296 |
| Output tokens | 1634 | 1249 |
| Whole arm duration | 46.510 s | 66.324 s |
| Fresh setup/import within arm | none | 27.692 s |
| Recall within model invocation | none | 4.828 s, two notes |
| Existing and external checks | passed | passed |
| Agent review of behavior/context | passed | passed |

Both implementations move retry accounting into each task and preserve sequential execution/results, exact final rejection and exhaustion. Added tests exercise independent retry budgets and stopping before subsequent tasks. Review assessed the changed behaviors, not file/line counts. The model-cost difference is **−$0.00175**, while whole-arm time is **+19.814 s**. This single observation has no defensible confidence interval or general savings claim. Preparation, import, failed attempts and unknown backend costs prevent a complete savings calculation. No continuity task was measured.

## Checks and unresolved failures

- `npm run build`, `npm run benchmark:check`, `git diff --check`: passed. The latter TypeScript command checks benchmark code and does not run a benchmark.
- Required MCP/external-MCP/app-composition group: **24 passed**.
- Required checkpoint/session/revisions/turn-runner group: **55 passed** when repeated with `--testTimeout=30000`. The first default run hit a five-second timeout during 2050 saved revisions under concurrent host load.
- Memory/config/adapter/checkpoint/App Server/Ink/dataset tests: **29 passed** in the last focused run, without model calls or backend installation. The combined benchmark-plus-memory test group passed **89 tests** before the final additional safety cases.
- Final default `npm test`: **736 passed, 6 failed** (742 total). An earlier repeat with `--testTimeout=30000` had 735 passed and the same six failures before the final added safety case. The remaining failures concern clarification routing in `tests/durable-workflow.test.ts` and `tests/execution.test.ts`; the final default run had no timeouts.

The existing `clarify → single` conversion in committed `c85e230` bypasses clarification behavior expected by those tests. A temporary source archive of HEAD reproduced both workflow failures. HEAD also failed earlier in execution tests because `/example/project` did not exist; repeating the archive with only the new missing-path guard reproduced the same six clarification failures as the working tree. Both temporary archives were removed. The clarification conversion and the user's unrelated streaming/accounting changes were preserved. These failures prevent claiming a fully green repository gate.

Pending acceptance work is remote publication, the user's larger experiments/Confirm repetition choice, resolution of the existing clarification-test mismatch, and any desired cross-platform live verification. No further memory benchmark or paid model call should run without a new user instruction.
