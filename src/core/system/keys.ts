import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

export type KeyProvider = "typesafe" | "openrouter";

/**
 * Validates and identifies the provider format of a supplied API key.
 */
export function parseKeyFormat(rawKey: string): KeyProvider | "unknown" {
  const key = rawKey.trim();
  if (key.startsWith("ts-") || key.startsWith("ts_")) {
    return "typesafe";
  }
  if (key.startsWith("sk-")) {
    return "openrouter";
  }
  return "unknown";
}

/**
 * Checks if a valid API key is present in environment variables or user home files.
 */
export function hasConfiguredKey(customHome?: string): boolean {
  if (
    process.env.OPENROUTER_API_KEY?.trim() ||
    process.env.TYPESAFE_API_KEY?.trim() ||
    process.env.JEV_API_KEY?.trim()
  ) {
    return true;
  }
  const home = customHome || homedir();
  for (const filename of [".openrouter_key", ".typesafe_key", ".jev_key"]) {
    try {
      const path = join(home, filename);
      if (existsSync(path) && readFileSync(path, "utf8").trim()) {
        return true;
      }
    } catch {}
  }
  return false;
}

/**
 * Saves the given API key to its standard location (~/.typesafe_key or ~/.openrouter_key)
 * with strict permissions (0600).
 */
export function saveApiKey(
  rawKey: string,
  customHome?: string,
): { success: boolean; provider?: KeyProvider; path?: string; error?: string } {
  const key = rawKey.trim();
  if (!key) {
    return { success: false, error: "Empty key provided." };
  }
  const format = parseKeyFormat(key);
  if (format === "unknown") {
    return {
      success: false,
      error: "Invalid key format. Expected TypeSafe key starting with 'ts-' or OpenRouter key starting with 'sk-'.",
    };
  }

  const home = customHome || homedir();
  if (format === "typesafe") {
    const target = join(home, ".typesafe_key");
    try {
      writeFileSync(target, key + "\n", { mode: 0o600 });
      process.env.TYPESAFE_API_KEY = key;
      return { success: true, provider: "typesafe", path: target };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  } else {
    const target = join(home, ".openrouter_key");
    try {
      writeFileSync(target, key + "\n", { mode: 0o600 });
      process.env.OPENROUTER_API_KEY = key;
      return { success: true, provider: "openrouter", path: target };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }
}

/**
 * Prompts the user on standard input for an API key.
 */
export async function promptForKey(): Promise<boolean> {
  if (!input.isTTY) return false;
  const rl = createInterface({ input, output });
  try {
    output.write("\nPace uses Vex for decision routing and requires an API key.\n");
    const answer = await rl.question(
      "Enter your API key (TypeSafe 'ts-...' or OpenRouter 'sk-...', or Enter to skip): ",
    );
    const trimmed = answer.trim();
    if (!trimmed) {
      output.write("Skipped. You can configure a key later in ~/.openrouter_key or ~/.typesafe_key.\n\n");
      return false;
    }
    const result = saveApiKey(trimmed);
    if (result.success) {
      output.write(`Configured ${result.provider === "typesafe" ? "TypeSafe" : "OpenRouter"} key in ${result.path}\n\n`);
      return true;
    } else {
      output.write(`Error: ${result.error}\n\n`);
      return false;
    }
  } finally {
    rl.close();
  }
}

/**
 * Prepends project node_modules/.bin to process.env.PATH so child processes can invoke vex and jev.
 */
export function ensureLocalBinInPath(): void {
  try {
    const nodeModulesBin = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "node_modules", ".bin");
    if (existsSync(nodeModulesBin)) {
      const current = process.env.PATH || "";
      if (!current.split(delimiter).includes(nodeModulesBin)) {
        process.env.PATH = `${nodeModulesBin}${delimiter}${current}`;
      }
    }
  } catch {}
}
