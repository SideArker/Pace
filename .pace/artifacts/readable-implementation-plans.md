# Readable implementation plans in Pace

## Goal

Make implementation plans easy to scan, understand, and revisit. Pace should generate a human-readable plan, then a VS Code extension named **Pace** should display its Markdown as a focused artifact reader. The extension is in scope now; broader Pace-in-VS-Code integration remains future work.

The supplied screenshot shows the current failure mode: long findings and implementation steps render as dense inline Markdown. The terminal Markdown renderer handles headings, lists, code, and links, but the chat transcript still gives plans the same visual weight as ordinary answers.

## Product shape

Every plan starts with a short, plain-language task description and a **User Review** section at the very top. That section states what Pace understood, the intended outcome, key assumptions, and decisions the user must approve. Implementation details follow only after this review gate. A reader should understand the task without first decoding repository findings or technical steps.

The named VS Code extension is a Markdown preview/read experience for Pace plan artifacts, not a VS Code coding agent or a full Pace integration. Users open a plan Markdown file and get a clean, navigable view. Plan files use a recognizable name/extension convention so VS Code can show a dedicated icon. Clicking a file opens the Pace reader; users can still choose the normal Markdown editor when they want source text.

The reader adds styled callouts such as **User Review**, **Info**, **Warning**, and **Decision**, plus readable headings, task lists, file references, and navigation. Callouts must have a readable plain-Markdown fallback outside VS Code.

## Current behavior

- Codex plan task updates are stored as agent tasks. `TaskPanel` shows up to three unfinished steps below the composer; `/tasks` prints all steps as plain text (`src/components/TaskPanel.tsx`, `src/core/tasks.ts`).
- Read-only planning sessions produce a text plan with summary, files, steps, verification, risks, and edge cases (`src/core/orchestrator-helpers.ts`).
- Split workflows already pass structured JSON handoffs with summary, findings, next steps, checks, and risks (`src/core/orchestrator-helpers.ts`, `src/core/orchestrator.ts`).
- Final plan reports still enter the transcript as Codex message text (`src/components/App.tsx`). Loading a plan file also inserts its full contents inline.
- Pace has project Markdown artifacts under `.pace/artifacts/`, an `/artifacts` command, and turn reporting for changed artifacts (`src/core/system/artifacts.ts`, `src/components/App.tsx`).
- Pace calls Codex through the Codex App Server protocol, as documented in `README.md`; current repository evidence does not show a separate custom Codex SDK tool interface.

## Proposed first version

Build a first-class plan artifact and the Pace VS Code extension together. Keep existing plan generation workflows and Codex task progress. Store the full, human-readable plan as a descriptive Markdown file under `.pace/artifacts/`, then show a short chat summary with its path. The VS Code extension owns the rich reading experience; Pace's terminal can keep a concise summary and `/artifacts` listing in this slice.

Use normal Markdown as the durable format so plans remain readable outside Pace and can be edited by users. Use a distinctive plan filename suffix only if VS Code needs it for default custom-editor selection and icons; keep `.md` compatibility and ordinary editing available. Organize generated plans with a predictable outline:

1. **User Review** — task in plain language, expected result, assumptions, decisions needing approval.
2. **Plan at a glance** — goal, scope, and a few short milestones.
3. **Current state** — only relevant repository facts and linked files.
4. **Proposed design** — components and data flow, explained simply before implementation detail.
5. **Implementation steps** — ordered, concrete, independently reviewable steps.
6. **Verification** — expected checks and behavior to confirm.
7. **Risks and open decisions** — concise, actionable items.

Keep each finding and step concise. Explain specialized terms on first use. Link file references to paths and line numbers where known. Use nested detail only when it helps explain a decision. Mark assumptions and unresolved decisions clearly. Preserve the original user request as the authority. Do not put research dumps, exhaustive file inventories, or raw agent handoffs in the reader's primary flow.

The extension provides a focused Markdown reader, clear section hierarchy, a contents/navigation area, styled callout blocks, and readable linked file references. A file association opens plan files in the reader by default, with an easy “Reopen Editor With...” path to plain Markdown editing. The Pace plans view supplies a plan icon regardless of the user's file icon theme. The implementation uses a read-only custom text editor to support the default opening behavior.

The extension needs a small, documented callout syntax that remains legible as normal Markdown. Example:

```markdown
> [!USER REVIEW]
> Pace understood the task as making implementation plans easier to review.
> Approve this direction before implementation starts.
```

The reader renders Markdown through Markdown-it inside a VS Code custom text editor. The standard Markdown file remains available through VS Code's normal editor. Explorer icons continue to follow the user's selected file icon theme.

## Codex tool integration

Do not begin with a standalone SDK or MCP tool. Pace already owns plan workflows and has the context needed to save artifacts. The extension is a reader for those files, not a new plan-generation client.

Keep a future tool boundary possible: plan generation should eventually produce a validated plan document plus metadata (title, summary, sections, referenced files, verification, risks). If users later need other Codex clients to create Pace plans, expose that stable contract as an MCP tool or SDK tool after confirming the target client and invocation model.

## Implementation outline

1. Define the plan Markdown contract, including mandatory top-level User Review content, callout syntax, file naming, and plain-Markdown fallback.
2. Add or refine a dedicated planning skill/instruction that teaches Codex to write simple task summaries, evidence-based steps, and reviewer-first plans. Keep the core format instruction in Pace's own prompt path too, so behavior does not depend on one user's skill settings.
3. Trace plan entry paths: `/plan`, planning sessions, plan-verify workflows, plan file loading, task updates, resume, and artifact reporting.
4. Update prompts and workflow handoffs to produce concise Markdown artifacts under `.pace/artifacts/`. Preserve read-only behavior for planning and verification. Show only a short chat summary with the artifact path.
5. Scaffold the VS Code extension named Pace. Register preview activation, file association, commands, and extension checks. Use the custom text editor for default opening and the Pace plans view for icons.
6. Implement the plan reader layout and callout styles, including User Review, Info, Warning, and Decision. Add navigation, accessible contrast, keyboard behavior, and links to source files.
7. Support plain Markdown editing through VS Code's normal editor and document a “Reopen With” workflow. Keep the extension read-only in the first version.
8. Verify artifact naming and rendering in VS Code, default editor selection, fallback rendering in GitHub/plain Markdown, theme/icon behavior, workspace trust, and malformed or unknown callouts.
9. Document install/run/packaging for local use. Marketplace publishing is a separate decision; do not add broader Pace VS Code integration in this slice.

## Relevant code

- `src/components/App.tsx` — plan commands, loaded-plan transcript insertion, artifact listing, and message construction.
- `src/components/TaskPanel.tsx` — compact live task panel.
- `src/core/tasks.ts` — Codex task snapshot and `/tasks` summary.
- `src/core/orchestrator-helpers.ts` — planning prompt, structured handoff, execute/verify prompts, plan file loading.
- `src/core/orchestrator.ts` — planning workflow stages and turn/artifact persistence.
- `src/core/system/artifacts.ts` — Markdown artifact convention and changed-artifact tracking.
- `routing-prompts.default.json` and skill/prompt wiring — likely places to put the core plan quality contract; confirm active route prompt composition before editing.
- `src/shared/types.ts` and session serialization — candidate locations if a small plan reference must persist with a session.
- `README.md` — documented commands, workflows, and artifact behavior.
- `extensions/vscode` — isolated VS Code extension manifest, reader implementation, styles, icon, and VSIX packaging.

## Verification strategy

- Test generated plan structure and enforce a concise User Review section at the top for every plan workflow.
- Test artifact creation, update, listing, session resume, old session compatibility, and missing/invalid plan files.
- Test Markdown preview rendering for User Review, Info, Warning, Decision, unknown callouts, long content, links, and missing optional sections.
- Test extension file association, command activation, icon contribution, workspace trust behavior, and normal-editor fallback.
- Confirm plans remain readable in generic Markdown viewers and use accessible contrast in light and dark VS Code themes.
- Run extension tests/package validation and existing planning, artifact, session, and CLI checks.

## Open decisions and assumptions

- Decided: keep the VS Code extension in `extensions/vscode` and distribute it as a local VSIX.
- Decided: Markdown artifacts under `.pace/artifacts/` are versioned in Git; other `.pace` data stays ignored.
- Decided: use `.pace-plan.md`; opening the file uses the Pace reader by default. Source editing remains available through “Reopen Editor With...”.
- Decided: save completed planning and plan verification turns automatically to `.pace/artifacts/`; retain the full text in the session for `/verify` and `/execute`.
- Decided: bundle `grill-me` as an available skill. It starts only when invoked or selected by Codex for a relevant request; users can disable it.
- File icons are visible in the Pace plans activity view. The ordinary VS Code Explorer still follows the user's active file icon theme.
- User Review is the first substantive section and describes the task, expected outcome, assumptions, and approval decisions. It does not block creation of the plan.

## Implementation status

- Pace now writes plan artifacts after read-only planning turns, records the path in the session, and shows a short transcript result.
- Pace prompt paths request a plain-language plan with User Review and readable callouts. A bundled `grill-me` skill is discoverable alongside user skills.
- The separate extension builds a local VSIX. It registers a default reader for `.pace-plan.md`, a Pace plans view, heading navigation, callout styling, and links to workspace files.
- Focused tests and the full root test suite passed. The extension compiled and packaged. Manual appearance and click-through checks inside a VS Code window remain to be done.

## Caveman settings diagnosis

The active local config at `~/.pace/config.json` sets `skillFolder` to `/home/user/.agents/skills` and does not list `caveman` in `disabledSkills`. `/home/user/.agents/skills/caveman/SKILL.md` exists. Therefore Pace can discover `/caveman`.

Pace supports bare `/caveman` to activate the skill for the conversation, and `/caveman lite|full|ultra` to set its level. The implementation passes enabled skill metadata and paths on ordinary turns, while the skill file is read when the skill is relevant or active. A slash invocation with a request activates the skill and sends that request to Codex. Use `/skills` to refresh discovery and `/skills enable caveman` if disabled. The local config does not prove which exact command was sent in the screenshot's session or whether that conversation had the skill active.

## Stop condition

Stop after Pace generates a reviewer-first plan artifact and the VS Code extension opens it as a readable, navigable preview with callouts and file references. Keep source Markdown available. Do not add general VS Code agent integration or an external SDK/MCP tool in this slice.
