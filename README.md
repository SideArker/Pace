# Pace

<p align="center">
  <strong>Stay in flow. Ship from your terminal.</strong><br />
  An independent coding client built around Codex App Server, with optional Vex routing and a VS Code plan reader.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@sidearker/pace"><img src="https://img.shields.io/npm/v/@sidearker/pace?label=npm" alt="npm version" /></a>
  <a href="https://github.com/SideArker/Pace/actions/workflows/windows-smoke.yml"><img src="https://img.shields.io/github/actions/workflow/status/SideArker/Pace/windows-smoke.yml?label=build" alt="Build status" /></a>
  <a href="https://github.com/SideArker/Pace/releases"><img src="https://img.shields.io/github/v/release/SideArker/Pace?label=VS%20Code%20extension" alt="Latest extension release" /></a>
</p>

Pace gives Codex a focused terminal workspace for coding, planning, and saved conversations. The official [Codex App Server](https://developers.openai.com/codex/app-server) runs coding turns. Optional [Vex](https://github.com/SideArker/Vex) routing recommends a model and effort for each automatic turn. Pace is an independent project, not an OpenAI product.

```sh
npm install --global @sidearker/pace
pace setup
pace
```

## What you get

- **A terminal-first coding flow.** Work with Codex, inspect plans, approve actions, and run project commands without leaving your terminal.
- **Conversations that stay useful.** Resume saved work across projects, queue prompts during active turns, and reconnect sessions after moving a project.
- **Routing when you want it.** Use a manual model or enable optional Vex recommendations. Manual mode works without Vex.
- **Plans and artifacts you can revisit.** Save Markdown with conversations and open it in the separate [Pace VS Code extension](https://github.com/SideArker/Pace/releases).
- **Clear local control.** Pace stores its settings and conversation index under `~/.pace`; Codex manages its own authentication and thread history.

## Get started

Requires Node.js 20+, a terminal, and working Codex authentication. Sign in with the [Codex CLI](https://developers.openai.com/codex/cli) (`codex login`) or use a supported Codex CLI environment credential. Pace never reads or stores a token itself. Codex expects a Git project.

Run `pace doctor` to check your setup. Run `pace setup` to configure optional Vex routing. Pace does not ask for an API key during installation or startup.

<details>
<summary>Build and run from a checkout</summary>

On Windows PowerShell, including the PowerShell profile in Windows Terminal:

```powershell
npm ci
npm run build
npm link
pace doctor
pace
```

On macOS or Linux, run these commands in Bash or Zsh:

```sh
npm ci
npm run build
npm link
pace doctor
pace
```

For development, use `npm run dev` instead of linking.

Pace detects debug mode from its installed package path. Builds run from a checkout expose `/feedback`, which saves the current conversation and an optional comment under `~/.pace/feedback/inbox`. The npm-installed package is treated as production and does not expose this command.

</details>

Interactive `pace` opens a fresh conversation; choose a saved conversation in the conversation picker to continue saved work. `pace --help` and `pace --version` work without authentication. `pace doctor` checks Node, local storage, Git, Codex App Server, Vex installation, and configuration; only a live coding turn checks authentication and runtime access.

## Explore Pace

`pace sessions` lists saved conversations across projects. It marks moved or deleted project folders as missing. The conversation picker groups conversations by project and blocks missing paths. To reconnect conversations after a folder move, run `pace reconnect "old path" "new path"` with the old path shown by `pace sessions` and the existing new project directory, then return to the conversation picker. The command preserves conversation IDs, turns, Codex thread IDs, and the active conversation. It refuses a destination that already has saved conversations and retains the original session files under `~/.pace/reconnected` as a rollback copy. You can also restore the folder at its original path. `pace doctor` connects to Vex MCP and checks for `vex_choose`; it exits with status 1 when Vex is unavailable. Its error names discovery, startup, connection, or tool validation. Manual routes remain available when Vex is down.

The Windows PowerShell smoke workflow installs, builds, links, and checks the CLI entrypoint and missing-prompt exit status. Run the same install commands above in a Windows Terminal PowerShell profile to check interactive rendering. The regular test suite includes a handshake with the installed Vex MCP server; it makes no model-provider request. To run that check alone, use `npx vitest run tests/vex-real.test.ts` in Bash or PowerShell.

## Chat commands

| Command | Action |
| --- | --- |
| `/models` | Open the live Codex model menu; Space toggles a model, Enter opens its reasoning levels |
| `/version` | Refresh GitHub release and price data; show the installed and latest reported Pace versions |
| `/auto` | Enable Vex routing for the next turn, including in a resumed conversation |
| `/manual` | Open a workflow wizard; choose each stage's model and effort or delegate either choice to Vex |
| `/workflow [name\|auto]` | Choose a workflow from a menu or by name; Vex chooses its stage routes |
| `/new` | Alias for `/clear` |
| `/compact` | Compact the selected idle Codex thread while keeping its thread ID |
| `/context` | Show the current Codex thread, last measured context occupancy, and checkpoint status |
| `/mcp` / `/mcp list` | Open the interactive MCP manager, or print configured external servers |
| `/diff` | Browse saved file changes by turn; undo or redo individual files |
| `/undo` | Undo the latest conversation turn and its saved file edits; restore the prompt to the composer |
| `/redo` | Restore the last undone turn and its saved file edits |
| `/retry` | Retry the latest failed request without undoing existing changes |
| `/cancelretry` | Cancel an automatic retry and clear its queued prompts |
| `/artifacts` | List Markdown artifacts for this conversation, plus older project artifacts |
| `/approval [full-access\|request-approval\|limited]` | Open mode picker or set the mode for new turns |
| `/tasks` | Show Codex's latest plan steps for this conversation |
| `/trust add <folder>` | Allow Codex to edit an additional existing folder |
| `/trust remove <folder>` | Remove an additional folder; `/trust list` shows current entries |
| `/skills [folder]` | Discover skills in the default or selected folder; `/skills` refreshes the list |
| `/skills enable <name>` / `/skills disable <name>` | Enable or disable a discovered skill command |
| `/skills auto <name>` / `/skills auto off` | Add an enabled skill to ON-LAUNCH, or clear ON-LAUNCH skills for this and future conversations |
| `/skills default` / `/skills off` | Use the default skill folder or turn skill discovery off |
| `/<skill> [request]` | Invoke an enabled skill, such as `/caveman` or `/caveman explain this` |
| `/stats` | Show durable attempt usage, known subtotal, cost completeness, failures, and separate Vex latency |
| `/clear` | Clear the terminal, show the entry screen, and start a new conversation |
| `/exit` | Quit |
| `! <command>` | Run one Bash command in the project directory |
| `!` | Toggle Bash input mode; type `!` again to return to Pace |

Type `/` to see a command menu. Use Tab to complete and ↑/↓ to choose a match. In `/models`, use ↑/↓ or Tab to select, Space to enable or disable, Enter to open reasoning levels, M to use the highlighted model and effort manually, and Esc to go back. Each turn has separate **You** and **Pace** sections, followed by a compact, gray model, timing, usage, and route footer. A divider separates turns. A spinner marks active work; status text comes from Codex App Server events. Occasional tips appear beside the status while the agent works. Active commands appear below the input with elapsed time, and the selected approval mode appears in the input footer. When Codex publishes a plan, Pace mirrors its steps below the input and in `/tasks`; Codex owns their progress. When an action needs approval, press Y to approve it once, N to decline, or Esc twice within 750 ms to cancel the turn. While a turn runs, send another prompt to queue it for that conversation. Queued prompts appear in a bordered box between Pace's messages and the input. Prompts run oldest first after successful turns. A retryable failure pauses the queue until Pace retries the interrupted request. Other failed turns pause the queue until another turn succeeds. Press ↓ then → to select a queued prompt for editing, or press → in an empty composer to edit the next prompt. To steer the working agent immediately, press Alt+M (Option+M on macOS or Ctrl+M) to auto-send the next queued message as steering, or press Alt+M while typing in the composer to send that draft as steering right away. You can also press ↓ to open the queue, select a regular prompt with ↑/↓, and press S or Alt+M. Pace sends it to the active Codex turn without starting another turn and removes it from the queue only after Codex confirms receipt. If no agent turn is ready or sending fails, the prompt stays queued. Queued commands such as `/execute` and `/verify` keep their original action and cannot be used for steering. Accepted steering messages are saved with the turn and shown when reopening the conversation. Alt+Del removes the latest queued prompt. Esc twice within 750 ms or Ctrl+C cancels the active turn and clears its queue. Use `/new` to start another conversation or choose one in the conversation picker to switch. Background turns continue and their responses appear when you return. A saved conversation moves from "Saved conversations" to "This pace" when you send a new message in it; its session and history stay the same. With background turns running, Ctrl+C keeps Pace open; `/exit` quits. When no turns run, Ctrl+C exits. Input stays available during a Codex turn so Bash commands can run concurrently.

If Codex reports a usage limit during an interactive turn, Pace saves the interrupted request and displays its retry time. It retries after the reported account reset while Pace remains open, or after the next launch if that time has passed. The resumed agent is instructed to inspect existing files before editing to avoid repeating completed changes. New requests in that conversation queue behind the saved retry. `/cancelretry` cancels the retry and clears that queue. Queued prompts stay paused until the retry finishes and are saved with their conversation, so they survive exits and restarts. If neither saved task state nor the Codex thread identifies the original task, Pace asks for the missing request or plan instead of repeatedly asking for a deliverable.

If a model call fails because of a connection problem or model capacity, Pace saves the request and retries automatically. Connection retries probe the OpenAI API every 15 seconds and run the model only after the probe succeeds. Capacity retries use increasing delays up to two minutes. Usage-limit retries wait for the reported reset as before. Press Esc once while waiting or during an automatic retry to cancel it; `/cancelretry` also cancels it and clears queued prompts. `/retry` can run the latest failed request immediately. Retries resume the saved Codex thread when available and ask the agent to inspect existing files before editing. Existing file changes are not rolled back.

After opening a second conversation, a compact picker stays below the input. Press ↓ from the input to focus it, use ↑/↓ to select a conversation, and press Enter to switch. Esc returns to the input. Switching keeps other conversation turns running.

Pace retains the active task's workflow and lead route across ordinary follow-ups. Vex explicitly chooses continuation, rerouting, replanning, replacement, clarification, or a separate answer. `/btw` uses a separate read-only thread with a Vex-selected route; `/adopt <id>` forwards one selected finding. `/verify` retains separate verifier state. `/execute` reads the current full plan into a fresh normal execution session. That conversation shows a collapsible execution-plan entry with a nine-line preview; Ctrl+O expands it, including after reload. Saved scout reports also appear as collapsible entries, without duplicating the report in the main answer. Pace periodically saves active execution progress and immediately saves new thread IDs. After a restart, incomplete attempts are marked failed with an interruption note, and the next user turn resumes from the saved thread and observations. See [durable tasks and routing](docs/task-workflows.md) for persistence, recovery, accounting, and unchanged context policy.

Pace shows routing and stage activity in the live status. Detailed decisions and stage records remain in saved sessions; `/stats` shows attempt accounting and Vex call totals.
The header's Context gauge and `/context` use the last measured Codex model request and its context-window limit. `Context ?` means Pace has no valid measurement for the selected thread and model. The account usage panel shows account limits separately. `/context` also says whether the next turn resumes a Codex thread; `/new` starts a separate conversation; choose a saved conversation in the picker to return to it. `/compact` works only when that conversation has an idle Codex thread; Esc twice within 750 ms or Ctrl+C cancels it. Pace records compaction usage, estimated API-equivalent cost, duration, and outcome separately from user turns in `/stats`. The gauge becomes unknown after compaction until another model request reports context usage.

After 16 turns in one Codex thread, or when measured context reaches 75%, Pace asks that thread for a bounded, structured checkpoint. The next turn starts a fresh thread with the validated checkpoint and current request. Pace keeps the old thread ID in the checkpoint record and counts turns in the new thread separately. A failed checkpoint leaves the existing thread available.
The interactive transcript renders Markdown emphasis, inline and fenced code, links, headings, quotes, horizontal rules, nested bullet and numbered lists, task lists, and tables. Level-three headings (`###`) receive a distinct accent. Tables fit the available terminal width by shortening long cells. Markdown links show their label and carry an OSC 8 target. The terminal owns click modifiers and hyperlink activation; Pace does not handle mouse clicks. If clicking does not work, use `/links` to list destinations and `/links <number>` to open the selected link through the OS, without a shell. Only HTTP(S), mailto, file URLs and resolved local file paths are accepted.

## Non-interactive runs

Run `pace exec "your request"` from a project directory to continue its active conversation without Ink. Pass the whole request as one quoted argument. PowerShell can use `$prompt = @'` followed by text and a closing `'@`, then `pace exec $prompt`. Bash and Zsh can use `pace exec $'first line\nsecond line'`. Pace preserves embedded newlines, writes only the final response to stdout, and writes progress errors and approval denials to stderr. It returns 0 on success, 1 on provider, configuration, or execution failure, 2 for a missing prompt, and 130 after Ctrl+C. It declines every noninteractive approval, keeps the saved session ID and turn metadata, and uses the same routing, trusted folders, and skill settings as interactive turns.

## File changes, undo, and redo

Use `/diff` to open the file review panel. Up/Down selects a file, Left/Right selects a turn, Page Up/Page Down scrolls the patch, `U` undoes the selected file, `R` redoes it, and Escape closes the panel. Changes remain available after restarting Pace, including edits from failed or cancelled agent turns. Text files show unified patches; binary files show a change notice and still support undo and redo.

`/undo` or Ctrl+Z restores the latest turn's original file contents and removes that conversation turn. `/redo` or Ctrl+Y restores the turn and its edits without calling Codex. A new agent request clears the redo stack. Individual file actions keep the conversation and start the next request in a fresh Codex thread so it can inspect the restored files. Conversation rewinding and deletion through `/convo` edit only conversation history and clear the redo stack.

Pace records project files before and after normal agent turns. Git projects include tracked and nonignored untracked files, preserving pre-existing uncommitted contents and leaving the Git index untouched. Without Git, Pace scans project files while excluding `.git`, `.pace`, `node_modules`, `dist`, `build`, `.next`, `.venv`, and `__pycache__`. Snapshots are stored under `~/.pace/sessions/`; trusted folders outside the project, ignored files, submodules, and standalone Bash commands are outside this history. Other edits made during an agent turn can be captured with that turn. A later manual change causes undo or redo to stop before changing any files.

File undo is unavailable for turns that overlap in the same project, or snapshots exceeding 10,000 files, 8 MiB per file, or 64 MiB total. Pace reports when it cannot record a snapshot. Conversations saved before this feature have no file snapshots, so their undo restores conversation history only.

## Trusted folders and skills

In the slash popup, use ↑/↓ to highlight an enabled skill, Tab to complete it, and Alt+A to toggle its **ON-LAUNCH** marker. Plain `a` still filters matches. `/skills auto <name>` adds a discovered, enabled skill; `/skills auto off` clears all selections. Pace saves these selections in `~/.pace/config.json` and applies them to the current conversation and each new conversation. Existing saved conversations keep their own selections. Pace prepends their SKILL.md instructions to the first prompt of each new main Codex thread, including a thread started from a checkpoint. Later turns in that thread use its history. Changing selections while a thread is running or already exists takes effect when the next new thread starts. Ordinary slash skill activation keeps its conversation-wide behavior.

Use `/trust add C:\path\to\folder` to give Codex workspace-write access to an existing folder outside the project. Pace resolves and checks each folder before every coding turn. Remove access with `/trust remove <folder>`. Trusted folders are stored in `~/.pace/config.json` as `trustedFolders`. Side questions stay read-only and do not receive trusted folders.

Pace discovers skills in `~/.agents/skills` by default (`C:\Users\<user>\.agents\skills` on Windows and `/home/<user>/.agents/skills` on Linux). Use `/skills C:\path\to\skills` to select another folder containing `<skill-name>/SKILL.md` directories. `/skills` refreshes the list after you add a skill. Discovered skills are enabled by default and appear as slash commands in completion. Use `/skills disable caveman` to hide `/caveman`, and `/skills enable caveman` to restore it. A bare skill command activates that skill for the current conversation without starting a Codex turn. An enabled command can also take a request, for example `/caveman summarize these changes`; Pace sends only the request to Vex and tells Codex to follow the skill on this and later turns. Use `/<skill> off` to deactivate it for the conversation. `/caveman lite`, `/caveman full`, and other Caveman levels set the conversation's style. Use `@<skill>` to send the mention and any request to Vex unchanged, while Codex follows that skill for the turn. For example, `@rigorous-code-review` starts a review without activating the skill for later turns. Slash skill commands keep their existing conversation-wide behavior. Pace also passes enabled skills' metadata and file paths to Codex on ordinary coding turns so it can choose relevant skills. Pace scans the selected folder and its immediate children, up to 32 skills. The folder is not granted write access unless you separately trust it. `/skills off` stops discovery and `/skills default` restores the home folder. These settings are stored in `~/.pace/config.json` as `skillFolder` and `disabledSkills`.

## Models and routing

With a fresh config, Pace enables Luna (`low`, `medium`, `high`), Sol (`medium`, `high`, `xhigh`, `ultra`), and Astra (`high`, `xhigh`, `ultra`). Existing configs keep their saved allowlists and effort levels. Pace refreshes the Codex App Server model catalog at startup and whenever `/models` opens. New models appear there automatically with their supported reasoning levels. Space enables a discovered model using its Codex default effort; M in the reasoning menu selects a manual route. Models listed only in [versions.json](versions.json) also appear with an "access unverified" label until Codex lists them. Saved custom IDs stay visible if the catalog is unavailable. Disabled models are never offered to Vex or Codex. If every model is off, Pace stops the turn and asks you to enable one. When a turn changes model, Pace resumes the existing Codex thread with the selected model and effort. The thread ID and its history remain available.

The model menu uses the catalog returned by your authenticated Codex App Server. The catalog can change with your account and workspace; a live turn still confirms access. You can also edit `~/.pace/config.json` (`%USERPROFILE%\.pace\config.json` on Windows) directly:

```json
{
  "routingMode": "auto",
  "defaultRoute": { "model": "gpt-6-sol", "effort": "high" },
  "models": [
    { "model": "gpt-6-sol", "efforts": ["medium", "high", "xhigh"], "defaultEffort": "high" },
    { "model": "gpt-6-luna", "efforts": ["low", "medium", "high"], "defaultEffort": "low" }
  ]
}
```

Configure only models and effort values you can use. Pace validates supported reasoning effort values. `max` is not a supported reasoning effort. Auto mode needs verified prices for every enabled model and accepts at most 12 model and effort pairs. Invalid config, missing prices, or too many pairs stop routing with an error. Manual mode can use a discovered model without a price estimate; provider errors from a live turn remain visible.

Pace bundles [versions.json](versions.json) and refreshes it from this repository's `main` branch at startup and before automatic routing. The file provides dated Standard API prices, optional model menu hints, and the latest Pace release version. A validated copy is cached under `~/.pace/versions-cache.json` for offline use. The menu uses Codex's live catalog when available; GitHub pricing does not grant model access. `/version` shows which catalog source is in use. Update `versions.json` when a new model price is verified and when publishing a Pace release; `package.json` remains the installed version source.

Pace sends Vex the latest request, bounded excerpts of ten recent turns, a brief of the active task, unfinished steps, the previous route, thread state, configured models and efforts, capability descriptions, and a dated Standard API price snapshot. The full user request still reaches Codex. Vex first decides whether the new message continues that task, starts a distinct task, or is a side question. It then chooses one agent, a read-only Luna scout plus completion, a saved plan, a scout followed by a saved plan, or a clarification question. When Vex chooses a plan route, Pace switches the conversation to planning mode and stops after saving the plan. `/execute` starts implementation only when the user invokes it. Vex chooses model and effort for each stage using prior structured handoffs.

Use `/manual` to choose a workflow before sending a task. Select **Plan only** for one planning agent or **Scout → Plan** when a Luna scout should inspect the repository first. The wizard asks for a model and effort at each stage; choosing **Delegate choice to Vex** lets Vex select them. The saved workflow applies to later turns in that conversation until `/manual`, `/models`, or `/auto` changes routing. `/manual <model> [effort]` remains available for a single-agent manual route.

Use `/workflow` to choose only the workflow and let Vex select every stage's model and effort. The choices are `single`, `scout`, `plan`, and `scout-plan`; `/workflow auto` returns workflow selection to Vex. In planning mode, `/verify [file] [prompt]` starts an optional fresh read-only review. The prompt can focus the review. The verifier reports findings and proposed plan changes in a bordered chat block. It never changes the saved plan. Vex chooses the strongest available model and reasoning for review. Continue with the planner using `/plan <changes>` or discuss findings with the verifier. `/execute` starts a separate writable conversation from the saved plan.

On the first automatic turn, Pace creates `~/.pace/routing-prompts.json` (`%USERPROFILE%\.pace\routing-prompts.json` on Windows) from [routing-prompts.default.json](routing-prompts.default.json). That repository file contains Vex workflow, task-relation, stage, model, effort, handoff, conversation-resolution, and execution recovery prompts. Edit the user copy to change routing on the next turn; the routing benchmark reads the same copy and records its hash. Pace refreshes an untouched older default and preserves edited files. Edited older copies keep their text on disk; Pace replaces retired planning choices with `plan` and `scout_plan` in memory. Saved manual planning workflows remain loadable and stop after a plan instead of running implementation or automatic verification. Keep `version: 1`; an invalid file stops automatic routing with a field-specific error. Model allowlists and effort levels remain in `~/.pace/config.json`.

At startup, Pace opens one persistent local MCP connection to Vex and shows its state above the prompt. Pace verifies the connection before each turn. Auto routing uses Vex's forced-choice contract: highest-ranked valid option wins even with a small lead; exact ties use supplied option order. Probabilities remain in the saved routing record. Invalid responses and tool failures are retried once, then shown as errors. There is no silent model fallback. Manual mode keeps its saved route. Vex forwards decision context to OpenRouter; it reads `OPENROUTER_API_KEY` from the environment or `~/.openrouter_key`. Vex receives user prompt and recent conversation text, so review that data before enabling auto mode for confidential projects.

When Vex chooses a split workflow, the scout runs in a fresh read-only thread and returns a concise JSON report with verified file findings, line references, next steps, checks, and risks. Pace validates and saves the report, then passes it to a completion or planning agent. Failed stages stop the turn. The saved turn records reports, per-stage models, usage, estimated cost, duration, and routing decisions. `/stats` reports raw usage and estimated API-equivalent cost separately. Actual billed Codex cost is not exposed by App Server usage reports. The price snapshot uses OpenAI Standard short-context rates and is saved with benchmark results.

To check routing choices across repeated labeled requests and compare actual workflow costs, use the commands in [benchmark/README.md](benchmark/README.md).

Codex receives Vex as a separate Codex-owned MCP stdio server, so Codex can call Vex tools during coding turns. Pace does not proxy those calls or make extra routing decisions for Codex. The app-server configuration forwards provider environment variable names, keeping their values out of command arguments. Pace resolves the project's actual filesystem path before starting Codex, including its original casing on Windows, while preserving case-insensitive session lookup. Request Approval is the default: main turns use a workspace-write sandbox with network access disabled and App Server `on-request` approvals. Full Access uses `danger-full-access` and no approval prompts. Limited uses a read-only sandbox and App Server `untrusted` approvals; Codex may run commands it considers trusted without prompting, while every typed Bash command needs approval. Scout and side turns remain read-only with approvals disabled in all modes. The mode selected when a turn starts stays with that turn.

### External MCP servers

Run `/mcp` inside Pace to open the interactive manager. Use arrows or Tab to select a server, add a stdio or HTTP server, refresh the list, remove a server, or log in and out with OAuth. Setup asks for an executable and each argument separately, or for a URL and optional bearer-token environment variable. Review the server before saving. Removal requires an explicit confirmation. OAuth output appears in the manager while you authenticate in your browser. Esc cancels pending work, cancels setup, or closes the manager.

Both the interactive manager and `pace mcp` use the bundled Codex CLI. They share Codex's `~/.codex/config.toml` (or the directory selected by `CODEX_HOME`) and credentials; there is no separate Pace server registry. Existing Codex servers are available during Pace turns. Trusted project configuration in `.codex/config.toml` also follows Codex's native rules. The CLI remains available for advanced authentication and configuration options. See [Codex MCP configuration](https://developers.openai.com/codex/mcp) for advanced settings.

```sh
# Local stdio server; arguments after -- belong to the server.
pace mcp add my-server -- node /absolute/path/to/server.js

# Streamable HTTP server with a token read from an environment variable.
pace mcp add my-http --url https://example.com/mcp --bearer-token-env-var MY_MCP_TOKEN

pace mcp list
pace mcp get my-server --json
pace mcp login my-http     # For servers that use OAuth instead of a bearer token.
pace mcp logout my-http
pace mcp remove my-server
pace mcp --help
```

Use `/mcp list` to print the configured external servers without opening the manager. The manager and list show configuration, not live connection health. Changes take effect on the next turn, including in a resumed conversation. Active turns retain their existing connections. Codex owns server startup, tool discovery, and tool execution, while Pace displays tool activity through its existing transcript. Pace's injected Vex server is managed separately and is not added to your Codex configuration by these commands.

Pace uses the `@sidearker/vex-mcp` npm package for Vex MCP routing and decision support. Pace resolves the installed package's bundled `dist/index.js` for both MCP connections. For local development with a local Vex checkout, you can link it or install the published `@sidearker/vex-mcp` release via `npm install @sidearker/vex-mcp@latest`. Do not set a key in Pace configuration or in command arguments.

To update Vex, run `npm install @sidearker/vex-mcp@latest`, then run `npm run build` and `npm test`. Commit both `package.json` and `package-lock.json` so installs use the same Vex revision.

On Windows, a project-local link also works without a global Vex command: build Vex, then run `New-Item -ItemType Junction -Path .\node_modules\@sidearker\vex-mcp -Target C:\Github\Vex` from Pace. Remove an existing `node_modules/@sidearker/vex-mcp` directory before creating the link.

## Sessions and safety

Pace writes config and up to 20 full user prompts and final Codex responses under `~/.pace`; each project uses a SHA-256 path key and each conversation has its own atomic JSON file. Codex owns its thread history in `~/.codex/sessions`. Interactive startup opens a new conversation. Pace stores the Codex thread ID for follow-ups within that conversation; after restarting, choose the saved conversation in the conversation picker to continue it. `/clear` and `/new` return to the entry screen with a fresh conversation. Auto mode routes each prompt; manual mode keeps its saved model and effort. Corrupt session files are skipped with a warning.

Pace runs Codex turns through the App Server protocol so it can answer command-approval requests in the terminal UI. Approval is per request. A declined request does not run. Pending approvals in background conversations show a warning; press ↓ and Enter to open the waiting conversation, then Y to approve once or N to decline. `/approval` (also `./approval`) opens a keyboard picker for Request Approval, Limited, and Full Access; ↑/↓ chooses a mode and Enter saves it. Non-interactive `pace exec` automatically declines approvals. Esc twice within 750 ms or Ctrl+C cancels an active turn, including one waiting for approval; cancellation is saved with the session. Approval mode is saved in `~/.pace/config.json`; snapshots of Codex plans are saved with each conversation for display after resume.

In the composer, press Alt+V to attach an image from the system clipboard. Ctrl+V also works when the terminal forwards that key to Pace; text pastes still work normally. Pace saves clipboard images under the project's ignored `.pace/pasted-images/` folder and attaches them to the Codex turn. WSL uses the Windows clipboard; Linux needs `wl-paste` or `xclip`, and macOS needs `pngpaste`. Images remain on disk so queued and resumed prompts can use them.

The App Server streams status, agent messages, and usage updates. While a turn runs, Pace shows observed input and output tokens and estimated API-equivalent cost beside the spinner, updating when App Server reports a new model request. The completed turn footer shows model, reasoning level, elapsed time, raw tokens, cache hits and writes, estimated cost, and route source. The Codex account usage bar stays visible and refreshes on startup, about every 30 seconds, and after each turn. Pace posts one chat warning when the reported 5-hour or 7-day remaining usage falls below 50%, 25%, or 10%. A warning can recur after that window recovers above its threshold and falls below it again. If a refresh fails, the bar keeps its last reading and marks it as stale. Some App Server messages arrive as completed items rather than token-by-token text. The App Server does not report token usage per command or message item.

When you ask Codex to create an artifact, Pace tells it to save a Markdown working note in the current conversation's `artifacts/` folder under `~/.pace/sessions/<project-key>/<conversation-id>/`. `/artifacts` lists these files and older project-local artifacts. Newly created or updated files are shown after a turn. Conversation artifacts stay with their session during a project reconnect.

Planning has one conversation mode. Pace reserves a plan path when planning starts. On a plan request the agent writes `<conversation>/artifacts/*.pace-plan.md` directly; on a revision it edits that same file unless asked for a separate plan. Questions receive chat answers and leave the file unchanged. Pace always displays the agent's reply unchanged and reports saved plan paths in separate system messages. The planning runner can write only in that conversation's artifact directory; project files remain read-only, approval prompts are disabled, and network access is off. Scouts and `/verify` remain read-only; `/verify` proposes specific plan changes in chat and never changes the saved plan. Existing project artifacts in `.pace/artifacts/` stay readable. Pace seeds `~/.pace/planning-instructions.md` from the bundled [`pace-planning`](skills/pace-planning/SKILL.md) defaults only if absent and reloads it for every planning turn. `/execute` starts a fresh agent with the entire saved plan as its handoff; the planning conversation and tool history are unavailable to it. Plans therefore include the original goal, constraints, findings, steps, acceptance criteria, and verification commands. The separate [Pace VS Code extension](extensions/vscode/README.md) opens these Markdown files as a reader and appears as an optional preview for other Markdown files. Install its packaged VSIX from [GitHub Releases](https://github.com/SideArker/Pace/releases); push a matching `ext-<version>` tag to build and publish each release automatically.

Pace bundles `grill-me`, `tdd`, `diagnosing-bugs`, `code-review`, `prototype`, and `pace-planning` in its `skills/` folder. Invoke `/grill-me <idea>` for an interview using the interactive question panel, `/tdd <behavior>` for test-driven development, `/diagnosing-bugs <symptom>` for a reproduction-driven investigation, `/code-review <scope>` for a review against standards and requirements, or `/prototype <question>` for a runnable design experiment. A bare command activates the skill for later turns; `/<skill> off` deactivates it. Bundled skills are available by default and can be disabled through `/skills disable <name>`. User skills with the same name take precedence. The four engineering skills are adapted from [Matt Pocock's skills](https://github.com/mattpocock/skills); see [source and adaptation notes](skills/UPSTREAM.md) and the bundled MIT license.

Bash mode runs **your typed command** through Bash in the project directory, outside Codex's sandbox. On Windows it uses Git Bash at `C:\Program Files\Git\bin\bash.exe`; on macOS/Linux it uses `bash` from PATH. Request Approval asks before recognizable risky commands such as `git push`, `git reset`, recursive removal, privileged commands, and data uploads. Limited asks before every typed command. In every mode, Pace blocks recognizable destructive disk commands and remote scripts piped into a shell. Full Access skips approval prompts, including prompts for risky commands. This pattern check is not a shell parser or a security boundary: aliases, generated commands, and shell expansion can bypass it. Codex commands are checked only when App Server asks Pace for approval; Full Access does not send those requests. Command output appears when the process exits and is capped at 32,768 characters. Bash commands may run while Codex works, so concurrent changes to the same files can conflict. The App Server requires a Git repository by default, and a real Codex turn requires working credentials; neither is simulated by the automated tests.

## Source layout

- `src/entrypoints/` holds the CLI and route-only benchmark commands.
- `src/components/` holds the terminal app, controls, and display formatting.
- `src/shared/` holds configuration and types used across modules.
- `src/core/routing/` holds route validation, prices, and routing prompts.
- `src/core/vex/` holds the Vex MCP client and request builders.
- `src/core/system/` holds file, Git, folder, and skill helpers.
- `src/core/` keeps turn orchestration, execution, and session storage at the top level.
- `benchmark/` groups suites, the execution runner, grading tools, and reports. See [benchmark/README.md](benchmark/README.md).

## Verify

```sh
npm run build
npm test
node dist/entrypoints/cli.js --help
node dist/entrypoints/cli.js doctor
```

Tests use mocked providers and a temporary storage directory. No API credentials are required. The roadmap in [ROADMAP.md](ROADMAP.md) covers later releases; v0.1 has no server, database, provider framework, or automatic agents.


`/debug [turn-number]` opens a local read-only trace for a saved turn (latest by default). Ctrl+O expands the complete trace: original request, Pace-added sections and sources, assembled stage prompts, actual App Server input when recorded, thread IDs and model/effort. Vex requests/validated decisions appear separately and are never presented as Codex input. Credentials and secret question values are redacted. Debug output is not sent to a model. Older turns explicitly report that effective input was not recorded.

Pace planning keeps the Markdown artifact as its durable handoff and restricts writes to the artifact directory. Native Codex plan updates show in the task panel and material unresolved choices use the interactive question panel. Existing custom planning instructions are preserved. The current VS Code plan reader remains supported.

Debug checkouts expose the [fresh-completion benchmark](benchmark/README.md) through `/benchmark` and `npm run benchmark -- ...`. Its fixed-route, matched same/fresh-thread comparison is experimental; production continues using its saved main thread.
