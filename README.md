# Pace

Pace is an independent, terminal-only coding client. The official [Codex App Server](https://developers.openai.com/codex/app-server) runs coding turns; the [Vex MCP server](https://github.com/SideArker/Vex) can recommend a configured model and effort for each automatic turn. Pace is not an OpenAI product.

## Install and run

Requires Node.js 20+, a terminal, and working Codex authentication. Sign in with the [Codex CLI](https://developers.openai.com/codex/cli) (`codex login`) or use a supported Codex SDK/CLI environment credential. Pace never reads or stores a token itself. A Git project is expected by Codex.

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

For development, use `npm run dev` instead of linking. Interactive `pace` opens a fresh conversation; use `/resume` to continue a saved one. `pace --help` and `pace --version` work without authentication. `pace doctor` checks Node, local storage, Git presence, SDK installation, Vex server installation, and configuration; only a live coding turn verifies authentication and runtime access.

`pace sessions` lists saved conversations across projects. It marks moved or deleted project folders as missing. `/resume` groups conversations by project and blocks missing paths. To reconnect conversations after a folder move, run `pace reconnect "old path" "new path"` with the old path shown by `pace sessions` and the existing new project directory, then reopen `/resume`. The command preserves conversation IDs, turns, Codex thread IDs, and the active conversation. It refuses a destination that already has saved conversations and retains the original session files under `~/.pace/reconnected` as a rollback copy. You can also restore the folder at its original path. `pace doctor` connects to Vex MCP and checks for `vex_choose`; it exits with status 1 when Vex is unavailable. Its error names discovery, startup, connection, or tool validation. Manual routes remain available when Vex is down.

The Windows PowerShell smoke workflow installs, builds, links, and checks the CLI entrypoint and missing-prompt exit status. Run the same install commands above in a Windows Terminal PowerShell profile to check interactive rendering. To test the installed Vex MCP server without requesting a model decision, run `PACE_REAL_VEX=1 npx vitest run tests/vex-real.test.ts` in Bash, or `$env:PACE_REAL_VEX='1'; npx vitest run tests/vex-real.test.ts` in PowerShell.

## Chat commands

| Command | Action |
| --- | --- |
| `/models` | Open the live Codex model menu; Space toggles a model, Enter opens its reasoning levels |
| `/version` | Refresh GitHub release and price data; show the installed and latest reported Pace versions |
| `/auto` | Enable Vex routing for the next turn, including in a resumed conversation |
| `/manual` | Open a workflow wizard; choose each stage's model and effort or delegate either choice to Vex |
| `/workflow [name\|auto]` | Choose a workflow from a menu or by name; Vex chooses its stage routes |
| `/new` | Alias for `/clear` |
| `/resume` | Open saved conversations, including turns still running in this Pace process |
| `/compact` | Compact the selected idle Codex thread while keeping its thread ID |
| `/context` | Show the current Codex thread, last measured context occupancy, and checkpoint status |
| `/route` | Show the latest recorded Vex choices and route used |
| `/usage` | Refresh Codex account usage percentages |
| `/cancelretry` | Cancel a saved usage-limit retry and clear its queued prompts |
| `/artifacts` | List Markdown artifacts in this project's `.pace/artifacts` directory |
| `/approval [full-access\|request-approval\|limited]` | Open mode picker or set the mode for new turns |
| `/tasks` | Show Codex's latest plan steps for this conversation |
| `/trust add <folder>` | Allow Codex to edit an additional existing folder |
| `/trust remove <folder>` | Remove an additional folder; `/trust list` shows current entries |
| `/skills [folder]` | Discover skills in the default or selected folder; `/skills` refreshes the list |
| `/skills enable <name>` / `/skills disable <name>` | Enable or disable a discovered skill command |
| `/skills default` / `/skills off` | Use the default skill folder or turn skill discovery off |
| `/<skill> [request]` | Invoke an enabled skill, such as `/caveman` or `/caveman explain this` |
| `/stats` | Show observed time, tokens, and failures for the last 20 turns, plus compactions and checkpoints |
| `/clear` | Clear the terminal, show the entry screen, and start a new conversation |
| `/exit` | Quit |
| `! <command>` | Run one Bash command in the project directory |
| `!` | Toggle Bash input mode; type `!` again to return to Pace |

Type `/` to see a command menu. Use Tab to complete and ↑/↓ to choose a match. In `/models`, use ↑/↓ or Tab to select, Space to enable or disable, Enter to open reasoning levels, M to use the highlighted model and effort manually, and Esc to go back. Each turn has separate **You** and **Pace** sections, followed by a compact, gray model, timing, usage, and route footer. A divider separates turns. A spinner marks active work; status text comes from Codex App Server events. Occasional tips appear beside the status while the agent works. Active commands appear below the input with elapsed time, and the selected approval mode appears in the input footer. When Codex publishes a plan, Pace mirrors its steps below the input and in `/tasks`; Codex owns their progress. When an action needs approval, press Y to approve it once, N to decline, or Esc twice within 750 ms to cancel the turn. While a turn runs, send another prompt to queue it for that conversation. Queued prompts appear in a bordered box between Pace's messages and the input. Prompts run oldest first after each turn, including ordinary failures. A Codex usage-limit failure pauses the queue until Pace retries the interrupted request. Press ↓ then → to select a queued prompt for editing, or press → in an empty composer to edit the next prompt. Alt+Del removes the latest queued prompt. Esc twice within 750 ms or Ctrl+C cancels the active turn and clears its queue. Use `/new` to start another conversation or `/resume` to switch. Background turns continue and their responses appear when you return. A saved conversation moves from "Saved conversations" to "This pace" when you send a new message in it; its session and history stay the same. With background turns running, Ctrl+C keeps Pace open; `/exit` quits. When no turns run, Ctrl+C exits. Input stays available during a Codex turn so Bash commands can run concurrently.

If Codex reports a usage limit during an interactive turn, Pace saves the interrupted request and displays its retry time. It retries after the reported account reset while Pace remains open, or after the next launch if that time has passed. The resumed agent is instructed to inspect existing files before editing to avoid repeating completed changes. New requests in that conversation queue behind the saved retry. `/cancelretry` cancels the retry and clears that queue. Queued prompts remain paused until the retry finishes while Pace stays open; queued prompts are not saved across exits. If neither saved task state nor the Codex thread identifies the original task, Pace asks for the missing request or plan instead of repeatedly asking for a deliverable.

After opening a second conversation, a compact picker stays below the input. Press ↓ from the input to focus it, use ↑/↓ to select a conversation, and press Enter to switch. Esc returns to the input. Switching keeps other conversation turns running.

Pace shows routing and stage activity in the live status. `/route` and `/stats` retain the detailed decisions and stage records.
The header's Context gauge and `/context` use the last measured Codex model request and its context-window limit. `Context ?` means Pace has no valid measurement for the selected thread and model. They are separate from `/usage`, which shows account limits. `/context` also says whether the next turn resumes a Codex thread; `/new` starts a separate conversation and `/resume` returns to a saved one. `/compact` works only when that conversation has an idle Codex thread; Esc twice within 750 ms or Ctrl+C cancels it. Pace records compaction usage, estimated API-equivalent cost, duration, and outcome separately from user turns in `/stats`. The gauge becomes unknown after compaction until another model request reports context usage.

After 16 turns in one Codex thread, or when measured context reaches 75%, Pace asks that thread for a bounded, structured checkpoint. The next turn starts a fresh thread with the validated checkpoint and current request. Pace keeps the old thread ID in the checkpoint record and counts turns in the new thread separately. A failed checkpoint leaves the existing thread available.
The interactive transcript renders Markdown emphasis, inline and fenced code, links, headings, quotes, horizontal rules, nested bullet and numbered lists, task lists, and tables. Level-three headings (`###`) receive a distinct accent. Tables fit the available terminal width by shortening long cells. Markdown links are clickable in terminals that support OSC 8 hyperlinks; their destinations remain visible in other terminals.

## Non-interactive runs

Run `pace exec "your request"` from a project directory to continue its active conversation without Ink. Pass the whole request as one quoted argument. PowerShell can use `$prompt = @'` followed by text and a closing `'@`, then `pace exec $prompt`. Bash and Zsh can use `pace exec $'first line\nsecond line'`. Pace preserves embedded newlines, writes only the final response to stdout, and writes progress errors and approval denials to stderr. It returns 0 on success, 1 on provider, configuration, or execution failure, 2 for a missing prompt, and 130 after Ctrl+C. It declines every noninteractive approval, keeps the saved session ID and turn metadata, and uses the same routing, trusted folders, and skill settings as interactive turns.

## Trusted folders and skills

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

Configure only models and effort values you can use. Pace validates SDK effort values. `max` is not a Pace SDK effort. Auto mode needs verified prices for every enabled model and accepts at most 12 model and effort pairs. Invalid config, missing prices, or too many pairs stop routing with an error. Manual mode can use a discovered model without a price estimate; provider errors from a live turn remain visible.

Pace bundles [versions.json](versions.json) and refreshes it from this repository's `main` branch at startup and before automatic routing. The file provides dated Standard API prices, optional model menu hints, and the latest Pace release version. A validated copy is cached under `~/.pace/versions-cache.json` for offline use. The menu uses Codex's live catalog when available; GitHub pricing does not grant model access. `/version` shows which catalog source is in use. Update `versions.json` when a new model price is verified and when publishing a Pace release; `package.json` remains the installed version source.

Pace sends Vex the latest request, bounded excerpts of ten recent turns, a brief of the active task, unfinished steps, the previous route, thread state, configured models and efforts, capability descriptions, and a dated Standard API price snapshot. The full user request still reaches Codex. Vex first decides whether the new message continues that task, starts a distinct task, or is a side question. It then chooses one agent, a read-only Luna scout plus completion, planning plus execution, scout plus planning plus execution for unusually broad implementation, planning plus verification, or a clarification question. It considers the resolved deliverable, Sol High quality, total Codex cost, and stage latency. Plan-only requests stay plan-only unless a later turn asks to implement. Vex chooses model and effort for each stage using prior structured handoffs.

Use `/manual` to choose a workflow before sending a task. For example, select **Planning → Verification**, Luna for planning, and Sol for verification. The wizard asks for an effort at each stage; choosing **Delegate choice to Vex** for an effort keeps the chosen model and lets Vex choose its effort. Both stages in this workflow run read only, and the verifier returns the final plan. The saved workflow applies to later turns in that conversation until `/manual`, `/models`, or `/auto` changes routing. `/manual <model> [effort]` remains available for a single-agent manual route.

Use `/workflow` to choose only the workflow and let Vex select every stage's model and effort. `/workflow plan-verify` selects planning followed by verification directly; `/workflow auto` returns workflow selection to Vex. Other names are `single`, `scout`, `plan-execute`, and `scout-plan-execute`.

On the first automatic turn, Pace creates `~/.pace/routing-prompts.json` (`%USERPROFILE%\.pace\routing-prompts.json` on Windows) from [routing-prompts.default.json](routing-prompts.default.json). That repository file contains Vex workflow, task-relation, stage, model, effort, handoff, conversation-resolution, and execution recovery prompts. Edit the user copy to change routing on the next turn; the routing benchmark reads the same copy and records its hash. Pace refreshes an untouched older default and preserves edited files. Existing version 1 copies receive defaults in memory for newly added fields and the `scout_plan_execute` and `plan_verify` choices. Keep `version: 1` and the original four choice keys; added choices are optional in edited copies. An invalid file stops automatic routing with a field-specific error. Model allowlists and effort levels remain in `~/.pace/config.json`.

At startup, Pace opens one persistent local MCP connection to Vex and shows its state above the prompt. Pace verifies the connection before each turn. Auto routing uses Vex's forced-choice contract: highest-ranked valid option wins even with a small lead; exact ties use supplied option order. Probabilities remain in the saved routing record. Invalid responses and tool failures are retried once, then shown as errors. There is no silent model fallback. Manual mode keeps its saved route. Vex forwards decision context to OpenRouter; it reads `OPENROUTER_API_KEY` from the environment or `~/.openrouter_key`. Vex receives user prompt and recent conversation text, so review that data before enabling auto mode for confidential projects.

When Vex chooses a split workflow, preparatory stages run in fresh read-only threads. Each returns a concise JSON report with verified file findings, line references, next steps, checks, and risks. In the three-stage workflow, planning receives the scout report and execution receives both reports. Pace validates and saves each report. The main agent verifies relevant findings before editing. Failed stages stop the turn. The saved turn records reports, per-stage models, usage, estimated cost, duration, and routing decisions. `/stats` reports raw usage and estimated API-equivalent cost separately. Actual billed Codex cost is unavailable through the SDK. The price snapshot uses OpenAI Standard short-context rates and is saved with benchmark results.

To check routing choices across repeated labeled requests and compare actual workflow costs, use the commands in [benchmark/README.md](benchmark/README.md).

Codex receives Vex as a separate Codex-owned MCP stdio server, so Codex can call Vex tools during coding turns. Pace does not proxy those calls or make extra routing decisions for Codex. The app-server configuration forwards provider environment variable names, keeping their values out of command arguments. Pace resolves the project's actual filesystem path before starting Codex, including its original casing on Windows, while preserving case-insensitive session lookup. Request Approval is the default: main turns use a workspace-write sandbox with network access disabled and App Server `on-request` approvals. Full Access uses `danger-full-access` and no approval prompts. Limited uses a read-only sandbox and App Server `untrusted` approvals; Codex may run commands it considers trusted without prompting, while every typed Bash command needs approval. Scout and side turns remain read-only with approvals disabled in all modes. The mode selected when a turn starts stays with that turn.

Pace uses the `@sidearker/vex-mcp` npm package for Vex MCP routing and decision support. Pace resolves the installed package's bundled `dist/index.js` for both MCP connections. For local development with a local Vex checkout, you can link it or install the published `@sidearker/vex-mcp` release via `npm install @sidearker/vex-mcp@latest`. Do not set a key in Pace configuration or in command arguments.

To update Vex, run `npm install @sidearker/vex-mcp@latest`, then run `npm run build` and `npm test`. Commit both `package.json` and `package-lock.json` so installs use the same Vex revision.

On Windows, a project-local link also works without a global Vex command: build Vex, then run `New-Item -ItemType Junction -Path .\node_modules\@sidearker\vex-mcp -Target C:\Github\Vex` from Pace. Remove an existing `node_modules/@sidearker/vex-mcp` directory before creating the link.

## Sessions and safety

Pace writes config and up to 20 full user prompts and final Codex responses under `~/.pace`; each project uses a SHA-256 path key and each conversation has its own atomic JSON file. Codex owns its thread history in `~/.codex/sessions`. Interactive startup opens a new conversation. Pace stores the Codex thread ID for follow-ups within that conversation; after restarting, use `/resume` to continue it. `/clear` and `/new` return to the entry screen with a fresh conversation. Auto mode routes each prompt; manual mode keeps its saved model and effort. Corrupt session files are skipped with a warning.

Pace runs Codex turns through the App Server protocol so it can answer command-approval requests in the terminal UI. Approval is per request. A declined request does not run. Pending approvals in background conversations show a warning; press ↓ and Enter to open the waiting conversation, then Y to approve once or N to decline. `/approval` (also `./approval`) opens a keyboard picker for Request Approval, Limited, and Full Access; ↑/↓ chooses a mode and Enter saves it. Non-interactive `pace exec` automatically declines approvals. Esc twice within 750 ms or Ctrl+C cancels an active turn, including one waiting for approval; cancellation is saved with the session. Approval mode is saved in `~/.pace/config.json`; snapshots of Codex plans are saved with each conversation for display after resume.

In the composer, press Alt+V to attach an image from the system clipboard. Ctrl+V also works when the terminal forwards that key to Pace; text pastes still work normally. Pace saves clipboard images under the project's ignored `.pace/pasted-images/` folder and attaches them to the Codex turn. WSL uses the Windows clipboard; Linux needs `wl-paste` or `xclip`, and macOS needs `pngpaste`. Images remain on disk so queued and resumed prompts can use them.

The App Server streams status, agent messages, and usage updates. While a turn runs, Pace shows observed input and output tokens and estimated API-equivalent cost beside the spinner, updating when App Server reports a new model request. The completed turn footer shows model, reasoning level, elapsed time, raw tokens, cache hits and writes, estimated cost, and route source. The Codex account usage bar stays visible and refreshes on startup, about every 30 seconds, and after each turn; `/usage` requests a refresh. Pace posts one chat warning when the reported 5-hour or 7-day remaining usage falls below 50%, 25%, or 10%. A warning can recur after that window recovers above its threshold and falls below it again. If a refresh fails, the bar keeps its last reading and marks it as stale. Some App Server messages arrive as completed items rather than token-by-token text. The App Server does not report token usage per command or message item.

When you ask Codex to create an artifact, Pace tells it to save a Markdown working note in the project-local `.pace/artifacts/` directory. These files persist across conversations and can be reused by asking Codex to read or update them. `/artifacts` lists them; newly created or updated files are shown after a turn. Artifact files are regular project files under Codex's workspace sandbox.

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
