# Durable tasks and routing

Pace assigns `single`, `scout`, `plan`, or `scout_plan` to the active task. Ordinary continuation retains its stage and lead model/effort. A completed scout report is saved before completion or planning begins. Correcting a plan continues the planner. Vex can explicitly choose to reroute, replan, replace the task, ask for clarification, or answer an independent question separately. Confidence and probabilities are diagnostics; they do not trigger routing thresholds. Message length, keywords, sentiment, and correction counts do not classify these actions.

Vex uses the existing validated `vex_choose` contract. A separate choice assesses recorded evidence as `closed`, `partial`, or `unknown` after the technical result is persisted. A completed Codex invocation, scout report, or saved plan does not establish completion of an implementation. Activity results, agent task events, answers, and artifact references are collected in core for terminal UI, exec, and Remote. The ordinary answer is retained as evidence, with its coverage and remaining work; Pace does not invent a remaining-work note from a forced-choice response. No extra model status-note call is made when that answer supplies the evidence. Unavailable assessment leaves completion unknown.

## Explicit control

- `/manual` selects an allowed workflow or route. Explicit selections are recorded as user actions. Delegating a stage to Vex uses the same editable profiles as automatic routing. Scouts, verifiers, and side answers can use any enabled permitted route; Luna is not required.
- `/execute [plan-file] [instructions]` reads the current complete plan and creates a fresh normal execution session. The session records the source task, session, artifact/path, and exact plan. UI and Remote use the same service. A queued operation keeps its identity when an execution session is created, allowing restart to find that session instead of creating another one.
- `/btw <question>` asks a read-only agent in a separate thread. Vex selects its route and reasoning depth. Its labelled snapshot includes retained exchanges and selected observations, not the complete tool history. The answer records its author and source attempt; the main task, route, thread, tasks, checkpoint, and context measurement retain their ownership.
- `/adopt <side-answer-id>` explicitly transfers one selected finding to the main task. Vex can also recognize such a request and select the source with a separate choice. Other side answers are not automatically replayed to the lead agent.
- `/verify` and verifier follow-ups have separate thread, route, tasks, context, and turn count. They do not generate the main checkpoint. Accepted plan revisions return to the planner.
- `/resolve <attempt-id> <outcome>` records a reconciled result after inspecting the thread, artifacts, and file changes. This does not itself certify task completion.

An exec invocation that needs workflow clarification prints the request and exits with status 2. Approvals and interactive tool questions are handled explicitly by its existing noninteractive policy.

## Persistence and recovery

Every model stage has a durable attempt identifier and role. Start is saved before inference; result, error, or cancellation is saved before a following stage starts. Required saves propagate failures. A running or uncertain attempt after interruption blocks automatic retry; missing persistence does not mean no work occurred. Inspect the reported thread, artifacts, and file changes before reconciling it with `/resolve`.

The session store serializes updates against the latest persisted revision within the Pace process, including independent store instances. Whole stale snapshots are rejected. Tracked snapshots reapply only their concrete changes; edits to the same value conflict instead of silently overwriting it. Main and auxiliary writes preserve independent attempt and side-result records in either order. This is not a cross-process database lock: separate Pace processes writing the same session are outside that guarantee.

Queue entries retain operation ID, text, intent, target session/task, role, and optional side source. They are acknowledged after success. Failures pause draining; unstarted operations can resume after restart, while interrupted attempts require reconciliation. Old string entries become ordinary prompts with stable IDs, without interpreting command-looking text as a stored intent. Undo, deletion, and file restoration invalidate context and task assessment; the cost ledger survives visible-history truncation and undo.

Older sessions remain readable. Their workflow is unknown until Vex receives the retained evidence. A missing workflow does not establish that a scout needs to run again. Manually edited routing text is preserved; absent new sections receive defaults.

## Usage and audit

`/route` links decisions to task, stage, role, attempt, and context action. It distinguishes user selections, Vex choices, retained routes, and selected side results. It does not invent a natural-language explanation from probabilities.

`/stats` uses the durable Codex attempt ledger, including errors, cancellations, scout format repairs, checkpoints, and manual compaction. It reports known subtotal separately from full cost. Missing billing fields, unidentified usage, backend rerouting without billable attribution, unknown prices, and compaction placeholders leave full cost unknown. Legacy history without an attempt ledger also leaves full historical cost unknown. Context occupancy is a separate measurement.

Usage is correlated by Codex thread and turn IDs, including notifications received before the `turn/start` RPC response. Per-request cumulative readings are deduplicated within the identified turn. Each attempt retains its source route and price snapshot; later route changes do not reprice earlier tokens. Ordinary, cached, cache-write, and output tokens have separate rates. Reasoning output is already included in output. These are Standard API estimates, not measurements of Codex subscription allowance. Vex call latency is reported separately; its choice contract does not expose token usage or billed cost.

## Context policy and evidence limits

This change adds no automatic context strategy controller, fresh replay, or new compaction policy. Changing model or effort continues the existing thread. Existing checkpoint triggers remain 16 turns or 75% measured context; authorship remains the main session route. Auxiliary roles cannot replace that route or trigger its checkpoint.

The October 2026 fixed-route context benchmark does not validate these thresholds, checkpoint authorship, Vex model profiles, or routing quality. Its 3.4% observed side cost difference is not a savings guarantee; its timing does not establish parallel speedup. Stable leadership also does not guarantee quality or lower cost.

Deferred questions: behavior near the context limit with rich tool history, costs beyond two subsequent turns, complete native compaction cost, and fidelity across checkpoint authors. Any new automatic migration or authorship policy needs separate evidence and user decision. Those studies are outside this routing change.
