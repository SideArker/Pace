# Pace

Pace is an independent, terminal-only coding client. The official [Codex TypeScript SDK](https://github.com/openai/codex/tree/main/sdk/typescript) runs coding turns; the [Vex MCP server](https://github.com/SideArker/Vex) can recommend a configured model and effort for each automatic turn. Pace is not an OpenAI product.

## Install and run

Requires Node.js 20+, a terminal, and working Codex authentication. Sign in with the [Codex CLI](https://developers.openai.com/codex/cli) (`codex login`) or use a supported Codex SDK/CLI environment credential. Pace never reads or stores a token itself. A Git project is expected by the SDK.

On Windows PowerShell:

```powershell
npm ci
npm run build
npm link
pace doctor
pace
```

On macOS or Linux:

```sh
npm ci
npm run build
npm link
pace doctor
pace
```

For development, use `npm run dev` instead of linking. Interactive `pace` opens a fresh conversation; use `/resume` to continue a saved one. `pace --help` and `pace --version` work without authentication. `pace doctor` checks Node, local storage, Git presence, SDK installation, Vex server installation, and configuration; only a live coding turn verifies authentication and runtime access.

## Chat commands

| Command | Action |
| --- | --- |
| `/help` | Show commands and Ctrl+C behavior |
| `/models` | Open the model menu; Space toggles a model, Enter opens its reasoning levels |
| `/auto` | Enable Vex routing for the next turn, including in a resumed conversation |
| `/new` | Alias for `/clear` |
| `/resume` | Open a saved conversation picker for this project |
| `/usage` | Refresh Codex account usage percentages |
| `/artifacts` | List Markdown artifacts in this project's `.pace/artifacts` directory |
| `/trust add <folder>` | Allow Codex to edit an additional existing folder |
| `/trust remove <folder>` | Remove an additional folder; `/trust list` shows current entries |
| `/skills <folder>` | Discover skills in a selected folder; `/skills` refreshes and `/skills off` clears it |
| `/route` | Show the last recorded model, effort, and route explanation |
| `/stats` | Show observed time, tokens, and failures for the current conversation's last 20 turns |
| `/clear` | Clear the terminal, show the entry screen, and start a new conversation |
| `/exit` | Quit |
| `! <command>` | Run one Bash command in the project directory |
| `!` | Toggle Bash input mode; type `!` again to return to Pace |

Type `/` to see a command menu. Use Tab to complete and ↑/↓ to choose a match. In `/models`, use ↑/↓ or Tab to select, Space to enable or disable, Enter to open reasoning levels, and Esc to go back. Each turn has separate **You** and **Pace** sections, followed by a compact, gray model, timing, usage, and route footer. A divider separates turns. A spinner marks active work; status text comes from Codex SDK events. Ctrl+C cancels the current Codex turn; when idle, it exits. Input stays available during a Codex turn so Bash commands can run concurrently.

## Non-interactive runs

Run `pace exec "your request"` from a project directory to continue its active conversation without Ink. Pace writes the final response to stdout. It returns 0 on success, 1 on provider, configuration, or execution failure, 2 for a missing prompt, and 130 after Ctrl+C. Errors go to stderr. This command uses the same routing, trusted folders, skill folder, and session storage as interactive turns.

## Trusted folders and skills

Use `/trust add C:\path\to\folder` to give Codex workspace-write access to an existing folder outside the project. Pace resolves and checks each folder before every coding turn. Remove access with `/trust remove <folder>`. Trusted folders are stored in `~/.pace/config.json` as `trustedFolders`. Side questions stay read-only and do not receive trusted folders.

Use `/skills C:\path\to\skills` to select a folder containing `<skill-name>/SKILL.md` directories. Pace lists discovered names and descriptions, then passes their metadata and file paths to Codex on coding turns. Codex reads a relevant `SKILL.md` when it chooses to use the skill. Pace scans the selected folder and its immediate children, up to 32 skills. The folder is not granted write access unless you separately trust it. Use `/skills off` to stop including it. The setting is `skillFolder` in `~/.pace/config.json`.

## Models and routing

With a fresh config, Pace enables Luna (`low`, `medium`, `high`), Sol (`medium`, `high`, `xhigh`, `ultra`), and Astra (`high`, `xhigh`, `ultra`). Existing configs keep their saved allowlists and effort levels. Open `/models` to change them; a newly enabled model starts with medium reasoning. Additional model IDs can be configured in `~/.pace/config.json`. Disabled models are never offered to Vex or Codex. If every model is off, Pace stops the turn and asks you to enable one. An existing Codex thread cannot continue while its saved model is off; use `/new` or enable that model again.

Pace cannot query which models your account can use. The menu offers `gpt-6-sol`, `gpt-6-luna`, and `gpt-6-astra` as examples; access depends on account and workspace. You can also edit `~/.pace/config.json` (`%USERPROFILE%\.pace\config.json` on Windows) directly:

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

Configure only models and effort values you can use. Pace validates known GPT-6 model and SDK effort pairs. `max` is not a Pace SDK effort. Auto mode needs verified prices for every enabled model and accepts at most 12 model and effort pairs. Invalid config, missing prices, or too many pairs stop routing with an error. Availability still needs a live Codex turn; provider errors remain visible. Manual mode can use a custom configured model without a price estimate.

Pace sends Vex the original request, six recent conversation turns, configured model and effort pairs, model capabilities, effort descriptions, and a dated Standard API price snapshot. It does not classify or rewrite the request with keyword rules. Vex first chooses one agent, a read-only Luna scout plus completion, a planning agent plus execution, or a clarification question. It considers the requested deliverable, Sol High quality, and estimated total Codex cost. Plan-only requests must stay plan-only. It then chooses model and effort together for each Codex stage, using the prior stage's structured handoff when present.

On the first automatic turn, Pace creates `~/.pace/routing-prompts.json` (`%USERPROFILE%\.pace\routing-prompts.json` on Windows) from [routing-prompts.default.json](routing-prompts.default.json). Edit that file to change the Vex workflow and stage questions, constraints, choice descriptions, stage objectives, model and effort descriptions, and scout/planning handoff instructions. Pace reads it at the start of each automatic turn, so edits take effect on the next turn; the routing benchmark reads the same file and records its hash. Keep the four workflow choice keys (`single`, `scout`, `plan_execute`, `clarify`) and `version: 1`. An invalid file stops automatic routing with a field-specific error. Model allowlists and effort levels remain in `~/.pace/config.json`.

At startup, Pace opens one persistent local MCP connection to Vex and shows its state above the prompt. Pace verifies the connection before each turn. Auto routing uses Vex's forced-choice contract: highest-ranked valid option wins even with a small lead; exact ties use supplied option order. Probabilities remain in the saved routing record. Invalid responses and tool failures are retried once, then shown as errors. There is no silent model fallback. Manual mode keeps its saved route. Vex forwards decision context to OpenRouter; it reads `OPENROUTER_API_KEY` from the environment or `~/.openrouter_key`. Vex receives user prompt and recent conversation text, so review that data before enabling auto mode for confidential projects.

When Vex chooses a split workflow, the first Codex stage runs in a fresh read-only thread with the original request and recent conversation. It returns a concise JSON report with verified file findings, line references, next steps, checks, and risks. Pace validates and saves that report, then routes the completion stage using it. The main agent receives the report but never the scout's thread or tool history; it verifies relevant findings before editing. Failed stages stop the turn. The saved turn records the report, per-stage models, usage, estimated cost, duration, and routing decisions. `/stats` reports raw usage and estimated API-equivalent cost separately. Actual billed Codex cost is unavailable through the SDK. The price snapshot uses OpenAI Standard short-context rates and is saved with benchmark results.

To check routing choices across repeated labeled requests and compare actual workflow costs, use the commands in [benchmark/README.md](benchmark/README.md).

The Codex SDK also receives Vex as a separate Codex-owned MCP stdio server, so Codex can call Vex tools during coding turns. Pace does not proxy those calls or make extra routing decisions for Codex. The SDK configuration forwards the `OPENROUTER_API_KEY` environment variable by name, keeping its value out of command arguments. Pace resolves the project's actual filesystem path before starting Codex, including its original casing on Windows, while preserving case-insensitive session lookup. Pace uses a workspace-write sandbox with network access disabled and approval policy `never`; work outside those boundaries remains restricted.

Pace pins the Vex GitHub dependency to commit `3a796ddc07a66f03bbe6121611880c4234789acf`, which builds Vex during Git installs. That commit must be pushed to GitHub before a fresh `npm ci` can resolve it. For local development while the commit is only in a Vex checkout, run `npm run build` there, then run `npm link C:\Github\Vex` in the Pace checkout. Pace resolves the installed package's bundled `dist/index.js` for both MCP connections. Run `npm ci` after the commit is available on GitHub to restore the locked dependency. Do not set a key in Pace configuration or in command arguments.

To update Vex, commit and push the Vex change first. In Pace, run `npm install 'vex-mcp@git+https://github.com/SideArker/Vex.git#<commit>'`, then run `npm run build` and `npm test`. Commit both `package.json` and `package-lock.json` so installs use the same Vex revision.

On Windows, a project-local link also works without a global Vex command: build Vex, then run `New-Item -ItemType Junction -Path .\node_modules\vex-mcp -Target C:\Github\Vex` from Pace. Remove an existing `node_modules/vex-mcp` directory before creating the link.

## Sessions and safety

Pace writes config and up to 20 full user prompts and final Codex responses under `~/.pace`; each project uses a SHA-256 path key and each conversation has its own atomic JSON file. Codex owns its thread history in `~/.codex/sessions`. Interactive startup opens a new conversation. Pace stores the Codex thread ID for follow-ups within that conversation; after restarting, use `/resume` to continue it. `/clear` and `/new` return to the entry screen with a fresh conversation. Auto mode routes each prompt; manual mode keeps its saved model and effort. Corrupt session files are skipped with a warning.

Pace runs SDK turns in `workspace-write` mode with network access disabled and approval policy `never`. This is a restricted mode: actions requiring higher permissions are denied rather than approved. The TypeScript SDK used here does not expose an in-app approval response interface, so Pace has no interactive approval prompt. It does not enable unrestricted access or bypass Codex safeguards.

The SDK streams documented status and agent-message events. Pace shows model, reasoning level, elapsed time, raw input and output tokens, cache hits and writes, estimated cost, and route source. It also reads Codex account rate limits on startup and after each turn. Use `/usage` to refresh them. Some SDK messages arrive as completed items rather than token-by-token text. The SDK does not report token usage per command or message item.

When you ask Codex to create an artifact, Pace tells it to save a Markdown working note in the project-local `.pace/artifacts/` directory. These files persist across conversations and can be reused by asking Codex to read or update them. `/artifacts` lists them; newly created or updated files are shown after a turn. Artifact files are regular project files under Codex's workspace sandbox.

Bash mode runs **your typed command** through Bash in the project directory, outside Codex's sandbox. On Windows it uses Git Bash at `C:\Program Files\Git\bin\bash.exe`; on macOS/Linux it uses `bash` from PATH. Command output appears when the process exits and is capped at 32,768 characters. Bash commands may run while Codex works, so concurrent changes to the same files can conflict. The SDK requires a Git repository by default, and a real Codex turn requires working credentials; neither is simulated by the automated tests.

## Source layout

- `src/core/routing/` holds route validation, prices, and routing prompts.
- `src/core/vex/` holds the Vex MCP client and request builders.
- `src/core/system/` holds file, Git, folder, and skill helpers.
- `src/core/` keeps turn orchestration, execution, and session storage at the top level.
- `benchmark/` groups suites, the execution runner, grading tools, and reports. See [benchmark/README.md](benchmark/README.md).

## Verify

```sh
npm run build
npm test
node dist/cli.js --help
node dist/cli.js doctor
```

Tests use mocked providers and a temporary storage directory. No API credentials are required. The roadmap in [ROADMAP.md](ROADMAP.md) covers later releases; v0.1 has no server, database, provider framework, or automatic agents.
