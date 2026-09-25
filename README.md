# Pace 0.1

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

For development, use `npm run dev` instead of linking. `pace --help` and `pace --version` work without authentication. `pace doctor` checks Node, local storage, Git presence, SDK installation, Vex server installation, and configuration; only a live coding turn verifies authentication and runtime access.

## Chat commands

| Command | Action |
| --- | --- |
| `/help` | Show commands and Ctrl+C behavior |
| `/models` | Open the model menu; Space toggles a model, Enter opens its reasoning levels |
| `/auto` | Enable Vex routing for the next turn, including in a resumed conversation |
| `/new` | Start a fresh Pace and Codex conversation |
| `/resume` | Open a saved conversation picker for this project |
| `/usage` | Refresh Codex account usage percentages |
| `/artifacts` | List Markdown artifacts in this project's `.pace/artifacts` directory |
| `/clear` | Clear the visible terminal transcript; keep the Codex conversation |
| `/exit` | Quit |
| `! <command>` | Run one Bash command in the project directory |
| `!` | Toggle Bash input mode; type `!` again to return to Pace |

Type `/` to see a command menu. Use Tab to complete and ↑/↓ to choose a match. In `/models`, use ↑/↓ or Tab to select, Space to enable or disable, Enter to open reasoning levels, and Esc to go back. Each turn has separate **You** and **Pace** sections, followed by a compact, gray model, timing, usage, and route footer. A divider separates turns. A spinner marks active work; status text comes from Codex SDK events. Ctrl+C cancels the current Codex turn; when idle, it exits. Input stays available during a Codex turn so Bash commands can run concurrently.

## Models and routing

By default, Pace passes no model or effort override, leaving model choice to Codex. Open `/models` to enable a listed model; a newly enabled model starts with medium reasoning, and its reasoning levels can be changed in the menu. Additional model IDs can be configured in `~/.pace/config.json`. With an explicit list, Pace does not send disabled models to Vex or Codex. If every model is off, Pace stops the turn and asks you to enable one. An existing Codex thread cannot continue while its saved model is off; use `/new` or enable that model again.

Pace cannot query which models your account can use. The menu offers `gpt-6-sol`, `gpt-6-luna`, and `gpt-6-astra` as examples; access depends on account and workspace. You can also edit `~/.pace/config.json` (`%USERPROFILE%\.pace\config.json` on Windows) directly:

```json
{
  "routingMode": "auto",
  "defaultRoute": { "model": "gpt-6-sol", "effort": "medium" },
  "models": [
    { "model": "gpt-6-sol", "efforts": ["medium"], "defaultEffort": "medium" },
    { "model": "gpt-6-luna", "efforts": ["medium"], "defaultEffort": "medium", "enabled": false }
  ]
}
```

Configure only models and effort values you can use. Pace validates effort names against its supported list and each model's configured list. `max` is not a Pace effort. An invalid config stops coding turns until fixed; Pace does not silently discard an explicit allowlist. Availability still needs a live Codex turn; provider errors remain visible. `defaultRoute` may be `{}`; once models are configured, Pace uses the first enabled model as its fallback. With fewer than two enabled model and effort pairs, auto mode uses the fallback without calling Vex. Vex accepts at most 12 pairs; larger lists also use the fallback. If the SDK chose an unknown default model for an older thread, start a new thread after configuring an allowlist.

At startup, Pace opens one persistent local MCP connection to Vex and shows its state above the prompt. Coding turns stay blocked until the connection succeeds. Pace verifies the connection before each turn and stops if Vex or `vex_choose` fails. Before every auto-routed turn, including follow-ups in a saved Codex thread, it calls `vex_choose` with the enabled model and effort pairs. Pace passes the selected model and effort to the SDK when resuming that thread, so a short follow-up can use a lighter model without losing the conversation. Pace validates Vex's versioned choice, confidence, probability lead, and allowlist membership before applying it. If Vex abstains because an individual route lacks confidence but its probabilities strongly agree on one model, Pace selects that model and its highest-probability enabled effort, labeling the result as model consensus. Short factual and current-information lookups, including weather questions, use enabled `gpt-6-luna` low even if Vex suggests a heavier route; long requests and sensitive architecture do not use this shortcut. Other uncertain choices use policy routes, with sensitive architecture assigned to a high-effort model when available. A connection or tool error blocks the turn. Manual mode continues its saved route. Pace sends only a coarse task category, request-length band, predefined task intent, boolean task signals, configured route options, and a routing rubric. It does **not** send the prompt, repository files, paths, or credentials in the decision request. Vex forwards the request to OpenRouter; it reads `OPENROUTER_API_KEY` from the environment or `~/.openrouter_key`.

The Codex SDK also receives Vex as a separate Codex-owned MCP stdio server, so Codex can call Vex tools during coding turns. Pace does not proxy those calls or make extra routing decisions for Codex. The SDK configuration forwards the `OPENROUTER_API_KEY` environment variable by name, keeping its value out of command arguments. Pace resolves the project's actual filesystem path before starting Codex, including its original casing on Windows, while preserving case-insensitive session lookup. Pace uses a workspace-write sandbox with network access disabled and approval policy `never`; work outside those boundaries remains restricted.

Pace pins the Vex GitHub dependency to commit `a2e83f0cf53411746de9ae9d59869b7b312d25c8`, which builds Vex during Git installs. That commit must be pushed to GitHub before a fresh `npm ci` can resolve it. For local development while the commit is only in a Vex checkout, run `npm run build` there, then run `npm link C:\Github\Vex` in the Pace checkout. Pace resolves the installed package's bundled `dist/index.js` for both MCP connections. Run `npm ci` after the commit is available on GitHub to restore the locked dependency. Do not set a key in Pace configuration or in command arguments.

To update Vex, commit and push the Vex change first. In Pace, run `npm install 'vex-mcp@git+https://github.com/SideArker/Vex.git#<commit>'`, then run `npm run build` and `npm test`. Commit both `package.json` and `package-lock.json` so installs use the same Vex revision.

On Windows, a project-local link also works without a global Vex command: build Vex, then run `New-Item -ItemType Junction -Path .\node_modules\vex-mcp -Target C:\Github\Vex` from Pace. Remove an existing `node_modules/vex-mcp` directory before creating the link.

## Sessions and safety

Pace writes config and short, user-visible turn summaries under `~/.pace`; each project uses a SHA-256 path key and each conversation has its own atomic JSON file. Codex owns its thread history in `~/.codex/sessions`. Pace stores the Codex thread ID and resumes it for follow-ups and restarts. Auto mode routes each prompt; manual mode keeps its saved model and effort. Use `/new` to start a separate conversation. Corrupt session files are skipped with a warning.

Pace runs SDK turns in `workspace-write` mode with network access disabled and approval policy `never`. This is a restricted mode: actions requiring higher permissions are denied rather than approved. The TypeScript SDK used here does not expose an in-app approval response interface, so Pace has no interactive approval prompt. It does not enable unrestricted access or bypass Codex safeguards.

The SDK streams documented status and agent-message events. Pace shows a compact footer with model, reasoning level, elapsed time, input and output tokens, cached input, and route source after each turn. Pace also reads Codex account rate limits on startup and after each turn, showing the reported usage percentage for each available time window. Use `/usage` to refresh it. If the account usage read fails, Pace says `Usage unavailable`; coding turns still work. When no override is set, it says `Codex default` because the SDK does not expose the effective model in these events. Pace does not display reasoning items. Some SDK messages arrive as completed items rather than token-by-token text. The SDK does not report token usage per command or message item. Pace records up to 20 short visible summaries per conversation, not the full transcript.

When you ask Codex to create an artifact, Pace tells it to save a Markdown working note in the project-local `.pace/artifacts/` directory. These files persist across conversations and can be reused by asking Codex to read or update them. `/artifacts` lists them; newly created or updated files are shown after a turn. Artifact files are regular project files under Codex's workspace sandbox.

Bash mode runs **your typed command** through Bash in the project directory, outside Codex's sandbox. On Windows it uses Git Bash at `C:\Program Files\Git\bin\bash.exe`; on macOS/Linux it uses `bash` from PATH. Command output appears when the process exits and is capped at 32,768 characters. Bash commands may run while Codex works, so concurrent changes to the same files can conflict. The SDK requires a Git repository by default, and a real Codex turn requires working credentials; neither is simulated by the automated tests.

## Verify

```sh
npm run build
npm test
node dist/cli.js --help
node dist/cli.js doctor
```

Tests use mocked providers and a temporary storage directory. No API credentials are required. The roadmap in [ROADMAP.md](ROADMAP.md) covers later releases; v0.1 has no server, database, provider framework, or automatic agents.
