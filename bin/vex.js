#!/usr/bin/env node
import { existsSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

function resolveVexPath() {
  let realFile = process.argv[1];
  try {
    if (realFile && existsSync(realFile)) {
      realFile = realpathSync(realFile);
    }
  } catch {}

  const parentUrl = realFile ? pathToFileURL(realFile).href : import.meta.url;
  try {
    const resolved = fileURLToPath(import.meta.resolve("@sidearker/vex-mcp", parentUrl));
    if (existsSync(resolved)) return resolved;
  } catch {}

  if (realFile) {
    const local = join(dirname(realFile), "..", "node_modules", "@sidearker", "vex-mcp", "dist", "index.js");
    if (existsSync(local)) return local;
  }

  return undefined;
}

const vexPath = resolveVexPath();
if (!vexPath) {
  console.error("Error: @sidearker/vex-mcp is not installed in node_modules.");
  process.exit(1);
}

const result = spawnSync(process.execPath, [vexPath, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
});
process.exit(result.status ?? 0);
