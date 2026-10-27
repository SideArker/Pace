import { markdownLinks, openLink } from "../../core/system/links.js";
import { debugTurn } from "../../core/prompt-trace.js";
import { isDebugBuild } from "../../core/build-mode.js";
import type { Dispatch, SetStateAction } from "react";
import type { Session } from "../../shared/types.js";
import type { PaceStore } from "../../core/sessions.js";
import { taskSummary } from "../../core/tasks.js";
import { taskAccounting } from "../../core/task-execution.js";
import { artifactDirectory, artifactPath, artifactSnapshot, legacyArtifactDirectory } from "../../core/system/artifacts.js";
import { listMcpServers } from "../../integrations/codex-cli.js";
import { contextPercent, measuredContext } from "../../core/context.js";
import { currentManifestSource, newerPaceVersion, refreshVersionManifest } from "../../core/routing/pricing.js";
import type { Line } from "../Transcript.js";

export const infoCommands = ["/help", "/links", "/debug", "/tasks", "/mcp", "/context", "/version", "/artifacts", "/stats"];

type InfoOptions = {
  session: Session;
  store: PaceStore;
  installedVersion: string;
  setMcpOpen: Dispatch<SetStateAction<boolean>>;
  setKnownModels: Dispatch<SetStateAction<string[]>>;
  add: (role: Line["role"], text: string) => void;
};

export async function showCommandInfo(command: string, parts: string[], {
  session, store, installedVersion, setMcpOpen, setKnownModels, add,
}: InfoOptions) {
  if (command === "/help") {
    add(
      "info",
      "/plan [prompt] · /execute · /verify [file] [prompt] · /models · /mcp [list] · /auto · /manual [model] [effort] · /workflow [name|auto] · /approval [full-access|request-approval|limited] · /remote · /tasks · /new · /convo · /diff · /undo · /redo · /compact · /context · /retry · /cancelretry · /btw <q> · /adopt <side-answer-id> · /artifacts · /trust · /skills [folder|default|off|enable <name>|disable <name>] · /<skill> [request] · /stats · /clear · /exit · Esc cancels automatic retry; Esc twice/Ctrl+C cancels other turns · Ctrl+Z undo · Ctrl+Y redo · Alt+P/Ctrl+P plan · Alt+E/Ctrl+E execute · ! Bash · /links [number] lists/opens Markdown links · /debug [turn] inspects local prompts · Ctrl+O toggle plan, scout, command, diff, and reasoning details · Shift/Ctrl/Alt+Enter or Ctrl+J newline · ↑/↓ history",
    );
    if (isDebugBuild) add("info", "/benchmark opens Benchmark Center (debug only). Preview and results make no model calls; Start requires idle jobs and queues.");
    add("info", "With multiple open conversations, press Down from the input to focus the picker. Use arrows and Enter to switch; Esc returns to input. Ctrl+C cancels the selected turn. /exit quits.");
    return;
  }
  if (command === "/debug") {
    const index = parts.length ? Number(parts[0]) - 1 : session.turns.length - 1;
    if (parts.length > 1 || !Number.isInteger(index) || !session.turns[index]) { add("error", "Use /debug [turn-number] for a saved turn."); return; }
    add("debug", debugTurn(session, index));
    return;
  }
  if (command === "/links") {
    const sources = session.turns.flatMap(turn => [turn.prompt, turn.result, ...(turn.stages ?? []).flatMap(stage => stage.handoff ? [stage.handoff] : [])]);
    if (session.executionSource) sources.push(session.executionSource.plan);
    const links = sources.flatMap(source => markdownLinks(source));
    if (!parts.length) { add("info", links.length ? links.map((link, i) => `${i + 1}. ${link.label} → ${link.target}`).join("\n") + "\nOpen with /links <number>." : "No supported Markdown links in this conversation."); return; }
    const index = Number(parts[0]) - 1;
    if (parts.length !== 1 || !Number.isInteger(index) || !links[index]) { add("error", "Select a link number from /links."); return; }
    try { await openLink(links[index]!.target); add("info", `Opened ${links[index]!.label}`); }
    catch (error) { add("error", `Could not open link: ${String(error)}`); }
    return;
  }
  if (command === "/tasks") {
    if (parts.length) { add("error", "Type /tasks without arguments."); return; }
    add("info", taskSummary(session.tasks));
    return;
  }
  if (command === "/mcp") {
    if (!parts.length) { setMcpOpen(true); return; }
    if (parts.length && (parts.length !== 1 || parts[0] !== "list")) {
      add("error", "Use /mcp to open the interactive manager, or /mcp list to print configured servers.");
      return;
    }
    try {
      const servers = await listMcpServers(session.projectPath);
      add("info", `Configured external MCP servers (connection status is determined during turns):\n${servers || "No external MCP servers configured."}\nManage servers in a terminal with pace mcp add|get|remove|login|logout. Changes apply to the next turn; active turns keep their connections. Vex is managed separately by Pace.`);
    } catch (error) { add("error", `Could not list MCP servers: ${String(error)}`); }
    return;
  }
  if (command === "/context") {
    if (parts.length) { add("error", "Type /context without arguments."); return; }
    const reading = measuredContext(session);
    const percent = contextPercent(reading);
    const freshOnNextTurn = session.checkpoint?.threadId === session.threadId &&
      session.turns.some(turn => turn.at === session.checkpoint?.sourceTurnAt);
    add("info", session.threadId
      ? `Current Codex thread: ${session.threadId}. The next turn ${freshOnNextTurn ? "starts a fresh thread from the checkpoint" : "resumes this thread"}.`
      : "No Codex thread is attached. The next turn starts a thread with retained conversation history.");
    add("info", reading && percent !== undefined
      ? `Last model request: ${reading.tokens.toLocaleString()} / ${reading.windowTokens.toLocaleString()} context tokens (${percent}%)${reading.model ? ` on ${reading.model}` : ""}.`
      : "Context occupancy is unavailable for the current thread and model.");
    if (session.checkpoint) add("info", `Saved checkpoint from ${session.checkpoint.createdAt}; original thread ${session.checkpoint.threadId}.`);
    add("info", "Use /compact to compact an idle thread, or /new to begin a separate fresh conversation. Choose a saved conversation in the conversation picker to return to it.");
    return;
  }
  if (command === "/version") {
    const manifest = await refreshVersionManifest(fetch, undefined, true);
    setKnownModels(Object.keys(manifest.pricing.rates));
    add("info", `Pace ${installedVersion}; ${currentManifestSource()} catalog reports ${manifest.pace.latest}${newerPaceVersion(installedVersion, manifest.pace.latest) ? ` · ${manifest.pace.releaseUrl}` : ""}. Prices checked ${manifest.pricing.checkedAt}.`);
    return;
  }
  if (command === "/artifacts") {
    try {
      const files = await artifactSnapshot(artifactDirectory(store, session));
      const legacy = await artifactSnapshot(legacyArtifactDirectory(session.projectPath));
      add(
        "info",
        files.size || legacy.size
          ? [
              ...[...files.keys()].sort().map(name => artifactPath(store, session, `artifacts/${name}`)),
              ...[...legacy.keys()].sort().map(name => artifactPath(store, session, `.pace/artifacts/${name}`)),
            ].join("\n")
          : "No Markdown artifacts for this conversation yet.",
      );
    } catch (error) {
      add("error", `Could not list artifacts: ${String(error)}`);
    }
    return;
  }
  if (command === "/stats") {
    const attempts = session.attempts ?? [];
    const compactions = session.compactions ?? [];
    const generations = session.checkpointGenerations ?? [];
    const controls = session.controlDecisions ?? [];
    if (!attempts.length && !session.turns.length && !compactions.length && !generations.length && !controls.length) { add("info", "No recorded attempts or context actions yet."); return; }
    const accounting = taskAccounting(session);
    const total = (key: "input_tokens" | "cached_input_tokens" | "cache_write_input_tokens" | "output_tokens") => attempts.reduce((sum, attempt) => sum + ((attempt.knownUsage ?? attempt.usage)?.[key] ?? 0), 0);
    add("info", `Codex attempt ledger: ${accounting.attempts} attempts · ${attempts.filter(attempt => attempt.status === "failed").length} failed · ${attempts.filter(attempt => attempt.status === "cancelled").length} cancelled · ${(accounting.durationMs / 1000).toFixed(1)}s. Known subtotal ~$${accounting.knownSubtotalUsd.toFixed(4)}; full attempt cost ${accounting.complete ? `~$${accounting.totalUsd!.toFixed(4)}` : "unknown (incomplete usage or pricing)"}.`);
    add("info", `Attributed usage: ${total("input_tokens")} input (${total("cached_input_tokens")} cached, ${total("cache_write_input_tokens")} cache write), ${total("output_tokens")} output. Estimates use the recorded source routes and Pace API price catalog; they do not measure Codex subscription allowance. Native compaction and checkpoint attempts are included in this ledger and detailed separately.`);
    if (session.activeTask?.id) {
      const task = taskAccounting(session, session.activeTask.id);
      add("info", `Active task ${session.activeTask.id}: ${task.attempts} attempts · known subtotal ~$${task.knownSubtotalUsd.toFixed(4)} · full cost ${task.complete ? `~$${task.totalUsd!.toFixed(4)}` : "unknown"} · assessment ${session.activeTask.assessment ?? "unknown"}.`);
    }
    if (!attempts.length && session.turns.length) add("info", "Legacy turns have no durable attempt ledger; full historical task cost is unknown.");
    const vexCalls = controls.filter(item => item.source === "vex");
    add("info", `Vex separately: ${vexCalls.reduce((sum, item) => sum + (item.requests ?? 1), 0)} recorded calls (${vexCalls.filter(item => item.failed).length} failed decisions) · ${(vexCalls.reduce((sum, item) => sum + item.durationMs, 0) / 1000).toFixed(1)}s · token usage and cost unavailable in the choice contract.`);
    if (compactions.length) {
      const input = compactions.reduce((sum, item) => sum + ((item.knownUsage ?? item.usage)?.input_tokens ?? 0), 0);
      const output = compactions.reduce((sum, item) => sum + ((item.knownUsage ?? item.usage)?.output_tokens ?? 0), 0);
      const duration = compactions.reduce((sum, item) => sum + item.durationMs, 0);
      const estimated = compactions.reduce((sum, item) => sum + (item.knownCostUsd ?? item.estimatedCostUsd ?? 0), 0);
      const pricedCount = compactions.filter(item => item.knownCostUsd !== undefined || item.estimatedCostUsd !== undefined).length;
      add("info", `Compactions: ${compactions.length} (${compactions.filter(item => item.outcome === "completed").length} completed, ${compactions.filter(item => item.outcome === "failed").length} failed, ${compactions.filter(item => item.outcome === "cancelled").length} cancelled) · ${input} input / ${output} output tokens (${compactions.filter(item => item.usage).length} reported usage) · ${(duration / 1000).toFixed(1)}s · ${pricedCount ? `~$${estimated.toFixed(4)} estimated API equivalent (${pricedCount} priced)` : "API-equivalent cost unavailable"}; full compaction cost ${compactions.every(item => item.estimatedCostUsd !== undefined && item.usageComplete !== false) ? "known" : "unknown (subtotal only)"}`);
    }
    if (generations.length) {
      const input = generations.reduce((sum, item) => sum + (item.usage?.input_tokens ?? 0), 0);
      const output = generations.reduce((sum, item) => sum + (item.usage?.output_tokens ?? 0), 0);
      const duration = generations.reduce((sum, item) => sum + item.durationMs, 0);
      const estimated = generations.reduce((sum, item) => sum + (item.estimatedCostUsd ?? 0), 0);
      const pricedCount = generations.filter(item => item.estimatedCostUsd !== undefined).length;
      add("info", `Checkpoints: ${generations.length} generation attempts (${generations.filter(item => item.outcome === "valid").length} valid) · ${input} input / ${output} output tokens (${generations.filter(item => item.usage).length} reported usage) · ${(duration / 1000).toFixed(1)}s · ${pricedCount ? `~$${estimated.toFixed(4)} estimated API equivalent (${pricedCount} priced)` : "API-equivalent cost unavailable"}; full checkpoint cost ${generations.every(item => item.estimatedCostUsd !== undefined) ? "known" : "unknown (subtotal only)"}`);
    }
    return;
  }
}
