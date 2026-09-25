#!/usr/bin/env node
import React from "react";
import { render } from "ink";
import { createRequire } from "node:module";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { PaceStore } from "./core/sessions.js";
import { vexServerPath } from "./integrations/vex.js";
import App from "./app.js";
const require = createRequire(import.meta.url);
const version = (require("../package.json") as { version: string }).version;
const args = process.argv.slice(2);
if (args.includes("--version")) console.log(`pace ${version}`);
else if (args.includes("--help"))
  console.log(
    `Pace ${version} · independent Codex SDK terminal client\n\nUsage: pace [doctor|--help|--version]\n\nInteractive commands: /help /models /auto /new /resume /usage /artifacts /clear /exit\nBash: ! <command> or ! to toggle Bash mode`,
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
  console.log(
    `Vex MCP: ${vexServerPath() ? "server found (connection checked at startup)" : "unavailable; coding is blocked"}`,
  );
  try {
    await access(join(process.cwd(), ".git"));
    console.log("Project: Git repository");
  } catch {
    console.log(
      "Project: Git repository not detected (Codex may refuse the directory)",
    );
  }
  console.log(
    "Codex SDK: installed; authentication and runtime need a live turn to verify",
  );
} else if (args.length) {
  console.error(`Unknown command: ${args.join(" ")}. Run pace --help.`);
  process.exitCode = 2;
} else {
  let instance: ReturnType<typeof render>;
  instance = render(<App onClear={() => {
    instance.clear();
    process.stdout.write("\x1b[2J\x1b[H");
  }} />);
}
