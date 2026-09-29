#!/usr/bin/env node
import React from "react";
import { render } from "ink";
import { createRequire } from "node:module";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { PaceStore } from "../core/sessions.js";
import { VexRouter } from "../core/vex/client.js";
import App from "../components/App.js";
import { execTurn } from "../core/exec.js";
import { getGitBranch } from "../core/system/git.js";

// Ink clears scrollback with CSI 3J whenever a live frame fills the terminal.
// Keep its repaint within the visible viewport without changing the UI layout.
const inkStdout = new Proxy(process.stdout, {
  get(target, property) {
    if (property === "write") {
      return (chunk: string | Uint8Array, ...args: unknown[]) => {
        const clearTerminal = "\x1b[2J\x1b[3J\x1b[H";
        const repaintViewport = "\x1b[1;1H\x1b[J";
        const output = typeof chunk === "string" && chunk.startsWith(clearTerminal)
          ? repaintViewport + chunk.slice(clearTerminal.length)
          : chunk;
        return Reflect.apply(target.write, target, [output, ...args]) as boolean;
      };
    }
    const value = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  },
});
const require = createRequire(import.meta.url);
const version = (require("../../package.json") as { version: string }).version;
const args = process.argv.slice(2);
if (args.includes("--version")) console.log(`pace ${version}`);
else if (args.includes("--help"))
  console.log(
    `Pace ${version} · independent Codex SDK terminal client\n\nUsage: pace [doctor|sessions|exec "prompt"|--help|--version]\n\nInteractive commands: /help /models /model <name> [effort] /auto /new /resume /compact /usage /btw <question> /artifacts /trust /skills /<skill> /route /stats /clear /exit\nSkills: /skills refreshes the default ~/.agents/skills folder; /skills enable|disable <name>; /skills <folder>|default|off\nBash: ! <command> or ! to toggle Bash mode\nInput: Shift/Ctrl/Alt+Enter or Ctrl+J for newline, arrows for history, Ctrl+O reasoning and command output`,
  );
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
} else if (args[0] === "exec") {
  process.exitCode = await execTurn(args.slice(1).join(" "));
} else if (args.length) {
  console.error(`Unknown command: ${args.join(" ")}. Run pace --help.`);
  process.exitCode = 2;
} else {
  let instance: ReturnType<typeof render>;
  instance = render(<App onClear={() => {
    instance.clear();
    process.stdout.write("\x1b[3J\x1b[2J\x1b[H");
  }} />, { stdout: inkStdout, kittyKeyboard: { mode: "auto" }, exitOnCtrlC: false });
}
