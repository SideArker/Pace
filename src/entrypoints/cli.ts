#!/usr/bin/env node
import { ensureLocalBinInPath } from "../core/system/keys.js";

process.env.NODE_ENV = process.env.NODE_ENV || "production";
ensureLocalBinInPath();

if (process.argv[2] === "benchmark") {
  try {
    const { assertDebug } = await import("../benchmark/storage.js");
    assertDebug();
    const { benchmarkCommand } = await import("./benchmark-cli.js");
    await benchmarkCommand(process.argv.slice(3));
  } catch (error) { console.error(String(error)); process.exitCode = 1; }
} else if (process.argv[2] === "mcp") {
  const { runMcpCommand } = await import("../integrations/codex-cli.js");
  process.exitCode = await runMcpCommand(process.argv.slice(3));
} else {
  await import("./cli-app.js");
}
