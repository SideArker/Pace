#!/usr/bin/env node
import React from "react";
import { render } from "ink";
import { createRequire } from "node:module";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { PaceStore } from "../core/sessions.js";
import { VexRouter } from "../core/vex/client.js";
import App from "../components/App.js";
import { execTurn } from "../core/exec.js";
import { getGitBranch } from "../core/system/git.js";
import { interactiveInkOptions } from "./terminal-options.js";
import { hasConfiguredKey, promptForKey } from "../core/system/keys.js";
import { RemoteDomain } from "../remote/domain.js";
import { startRemoteHost } from "../remote/server.js";
import { lanAddresses, remoteLock } from "../remote/security.js";
import qrcode from "qrcode-terminal";

export function runTerminalClear(): void {
  try {
    if (process.platform === "win32") {
      spawnSync("cmd.exe", ["/c", "cls"], { stdio: "inherit" });
    } else {
      spawnSync("clear", [], { stdio: "inherit" });
    }
  } catch {
    // fallback
  }
}

const require = createRequire(import.meta.url);
const version = (require("../../package.json") as { version: string }).version;
const args = process.argv.slice(2);
if (args.includes("--version")) console.log(`pace ${version}`);
else if (args.includes("--help"))
  console.log(
    `Pace ${version} · independent Codex SDK terminal client\n\nUsage: pace [doctor|setup|sessions|mcp [arguments...]|remote start|remote status|reconnect "old path" "new path"|exec "prompt"|--help|--version]\n\nInteractive commands: type / to browse; /help /models /mcp /version /auto /manual /workflow /approval /remote /tasks /task /new /convo /diff /undo /redo /compact /context /cancelretry /btw <question> /artifacts /trust /skills /<skill> /stats /clear /exit\nMCP: /mcp opens the interactive manager; pace mcp add|list|get|remove|login|logout wraps native Codex MCP management; pace mcp --help shows options\nSkills: bundled grill-me, tdd, diagnosing-bugs, code-review, prototype, pace-planning; /skills refreshes ~/.agents/skills; /skills enable|disable <name>; /skills <folder>|default|off\nBash: ! <command> or ! to toggle Bash mode\nInput: Shift/Ctrl/Alt+Enter or Ctrl+J for newline, arrows for history, Ctrl+Z undoes a turn and files, Ctrl+Y redoes, /diff browses saved edits, Ctrl+O toggles command, diff, and reasoning details`,
  );
else if (args[0] === "setup" || args[0] === "set-key") {
  await promptForKey();
}
else if (args[0] === "doctor") {
  const notices: string[] = [];
  const store = new PaceStore(undefined, (message) => notices.push(message));
  console.log(
    `Node: ${process.version} ${Number(process.versions.node.split(".")[0]) >= 20 ? "OK" : "requires 20+"}`,
  );
  try {
    await access(store.baseDir, constants.R_OK | constants.W_OK);
    console.log(`Pace directory: ${store.baseDir} OK`);
  } catch (error) {
    console.log(
      (error as NodeJS.ErrnoException).code === "ENOENT"
        ? `Pace directory: ${store.baseDir} not created yet`
        : `Pace directory: ${String(error)}`,
    );
  }
  try {
    const config = await store.loadConfig();
    console.log(
      notices.length
        ? `Config: ${notices.join("; ")}`
        : `Config: valid (${config.models.length} models)`,
    );
  } catch (error) {
    console.log(`Config: ${String(error)}`);
  }
  const vex = new VexRouter();
  try {
    await vex.verify();
    console.log("Vex MCP: connected; vex_choose available");
  } catch (error) {
    console.log(`Vex MCP: unavailable (${String(error)})`);
    process.exitCode = 1;
  } finally {
    await vex.close();
  }
  if (!hasConfiguredKey()) {
    console.log("API key: missing (run 'pace setup' or set OPENROUTER_API_KEY / TYPESAFE_API_KEY)");
  }
  try {
    if (!getGitBranch(process.cwd())) throw new Error("Git metadata not found");
    console.log("Project: Git repository");
  } catch {
    console.log(
      "Project: Git repository not detected (Codex may refuse the directory)",
    );
  }
  console.log(
    "Codex SDK: installed; authentication and runtime need a live turn to verify",
  );
} else if (args[0] === "sessions" && args.length === 1) {
  const projects = await new PaceStore().listProjects();
  if (!projects.length) console.log("No saved conversations.");
  else for (const project of projects) {
    console.log(`${project.exists ? "available" : "missing"} · ${project.sessions.length} conversation${project.sessions.length === 1 ? "" : "s"} · ${project.projectPath}`);
    for (const session of project.sessions) {
      const prompt = session.turns.at(-1)?.prompt.replace(/\s+/g, " ").trim() || "(empty)";
      console.log(`  ${session.id.slice(0, 8)} · ${session.updatedAt.slice(0, 16).replace("T", " ")} · ${prompt.slice(0, 60)}`);
    }
  }
} else if (args[0] === "reconnect") {
  if (args.length !== 3) {
    console.error('Usage: pace reconnect "old path" "new path"');
    process.exitCode = 2;
  } else {
    try {
      const count = await new PaceStore().reconnectProject(args[1]!, args[2]!);
      console.log(`Reconnected ${count} conversation${count === 1 ? "" : "s"} to ${args[2]}.`);
    } catch (error) {
      console.error(`Could not reconnect project: ${String(error)}`);
      process.exitCode = 1;
    }
  }
} else if (args[0] === "remote") {
  const store = new PaceStore();
  const action = args[1] ?? "start";
  if (action === "status") {
    try { const release = await remoteLock(store.baseDir); await release(); console.log("Remote host stopped."); }
    catch (error) { console.log(String(error).includes("already owns") ? "Remote host lock exists; verify PID and inspect listener before use." : `Remote host unavailable: ${String(error)}`); }
  } else if (action !== "start" || args.length > 2) {
    console.error("Usage: pace remote [start|status]"); process.exitCode = 2;
  } else {
    const addresses = lanAddresses();
    if (!addresses.length) { console.error("No private IPv4 LAN interface found."); process.exitCode = 1; }
    else {
      const roots = [process.cwd(), ...(await store.listProjects({ summariesOnly: true })).filter(item => item.exists).map(item => item.projectPath)];
      const runner = new (await import("../integrations/app-server-runner.js")).AppServerRunner();
      const orchestrator = new (await import("../core/orchestrator.js")).Orchestrator(store, runner, new VexRouter());
      const domain = new RemoteDomain(store, orchestrator, [...new Set(roots)]);
      const host = await startRemoteHost({ baseDir: store.baseDir, address: addresses[0]!, domain });
      console.log(`Remote host listening on ${host.address}. Scan one-time pairing code within 2 minutes:`);
      qrcode.generate(JSON.stringify(host.pairing), { small: true });
      const shutdown = () => { void host.close().then(() => process.exit(0)); };
      process.once("SIGINT", shutdown); process.once("SIGTERM", shutdown);
      await new Promise<void>(resolve => { process.once("beforeExit", resolve); });
    }
  }
} else if (args[0] === "exec") {
  process.exitCode = await execTurn(args.slice(1).join(" "));
} else if (args.length) {
  console.error(`Unknown command: ${args.join(" ")}. Run pace --help.`);
  process.exitCode = 2;
} else {
  let instance: ReturnType<typeof render>;
  instance = render(<App onClear={() => {
    instance?.clear();
    runTerminalClear();
    process.stdout.write("\x1b[3J\x1b[2J\x1b[H");
  }} />, interactiveInkOptions);
  await instance.waitUntilExit();
}
