#!/usr/bin/env node
import { ensureLocalBinInPath } from "../core/system/keys.js";

process.env.NODE_ENV = process.env.NODE_ENV || "production";
ensureLocalBinInPath();

if (process.argv[2] === "mcp") {
  const { runMcpCommand } = await import("../integrations/codex-cli.js");
  process.exitCode = await runMcpCommand(process.argv.slice(3));
} else {
  await import("./cli-app.js");
}
