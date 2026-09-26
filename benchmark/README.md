# Pace benchmark

The benchmark compares three workflows on the **same literal prompt** and repository commit: plain Sol High, Vex-routed single agent, and Vex-routed scout plus completion. Each arm starts in a fresh Git clone and thread. The order alternates on repeated runs. The benchmark fixes workflow shape so each shape gets measured; Vex still routes every Codex stage. Codex can call Vex in routed arms.

Run the pilot from the Pace checkout:

```powershell
npm run benchmark -- --suite benchmark/pilot.json --repeat 1
```

Use `--case usage-trace` for one case, `--repeat 3` for repeated pairs, `--timeout-minutes 12` for a per-run limit, and `--out <directory>` to choose a result directory. Results default to the ignored `benchmark/results/` directory. The suite supports a repository path relative to the invocation directory, suite or per-case Git ref, prompt, optional setup commands, optional check commands, and a review rubric. Setup and checks execute in each clone. If the source repository has `node_modules`, each clone receives a link to it so build and test commands use the same dependencies. A fixed commit is saved in the result manifest even when the suite uses `HEAD`.

Each run saves `run.json`, raw SDK `events.jsonl`, a full `diff.patch`, and Vex stats when Vex made a decision. `summary.json` reports matched triples with complete Codex usage, per-stage routes, token cache breakdown, elapsed time, estimated Standard API cost, and Vex routing and agent call counts. The result manifest embeds the price snapshot. Input tokens include cached and cache-write input; output includes reasoning. Stage cost charges each input class once, using its stage model. Vex cost stays separate and does not influence routing. Actual Codex account billing is not exposed by the SDK, so dollar amounts are API-equivalent estimates for Standard, short-context processing.

Check commands and the rubric help assess quality; passing broad build and test commands does not prove the requested behavior. Review each final answer and diff against its case rubric, record success per arm, then compare cost among successful arms. Repeat each task at least twice before changing routing guidance. A quality failure or cost regression calls for revised choice descriptions and another paired run.

The benchmark runs sequentially and may consume substantial Codex account allowance. It uses the existing Codex login and applies a per-run trust override for the temporary checkout. The baseline SDK configuration disables MCP servers. Do not mention Vex in a benchmark prompt when testing the no-Vex baseline against the Pace repository: the repository itself depends on `vex-mcp`, so an agent could invoke that package through a shell command. Do not share raw event logs without reviewing them: they can contain repository content and command output.
