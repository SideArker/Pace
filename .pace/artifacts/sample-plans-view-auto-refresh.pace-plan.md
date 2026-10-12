# Example plan: Refresh the Pace Plans view automatically

## User Review

> [!USER REVIEW]
> **Task understood:** Show new conversation plans in the VS Code Plans view without requiring a click on Refresh.
>
> **Expected result:** A new or removed `.pace-plan.md` file appears in the view while VS Code is open. The Refresh button remains available.
>
> **Assumption:** Watch only saved conversation artifact folders for the open workspace. Keep the existing workspace watcher for older project-local plans.
>
> **Decision for review:** Should this work cover plans saved while VS Code is closed? This example assumes yes: the view scans folders when it opens.

## Plan at a glance

1. Watch the saved conversation directories that belong to each open workspace.
2. Refresh the Plans view when a plan file changes or a conversation folder appears.
3. Rebuild watchers when workspace folders change. Release them when the extension stops.

> [!INFO]
> This is a sample implementation plan for testing the Pace reader. No feature is implemented by this document.

## Current state

The [Plans view provider](extensions/vscode/src/extension.ts#L46) reads conversation plans when VS Code requests its children. The [extension activation code](extensions/vscode/src/extension.ts#L145) watches project-local `.pace/artifacts/` files. New plans under `~/.pace/sessions/` require the [Refresh command](extensions/vscode/package.json#L57).

## Proposed design

Use one watcher for each saved conversation root associated with an open workspace. A directory event schedules a short, shared refresh, so a single plan save does not redraw the view for every file operation. Rescan the root when a conversation directory appears. Keep file discovery in `savedPlans()` as the source of truth.

> [!DECISION]
> Use filesystem events for this first version. If the target platform cannot watch an application-data directory reliably, document the limitation and keep manual Refresh.

## Implementation steps

- [ ] Extract the conversation root calculation from `savedPlans()` so discovery and watcher setup use the same path.
- [ ] Add watchers for conversation roots and their `artifacts/` directories. Handle missing directories created later.
- [ ] Debounce events before calling `PlanTree.refresh()`.
- [ ] Rebuild and dispose watchers on workspace changes and extension shutdown.
- [ ] Keep the existing project-local watcher and Refresh command.

## Verification

- [ ] Open this file as a `.pace-plan.md` plan. Confirm the User Review, Info, Decision, and Warning callouts render.
- [ ] Use the contents links to jump between sections.
- [ ] Click a source-file link above. Confirm VS Code opens the file beside the plan at the cited line.
- [ ] Create, edit, and remove a conversation plan while VS Code is open. Confirm the Plans view updates once per change burst.
- [ ] Reopen VS Code after a plan was saved. Confirm the plan appears on first view load.
- [ ] Run `npm run build` in `extensions/vscode` and `npm test` at the repository root.

## Risks and open decisions

> [!WARNING]
> Filesystem events can be missed on some mounted or network filesystems. The view must still scan current files whenever it loads, and manual Refresh must continue to work.

The exact watcher API and behavior outside the workspace need verification before implementation. This plan requests no change to Pace's artifact storage or the plan Markdown format.
