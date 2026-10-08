#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

function hasKey() {
  if (
    process.env.OPENROUTER_API_KEY?.trim() ||
    process.env.TYPESAFE_API_KEY?.trim() ||
    process.env.JEV_API_KEY?.trim()
  ) {
    return true;
  }
  const home = homedir();
  for (const filename of [".openrouter_key", ".typesafe_key", ".jev_key"]) {
    try {
      const path = join(home, filename);
      if (existsSync(path) && readFileSync(path, "utf8").trim()) return true;
    } catch {}
  }
  return false;
}

function parseFormat(rawKey) {
  const key = rawKey.trim();
  if (key.startsWith("ts-") || key.startsWith("ts_")) return "typesafe";
  if (key.startsWith("sk-")) return "openrouter";
  return "unknown";
}

function saveKey(rawKey) {
  const key = rawKey.trim();
  const format = parseFormat(key);
  if (format === "unknown") {
    return { success: false, error: "Key must start with 'ts-' (TypeSafe) or 'sk-' (OpenRouter)." };
  }
  const home = homedir();
  const target = format === "typesafe" ? join(home, ".typesafe_key") : join(home, ".openrouter_key");
  writeFileSync(target, key + "\n", { mode: 0o600 });
  return { success: true, target, format };
}

async function main() {
  if (hasKey()) {
    console.log("[pace setup] API key already configured.");
    return;
  }

  if (!input.isTTY) {
    console.log("[pace setup] No API key detected. Set OPENROUTER_API_KEY or create ~/.openrouter_key or ~/.typesafe_key.");
    return;
  }

  console.log("\n[pace setup] Pace uses Vex for decision routing and needs an API key.");
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question("Enter your API key (TypeSafe 'ts-...' or OpenRouter 'sk-...', or Enter to skip): ");
    const trimmed = answer.trim();
    if (!trimmed) {
      console.log("[pace setup] Skipped. You can add ~/.openrouter_key or ~/.typesafe_key later.\n");
      return;
    }
    const res = saveKey(trimmed);
    if (res.success) {
      console.log(`[pace setup] Saved ${res.format === "typesafe" ? "TypeSafe" : "OpenRouter"} key to ${res.target}\n`);
    } else {
      console.log(`[pace setup] Error: ${res.error}\n`);
    }
  } finally {
    rl.close();
  }
}

main().catch(() => {});
