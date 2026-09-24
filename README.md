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
| `/auto` | Enable Jev for a new conversation; an existing thread keeps its saved route |
| `/new` | Start a fresh Pace and Codex conversation |
| `/resume` | List saved conversations in this project |
| `/resume <id-prefix>` | Resume a listed conversation |
| `/exit` | Quit |

Ctrl+C cancels the current Codex turn; when idle, it exits. Input is paused during a running turn. Completed messages stay in the terminal history while the current status updates in place.

## Models and routing

By default, Pace passes no model or effort override, leaving model choice to Codex. Create `~/.pace/config.json` (`%USERPROFILE%\.pace\config.json` on Windows) to opt into specific model routes:

```json
{
  "routingMode": "auto",
  "defaultRoute": { "model": "gpt-6-sol", "effort": "medium" },
  "models": [
    { "model": "gpt-6-sol", "efforts": ["medium"], "defaultEffort": "medium" },
    { "model": "gpt-6-luna", "efforts": ["medium"], "defaultEffort": "medium" }
  ]
}
```

These model names are examples from current Codex documentation; access depends on your account and workspace. Configure only models and effort values you can use. Pace validates effort names against the installed SDK type and against each model's configured list; it cannot query model availability. A failed Codex turn reports the provider error. `defaultRoute` may be `{}` to use Codex's default model. With fewer than two configured routes, auto mode uses the default without calling Jev.

Pace inspected the local Jev launcher and source: `jev run --raw` reads a JSON decision request from stdin and prints a JSON response with `answers`. On Windows, Pace launches the installed `.ps1` through PowerShell with fixed subprocess arguments; on other systems it launches the executable directly. `JEV_COMMAND` can point to a different executable or `.ps1` path. Pace sends only a coarse task category, request-length band, a few boolean task signals, and the configured model/effort options. It does **not** send the prompt, repository files, paths, or credentials. The installed Jev command forwards that routing request to OpenRouter's decisions endpoint. Jev is optional: missing, timed-out, invalid, or uncertain decisions visibly fall back to `defaultRoute`. This coarse request limits how well Jev can judge task difficulty.

## Sessions and safety

Pace writes config and short, user-visible turn summaries under `~/.pace`; each project uses a SHA-256 path key and each conversation has its own atomic JSON file. Codex owns its thread history in `~/.codex/sessions`. Pace stores the Codex thread ID and resumes it for follow-ups and restarts. A resumed thread retains its saved model and effort; change routes with `/new` and then `/model`. Corrupt session files are skipped with a warning.

Pace runs SDK turns in `workspace-write` mode with network access disabled and approval policy `never`. This is a restricted mode: actions requiring higher permissions are denied rather than approved. The TypeScript SDK used here does not expose an in-app approval response interface, so Pace has no interactive approval prompt. It does not enable unrestricted access or bypass Codex safeguards.

The SDK streams documented status and agent-message events. Pace does not display reasoning items. Some SDK messages arrive as completed items rather than token-by-token text. It records up to 20 short visible summaries per conversation, not the full transcript. The SDK requires a Git repository by default, and a real Codex turn requires working credentials; neither is simulated by the automated tests.

## Verify

```sh
npm run build
npm test
node dist/cli.js --help
node dist/cli.js doctor
```

Tests use mocked providers and a temporary storage directory. No API credentials are required. The roadmap in [ROADMAP.md](ROADMAP.md) covers later releases; v0.1 has no server, database, provider framework, or automatic agents.
