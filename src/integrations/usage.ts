import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export type UsageWindow = { usedPercent: number; windowDurationMins: number | null; resetsAt?: number };
export type UsageLimits = { primary?: UsageWindow; secondary?: UsageWindow };
export type UsageWarningLevels = Partial<Record<"5h" | "7d", 50 | 25 | 10>>;

export function usageWarnings(limits: UsageLimits, previous: UsageWarningLevels): {
  levels: UsageWarningLevels;
  messages: string[];
} {
  const levels = { ...previous };
  const messages: string[] = [];
  for (const [label, minutes] of [["5h", 300], ["7d", 10080]] as const) {
    const window = [limits.primary, limits.secondary].find(item => item?.windowDurationMins === minutes);
    if (!window) continue;
    const remaining = 100 - window.usedPercent;
    const threshold = ([10, 25, 50] as const).find(value => remaining < value);
    if (threshold && (!previous[label] || threshold < previous[label])) {
      messages.push(`Codex ${label} usage warning: ${remaining.toFixed(1)}% remaining (below ${threshold}%).`);
    }
    if (threshold) levels[label] = threshold;
    else delete levels[label];
  }
  return { levels, messages };
}

type RateLimitResponse = {
  rateLimits?: { primary?: UsageWindow | null; secondary?: UsageWindow | null };
};

function validWindow(value: unknown): value is UsageWindow {
  if (!value || typeof value !== "object") return false;
  const window = value as Partial<UsageWindow>;
  return typeof window.usedPercent === "number" && Number.isFinite(window.usedPercent)
    && (window.windowDurationMins === null || typeof window.windowDurationMins === "number")
    && (window.resetsAt === undefined || (typeof window.resetsAt === "number" && Number.isFinite(window.resetsAt)));
}

export function parseUsageLimits(value: unknown): UsageLimits | undefined {
  const limits = (value as RateLimitResponse | null)?.rateLimits;
  if (!limits || typeof limits !== "object") return undefined;
  const primary = validWindow(limits.primary) ? limits.primary : undefined;
  const secondary = validWindow(limits.secondary) ? limits.secondary : undefined;
  return primary || secondary ? { primary, secondary } : undefined;
}

export async function readUsageLimits(): Promise<UsageLimits | undefined> {
  try {
    const require = createRequire(import.meta.url);
    const packagePath = require.resolve("@openai/codex/package.json");
    const codexPath = join(dirname(packagePath), "bin", "codex.js");
    return await new Promise(resolve => {
      const child = spawn(process.execPath, [codexPath, "app-server", "--stdio"], {
        windowsHide: true, stdio: ["pipe", "pipe", "ignore"],
      });
      let finished = false;
      const finish = (limits?: UsageLimits) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        child.kill();
        resolve(limits);
      };
      const timeout = setTimeout(() => finish(), 8000);
      let buffer = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buffer += chunk;
        if (buffer.length > 1_000_000) return finish();
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          let message: { id?: number; result?: unknown; error?: unknown };
          try { message = JSON.parse(line); } catch { continue; }
          if (message.id === 1 && !message.error) {
            child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
            child.stdin.write(JSON.stringify({ id: 2, method: "account/rateLimits/read", params: { excludeResetCreditDetails: true } }) + "\n");
          }
          if (message.id === 1 && message.error) finish();
          if (message.id === 2) finish(message.error ? undefined : parseUsageLimits(message.result));
        }
      });
      child.on("error", () => finish());
      child.on("close", () => finish());
      child.stdin.on("error", () => finish());
      child.stdin.write(JSON.stringify({ id: 1, method: "initialize", params: {
        clientInfo: { name: "pace", title: "Pace", version: "0.1.0" }, capabilities: null,
      } }) + "\n");
    });
  } catch {
    return undefined;
  }
}
