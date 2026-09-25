# Pace 0.1

Pace is an independent, terminal-only coding client. The official [Codex TypeScript SDK](https://github.com/openai/codex/tree/main/sdk/typescript) runs coding turns; the local `jev` command can recommend a configured model for new conversations. Pace is not an OpenAI product.

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

For development, use `npm run dev` instead of linking. `pace --help` and `pace --version` work without authentication. `pace doctor` checks Node, local storage, Git presence, SDK installation, Jev presence, and configuration; only a live coding turn verifies authentication and runtime access.

## Chat commands

| Command | Action |
| --- | --- |
| `/help` | Show commands and Ctrl+C behavior |
| `/model` | List configured routes and current model |
| `/model <model> [effort]` | Select a configured route for an empty conversation; use `/new` first if a Codex thread exists |
| `/models` | List configured models and whether Pace may use each one |
| `/models add <model> <effort>` | Add a model and effort, or add another effort to an existing model |
| `/models <model> on\|off` | Enable or disable a configured model for new turns |
| `/auto` | Enable Jev for a new conversation; an existing thread keeps its saved route |
| `/new` | Start a fresh Pace and Codex conversation |
| `/resume` | List saved conversations in this project |
| `/resume <id-prefix>` | Resume a listed conversation |
| `/exit` | Quit |
| `! <command>` | Run one Bash command in the project directory |
| `!` | Toggle Bash input mode; type `!` again to return to Pace |

Type `/` to see matching commands. Use Tab to complete and ↑/↓ to choose a match. Pace echoes each entered command before its result. A small spinner marks active work; status text comes from Codex SDK events. Ctrl+C cancels the current Codex turn; when idle, it exits. Input stays available during a Codex turn so Bash commands can run concurrently. Completed messages stay in terminal history.

## Models and routing

By default, Pace passes no model or effort override, leaving model choice to Codex. Use `/models add gpt-6-sol medium` to start an explicit allowlist. Add more routes with `/models add`, then turn any configured model off with `/models <model> off`. With an explicit list, Pace does not send disabled models to Jev or Codex. If every model is off, Pace stops the turn and asks you to enable one. An existing Codex thread cannot continue while its saved model is off; use `/new` or enable that model again.

Pace cannot query which models your account can use. `/model` lists configured choices, not a live provider catalog. Current documented examples include `gpt-6-sol`, `gpt-6-luna`, and `gpt-6-astra`; access depends on account and workspace. You can also edit `~/.pace/config.json` (`%USERPROFILE%\.pace\config.json` on Windows) directly:

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

Configure only models and effort values you can use. Pace validates effort names against its supported list and each model's configured list. `max` is not a Pace effort. An invalid config stops coding turns until fixed; Pace does not silently discard an explicit allowlist. Availability still needs a live Codex turn; provider errors remain visible. `defaultRoute` may be `{}`; once models are configured, Pace uses the first enabled model as its fallback. With fewer than two enabled models, auto mode uses the fallback without calling Jev. If the SDK chose an unknown default model for an older thread, start a new thread after configuring an allowlist.

Pace inspected the local Jev launcher and source: `jev run --raw` reads a JSON decision request from stdin and prints a JSON response with `answers`. On Windows, Pace launches the installed `.ps1` through PowerShell with fixed subprocess arguments; on other systems it launches the executable directly. `JEV_COMMAND` can point to a different executable or `.ps1` path. Pace sends only a coarse task category, request-length band, a few boolean task signals, and the configured model/effort options. It does **not** send the prompt, repository files, paths, or credentials. The installed Jev command forwards that routing request to OpenRouter's decisions endpoint. Jev is optional: missing, timed-out, invalid, or uncertain decisions visibly fall back to `defaultRoute`. This coarse request limits how well Jev can judge task difficulty.

## Sessions and safety

Pace writes config and short, user-visible turn summaries under `~/.pace`; each project uses a SHA-256 path key and each conversation has its own atomic JSON file. Codex owns its thread history in `~/.codex/sessions`. Pace stores the Codex thread ID and resumes it for follow-ups and restarts. A resumed thread retains its saved model and effort; change routes with `/new` and then `/model`. Corrupt session files are skipped with a warning.

Pace runs SDK turns in `workspace-write` mode with network access disabled and approval policy `never`. This is a restricted mode: actions requiring higher permissions are denied rather than approved. The TypeScript SDK used here does not expose an in-app approval response interface, so Pace has no interactive approval prompt. It does not enable unrestricted access or bypass Codex safeguards.

The SDK streams documented status and agent-message events. Pace labels messages with the configured model and reasoning effort; when no override is set, it says `Codex default` because the SDK does not expose the effective model in these events. Pace does not display reasoning items. Some SDK messages arrive as completed items rather than token-by-token text. It prints SDK token usage after each completed turn, including cached and reasoning tokens. The SDK does not report token usage per command or message item. Pace records up to 20 short visible summaries per conversation, not the full transcript.

Bash mode runs **your typed command** through Bash in the project directory, outside Codex's sandbox. On Windows it uses Git Bash at `C:\Program Files\Git\bin\bash.exe`; on macOS/Linux it uses `bash` from PATH. Command output appears when the process exits and is capped at 32,768 characters. Bash commands may run while Codex works, so concurrent changes to the same files can conflict. The SDK requires a Git repository by default, and a real Codex turn requires working credentials; neither is simulated by the automated tests.

## Verify

```sh
npm run build
npm test
node dist/cli.js --help
node dist/cli.js doctor
```

Tests use mocked providers and a temporary storage directory. No API credentials are required. The roadmap in [ROADMAP.md](ROADMAP.md) covers later releases; v0.1 has no server, database, provider framework, or automatic agents.
