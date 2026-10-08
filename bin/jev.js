#!/usr/bin/env node
import { existsSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

function resolveJevPath() {
  let realFile = process.argv[1];
  try {
    if (realFile && existsSync(realFile)) {
      realFile = realpathSync(realFile);
    }
  } catch {}

  const parentUrl = realFile ? pathToFileURL(realFile).href : import.meta.url;
  try {
    const resolvedVex = fileURLToPath(import.meta.resolve("@sidearker/vex-mcp", parentUrl));
    const jevPath = join(dirname(resolvedVex), "cli", "jev.js");
    if (existsSync(jevPath)) return jevPath;
  } catch {}

  if (realFile) {
    const local = join(dirname(realFile), "..", "node_modules", "@sidearker", "vex-mcp", "dist", "cli", "jev.js");
    if (existsSync(local)) return local;
  }

  return undefined;
}

const jevPath = resolveJevPath();
if (!jevPath) {
  console.error("Error: @sidearker/vex-mcp is not installed in node_modules.");
  process.exit(1);
}

const result = spawnSync(process.execPath, [jevPath, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
});
process.exit(result.status ?? 0);
