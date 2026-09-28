# Pace roadmap implementation plan

Build in phase order. Keep optional work gated by evidence or demand. Run benchmarks and tests only after feature implementation is complete.

## Implementation status, 2026-09-28

The roadmap is **not fully implemented**. This status records code changes from the current work. A feature marked implemented may still need its listed end-to-end or platform checks.

### Implemented

- Cancellation during routing or execution is saved as a cancelled turn. Esc cancels a turn waiting for approval. `pace exec` keeps its SIGINT handler until cleanup.
- `/resume` groups conversations by project, marks missing project folders, and blocks resume with a recovery message.
- `/model <name> [effort]` selects an enabled route for manual turns when Vex is unavailable. Manual routes do not require Vex.
- Changing model starts a fresh Codex thread and carries saved successful turns into its prompt.
- Turn footer labels completed turns; errors and cancelled turns have distinct transcript labels.
- `pace doctor` reports Vex discovery, startup, connection, and tool validation failures. Installed Vex startup and `vex_choose` discovery were verified live.
- README documents PowerShell, Bash/Zsh, multiline `pace exec`, its streams and exit behavior, cancellation, and approvals.

### Remaining implementation and proof

#### v0.2: dependable CLI

- Verify project switching with active background turns and run restart/resume end to end.
- Verify `pace exec` multiline arguments, saved session metadata, stdout/stderr separation, every exit code, approval denial, and Ctrl+C end to end.
- Exercise Windows Terminal and supported Unix shells. Current environment only verified PowerShell commands; shell workflows were documented, not exercised.
- Review failed command events and confirm final transcript summaries distinguish command failure from successful turn completion.

#### v0.3: measurable routing

- Add and validate a routing preference setting, limited to configured, enabled, priced routes.
- Apply preference to Vex workflow and model-effort choices. Display active preference and selected route effect in `/route`. Preserve manual routes and permissions.
- Keep estimated API-equivalent cost separate from actual billing, and record overrides and outcomes consistently.
- Complete matched executed comparisons with manual passing grades. Route-only suites passed 180/180 development and 69/72 holdout choices, but preferred labels are hypotheses. One executed scout case has no recorded quality grade; no preference policy is supported yet. Automatic review rejected `benchmark:grade prepare`, so grading remains outstanding.
- Review the three holdout misses, then use untouched cases for any revised policy. Keep v0.3 open until results repeat and routing overhead is understood.

#### v0.4: context efficiency

- Measure native thread continuation against fresh-thread runs with compact retained context. Record quality, usage, latency, and context loss.
- Add optional summaries for decisions, constraints, and unfinished requirements. Keep source turns intact and summaries distinguishable.
- Add `/context` status and per-turn native/fresh controls. Explain model-change behavior and carried history.
- Design and implement user-visible compaction guidance and Vex-assisted summary selection only after context measurements.
- Bind summary state to source turns; invalidate or refresh it after new turns, rewinds, or model changes.
- Keep JSON storage. Migrate only if measured reliability, query, or concurrency limits justify SQLite.

#### v0.5: controlled recovery

- Classify execution, validation, and transient provider failures. Preserve original errors and usage in saved turns.
- On meaningful failures, show Vex reassessment reason and proposed route before retry.
- Add one configurable retry or escalation maximum. Preserve original failure and relevant context. Never loop.
- Ask before any permission or risk increase. Preserve Codex sandbox and approval rules; never expand trusted folders or bypass declined approval.
- Show old and new outcomes together, with additional usage and duration recorded separately.
- Evaluate recovery against matched cases for completion, repeated edits, cost, latency, and permission safety.

#### v0.6: conditional on demand

- Demand decision remains open. If approved, document adapter contracts and config compatibility; add versioned session export/import with secret exclusion and strict validation; add project config with clear precedence and no secrets; complete contributor and clean-install docs.
- Add another provider only after a concrete provider request, official API review, and compatibility plan. Keep Codex default.
- Run migration and packaging checks only for features selected for implementation.

### Completed checks

- `npm test`: 83 tests passed.
- `npm run build` and `npm run benchmark:check`: passed.
- Live `pace doctor`: Vex connected and `vex_choose` found.
- `npm pack --dry-run --json`: passed; package content review remains part of v0.6 if packaging changes.
- Routing evaluation: development 180/180 acceptable, holdout 69/72 acceptable, three repetitions each. One matched executed task ran across fixed and auto arms, but has no manual grade.

## 1. Finish v0.2: dependable everyday CLI

1. **Cancellation and input resilience**
   - Trace Ctrl+C, Esc, and shutdown behavior across interactive turns, approvals, and `pace exec`.
   - Ensure cancellation reaches the active Codex turn, clears busy state, and preserves the session.
   - Check narrow-terminal rendering and multiline editing; fix reproducible input or layout failures.

2. **Final summaries and activity**
   - Review supported Codex SDK events and current transcript handling.
   - Make success, cancellation, provider failure, and failed commands easy to distinguish.
   - Show a concise final turn summary without duplicating activity already shown.

3. **Project and session picker**
   - Make project groups and missing-project status clear in the picker.
   - Keep resume unavailable for missing paths; offer a useful recovery message.
   - Verify switching projects restores the right session and does not disrupt background turns.

4. **`pace exec` behavior**
   - Define prompt, stdout, stderr, exit-code, and Ctrl+C behavior for scripts.
   - Preserve multiline prompt arguments and session metadata.
   - Keep noninteractive approval behavior explicit and safe.

5. **Cross-platform setup**
   - Document and exercise install/build workflows for Windows PowerShell and Windows Terminal, plus supported Unix shells.
   - Fix platform-specific path, process, and terminal handling found during that work.

6. **Vex compatibility and diagnostics**
   - Make doctor errors identify whether server discovery, startup, connection, or tool validation failed.
   - Check expected MCP tool name and response shape against the real Vex server.
   - Keep unavailable Vex visible and preserve manual routing behavior.

## 2. Finish v0.3: measurable routing

1. **Define evaluation outcomes**
   - Set task rubrics for correctness, required checks, and completion.
   - Record route choice, overrides, usage, elapsed time, failures, and workflow shape consistently.
   - Keep estimated API-equivalent cost labeled as an estimate.

2. **Compare auto routing with fixed routes**
   - Use the existing executed benchmark runner and manual grading flow.
   - Compare matching tasks from the same commit and prompt.
   - Report quality-passing results, cost, latency, and routing overhead separately.

3. **Add routing preferences**
   - Define a small policy setting, such as cost preference versus quality preference.
   - Apply it only among enabled, priced model and effort choices.
   - Show the preference and its effect in `/route`; never override explicit model selection or permissions.

4. **Use results to decide**
   - Retain, revise, or remove local routing heuristics based on holdout and executed results.
   - Keep the phase open until results are repeatable and routing overhead is understood.

## 3. Build v0.4: context efficiency

1. **Measure context strategies**
   - Compare native-thread continuation with new-thread runs using compact retained context.
   - Track task quality, usage, latency, and context loss.

2. **Add optional summaries**
   - Summarize decisions, constraints, and unfinished requirements for long sessions.
   - Keep summaries optional and distinguish them from original conversation history.

3. **Add `/context` controls**
   - Show current context mode and summary status.
   - Let users choose native resume or fresh context for a turn.
   - Explain when changing model requires a new thread and what context will carry over.

4. **Implement context compaction**
   - Show info or warnings when user should compact
   - Run Vex calls with sufficient information if data should be compacted
   - Auto compact with Vex choosing which information to sustain
   - Decide the best flow of compacting data

5. **Protect against stale or lost context**
   - Tie summaries to the conversation state they represent.
   - Refresh or invalidate them after new turns, rewinds, or model changes.
   - Make context truncation or transition visible.

6. **Keep JSON storage unless evidence says otherwise**
   - Track actual reliability, query, and concurrency limits.
   - Adopt SQLite only if those limits occur; plan migration and rollback before switching.

## 4. Build v0.5: controlled recovery

1. **Classify failures**
   - Record execution failures, failed validations, and transient provider errors as separate outcomes.
   - Preserve original error details for the transcript and run comparison.

2. **Offer Vex reassessment**
   - Trigger only after a meaningful failure, never based only on elapsed time.
   - Show the reason for reassessment and proposed route before starting another run.

3. **Add one bounded retry or escalation**
   - Make retry count and escalation behavior configurable.
   - Preserve relevant context and the original failure.
   - Stop after one retry/escalation; do not loop.

4. **Keep risk and permission controls**
   - Ask before a retry changes permissions or risk.
   - Keep Codex sandbox and approval settings authoritative.
   - Never silently expand trusted folders or bypass a declined approval.

5. **Compare runs**
   - Show prior failure, new route, and observed outcome together.
   - Record added usage and elapsed time separately.

## 5. Build v0.6: extensibility, only if demanded

1. **Stabilize internal seams**
   - Document small Codex and Vex adapter contracts.
   - Validate config at load boundaries and define compatibility expectations.

2. **Add session export/import**
   - Choose a versioned portable format.
   - Exclude secrets and validate imported paths and session data.
   - Preserve existing JSON sessions and provide explicit import errors.

3. **Add project-level configuration**
   - Define precedence between project and global settings.
   - Keep secrets out of project config.
   - Make effective settings visible to the user.

4. **Prepare contributors and packaging**
   - Document setup, architecture, configuration, and contribution workflow.
   - Verify published package contents and clean-install instructions.

5. **Consider another provider only with demonstrated demand**
   - Confirm the official provider API and user need first.
   - Keep Codex as default and preserve core chat behavior.

## Benchmarks and tests

Run these after feature implementation is complete:

1. Focused tests for changed input, picker, routing policy, context handling, recovery, config, and session import/export behavior.
2. Build and platform checks for TypeScript, packaging, PowerShell, Windows Terminal, and supported Unix environments.
3. Vex compatibility checks against the real MCP server, including startup, tool discovery, and response validation.
4. v0.2 end-to-end checks for cancellation, missing providers, restart/resume, multiple projects, and `pace exec` exit codes.
5. v0.3 routing evaluation using development cases, then untouched holdout cases; follow with executed comparisons and manual grading against fixed-model baselines.
6. v0.4 context evaluation comparing native continuation and compact-context runs for quality, usage, and latency.
7. v0.5 recovery evaluation measuring completion improvement, repeated edits, additional usage, and permission behavior.
8. v0.6 migration and packaging checks only if those conditional features are approved for implementation.
