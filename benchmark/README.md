# Pace benchmark

The benchmark compares a plain Codex SDK turn on `gpt-6-sol` at `high` reasoning with a fresh Pace auto-routed turn on the **same literal prompt** and repository commit. Pace's Vex MCP server is available to Codex in the Pace arm only. Each arm starts in a fresh Git clone and thread. The order alternates on repeated runs.

Run the pilot from the Pace checkout:

```powershell
npm run benchmark -- --suite benchmark/pilot.json --repeat 1
```

Use `--case usage-trace` for one case, `--repeat 3` for repeated pairs, `--timeout-minutes 12` for a per-run limit, and `--out <directory>` to choose a result directory. Results default to the ignored `benchmark/results/` directory. The suite supports a repository path relative to the invocation directory, suite or per-case Git ref, prompt, optional setup commands, optional check commands, and a review rubric. Setup and checks execute in each clone. If the source repository has `node_modules`, each clone receives a link to it so build and test commands use the same dependencies. A fixed commit is saved in the result manifest even when the suite uses `HEAD`.

Each run saves `run.json`, raw SDK `events.jsonl`, a full `diff.patch`, and Vex stats when Vex made a decision. `summary.json` reports matched pairs with complete Codex usage. Input tokens already include cached input; output tokens already include reasoning tokens. The total is `input_tokens + output_tokens`. A failed subturn or missing usage excludes its pair from the token comparison. The run record still shows the failure. Vex tokens and cost stay separate from Codex tokens because they come from another provider.

Check commands and the rubric help assess quality; passing broad build and test commands does not prove the requested behavior. Review the final answers and diffs against each rubric before claiming a quality-adjusted saving. The pilot verifies the harness and illustrates the report format; use a larger suite of representative, reviewed tasks for a stable estimate.

The benchmark runs sequentially and may consume substantial Codex account allowance. It uses the existing Codex login and applies a per-run trust override for the temporary checkout. The baseline SDK configuration disables MCP servers. Do not mention Vex in a benchmark prompt when testing the no-Vex baseline against the Pace repository: the repository itself depends on `vex-mcp`, so an agent could invoke that package through a shell command. Do not share raw event logs without reviewing them: they can contain repository content and command output.
