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
