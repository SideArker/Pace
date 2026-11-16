# Terminal application composition

`../App.tsx` is the entry component. It calls `useAppController` and renders `AppView`; its command exports remain available to existing callers.

| Module | Responsibility |
| --- | --- |
| `useAppController.ts` | Compose hooks and actions and provide the view model. |
| `AppView.tsx` | Render the existing Ink tree, transcript, menus, composer and modal panels. |
| `useAppState.ts` | Own React state and the mutable refs shared by session operations. |
| `runtime.ts` | Keep the process-scoped store, runner, orchestrator, Vex client and project identity. |
| `useConversations.ts`, `useSessionActions.ts` | Derive conversation choices; activate/create sessions, change history and cancel work. |
| `usePromptQueue.ts`, `useDeferredTurns.ts` | Persist and edit the queue; resume queued operations and scheduled retries. |
| `useAppLifecycle.ts` | Load configuration and sessions, connect services, poll usage and clean up on unmount. |
| `interaction-actions.ts`, `useAppKeyboard.ts` | Manage pending approvals/questions and connect keyboard shortcuts to actions. |
| `command-completion.ts`, `submit.ts` | Derive command suggestions and dispatch submitted input. |
| `execution-actions.ts`, `planning-actions.ts`, `auxiliary-actions.ts` | Wire turn/shell execution, planning, side questions and remote control. |
| `useModelRouting.ts`, `routing-commands.ts` | Manage model menus and manual routing/workflow selections. |

The controller preserves the order of lifecycle effects. Actions receive state, refs and callbacks explicitly; they do not create additional stores or execution clients. `AppView` imports the controller type only and shares the existing transcript-history ref across redraws and modal transitions.

`useSessionActions.showFreshSession` applies the shared UI reset after a fresh conversation has been saved. New conversation, planning and execution actions keep their own preparation, persistence, error rollback and status text, then call this same reset.

Mounted application checks live in `tests/app-composition.test.tsx`; input, queue and turn-runner tests cover the underlying workflows.

Appearance is provided through `ColorSchemeContext` in `App.tsx`, with the persisted `/theme` preference in the existing config. `/theme` opens `../ThemeManager.tsx` with a theme sidebar and sample diff/conversation preview; only Enter saves the previewed palette. File review continues to use its original palette and controls. `../layout.ts` owns the existing dock/composer thresholds; `../PanelFrame.tsx` keeps manager choices and navigation visible when content overflows. The lifecycle work clock runs at 40 ms for the shared spinner/color animation, uses a slower process clock when animation is unavailable, and cleans up on idle/unmount.

Artifact IDs and conversation-scoped lookup live in `core/system/artifacts.ts`. Both direct and queued plan execution use `preparePlanExecution`, so `/execute <id>` follows the same fresh-conversation path as saved plans. `/artifacts open <id>` and `/artifacts folder` use the existing OS link opener. `/execute` without arguments and explicit file/prompt forms remain supported.

The first interactive launch runs `entrypoints/startup-setup.tsx` before mounting the app when neither `~/.pace/config.json` nor `~/.pace/sessions` exists. The hidden `pace --setup` flag forces the wizard for returning users too. `StartupSetup.tsx` previews theme, approval mode and routing, then saves the existing config with those choices before opening Pace. The saved config prevents repeat setup; Esc/Ctrl+C cancel without writing, so first-time users are offered setup again next launch. Non-TTY startup and CLI subcommands do not trigger automatic setup. `pace setup` remains the optional routing-key command.
