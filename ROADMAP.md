# Pace roadmap (after v0.1)

**Product direction:** a lightweight, terminal-native coding assistant that uses Vex MCP to make better routing decisions while Codex remains the execution engine. Keep Pace thin: don't rebuild Codex.

This is a directional roadmap, not a commitment to exact release dates. Advance a phase only after collecting evidence that its added complexity is worthwhile.

## v0.1 — foundation (current build; not part of this future roadmap)

Interactive Ink terminal; official Codex SDK execution and streaming; Vex MCP routing; manual/fallback routing; JSON sessions in `~/.pace`; native Codex thread continuation; `/model`, `/auto`, `/new`, `/resume`, `/help`, `/exit`; basic diagnostics and tests.

**Success signal:** complete a real multi-turn coding task, restart Pace, resume it, and show accurate routing/execution status.

---

## v0.2 — dependable everyday CLI

**Goal:** smooth out actual daily use before expanding routing complexity.

**In progress:** multiline input and history; SDK tool/file activity; `pace exec`; selected skill folder and trusted folders. Remaining items below still need evidence and work.

- Stronger input UX: multiline editing, history, better cancellation and narrow-terminal handling.
- Clear visibility into file changes, tool activity, failures and final summaries, using only supported SDK events.
- Better project/session picker and reliable handling of moved or deleted projects.
- `pace exec "..."` for non-interactive usage and script-friendly exit codes.
- Cross-platform install/build checks, especially PowerShell and Windows Terminal.
- Improved Vex MCP diagnostics and compatibility tests against the real server.

**Exit criteria:** the CLI handles interrupted runs, missing providers, restarts and multiple projects without losing Pace metadata or misleading the user.

## v0.3 — measurable routing

**Goal:** establish whether Vex actually improves model choice rather than assuming it does.

- Local routing log: task category, selected model/effort, manual overrides, reported SDK usage and elapsed time.
- `/route` to explain the most recent selection, separating Vex's reported assessment from Pace's policy decision.
- `/stats` with observed usage and task outcomes, without invented cost or savings figures.
- Compare auto routing against a fixed-model baseline on a repeatable small evaluation suite.
- Support configurable policy preferences such as lower cost vs higher quality, always within allowed model choices.

**Exit criteria:** repeatable evaluations show routing quality and overhead. Keep or remove heuristics according to observed results.

## v0.4 — context efficiency

**Goal:** reduce redundant context without damaging follow-up quality.

- Measure native-thread continuation against new-thread compact-context runs.
- Optional short summaries for long-running sessions, emphasizing decisions and unfinished requirements.
- Add user-visible `/context` and explicit switch between resume and fresh-context modes.
- Avoid repeated context, stale summaries and silent context loss during model changes.
- Consider SQLite only if JSON session storage becomes an actual reliability, query or concurrency bottleneck; implement a safe migration if adopted.

**Exit criteria:** context optimization reduces measured overall task cost without degrading tested task success.

## v0.5 — controlled recovery

**Goal:** make failures recoverable without creating opaque autonomy.

- Distinguish Codex execution failures, failed validations and transient provider errors.
- Optional Vex reassessment after a meaningful failure; never escalate just because the first attempt took time.
- One configurable, visible retry or model escalation with preserved relevant context.
- Explicit user approval for any retry that changes risk or permissions; never bypass Codex sandbox/approval controls.
- Clear run comparison: previous failure, new route, and observed result.

**Exit criteria:** recovery improves successful completion on an evaluation set and doesn't cause repeated edits, surprise costs or permission escalation.

## v0.6 — extensibility, only if demanded

**Goal:** make useful extensions possible without turning Pace into a general agent platform.

- Stabilize the small Codex and Vex adapter interfaces and configuration schema.
- Optional additional *officially supported* coding execution provider if there is real user demand.
- Versioned local session export/import and schema migrations.
- Project-specific configuration with clear precedence over global defaults, excluding secrets.
- Documentation and packaging suitable for external contributors.

**Exit criteria:** adding a provider or migrating stored sessions doesn't disrupt the core chat workflow.

---

## Deferred / not planned until justified

- Multiple concurrent coding agents or automatic task decomposition.
- Hosted account system, cloud session synchronization or team collaboration.
- Background autonomous coding runs.
- Heavy analytics dashboards, remote telemetry or a vector database.
- A custom inference engine or direct replacement for Codex.

These features add substantial product, security and maintenance costs. Do not add them merely because comparable coding tools have them.

## Operating principles for every release

1. **Codex remains the coding agent.** Prefer documented SDK capabilities over reproducing agent logic or embedding an interactive CLI.
2. **Vex recommends; Pace enforces.** Model availability, explicit user choices, provider constraints and permissions remain deterministic.
3. **Measure before optimizing.** Track observed outcome, latency and usage; don't advertise unmeasured token or cost savings.
4. **Keep the terminal calm.** Present current work clearly, with expandable detail rather than permanent dashboards.
5. **Local-first and safe.** User-owned sessions, minimal routing data, no stored tokens, respected sandbox/approval controls and supported service integrations.
6. **Build only the next useful increment.** Each release should leave Pace practical and maintainable even if subsequent roadmap phases never ship.
