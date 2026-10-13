import type { UsageLimits } from "../integrations/usage.js";
import type { Session } from "../shared/types.js";

const RETRY_INTERVAL_MS = 5 * 60_000;
export type RetryReason = NonNullable<Session["deferredTurn"]>["reason"];

export function transientRetryReason(error: unknown): "network" | "capacity" | undefined {
  const message = String(error);
  if (/(?:ENETUNREACH|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EHOSTUNREACH|ConnectTimeoutError|socket hang up|fetch failed|network (?:error|unavailable|is unreachable)|internet connection|connection (?:error|lost|timed out|refused)|DNS lookup)/i.test(message)) return "network";
  if (/(?:model.{0,40}(?:at capacity|overloaded|unavailable)|(?:server|service).{0,30}(?:overloaded|at capacity)|(?:HTTP|status)\s*(?:429|503|529)\b|too many requests|temporarily unavailable)/i.test(message)) return "capacity";
  return undefined;
}

export function transientRetryAt(reason: "network" | "capacity", attempt: number, now = new Date()): Date {
  const delay = reason === "network" ? 15_000 : Math.min(120_000, 10_000 * 2 ** Math.min(attempt - 1, 4));
  return new Date(now.getTime() + delay);
}

export async function networkReachable(): Promise<boolean> {
  try {
    await fetch("https://api.openai.com/v1/models", {
      method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(5000),
    });
    return true;
  } catch { return false; }
}

export function isUsageLimitError(error: unknown): boolean {
  return /(?:usage|rate|quota|credit).{0,60}(?:limit|exhaust|exceed)|(?:limit|exhaust|exceed).{0,60}(?:usage|rate|quota|credit)|try again at .{1,30}(?:AM|PM)/i.test(String(error));
}

export function usageRetryAt(error: unknown, limits: UsageLimits | undefined, now = new Date()): Date {
  const minimum = now.getTime() + 15_000;
  const fullWindows = [limits?.primary, limits?.secondary]
    .filter(window => window && window.usedPercent >= 99.9 && window.resetsAt && window.resetsAt > 0)
    .map(window => window!.resetsAt! > 1_000_000_000_000 ? window!.resetsAt! : window!.resetsAt! * 1000)
    .filter(value => value > minimum && value < now.getTime() + 8 * 24 * 60 * 60_000);
  if (fullWindows.length) return new Date(Math.max(...fullWindows) + 5_000);

  const match = String(error).match(/try again at\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (match) {
    const hour = Number(match[1]) % 12 + (match[3]!.toUpperCase() === "PM" ? 12 : 0);
    const minute = Number(match[2]);
    if (Number(match[1]) >= 1 && Number(match[1]) <= 12 && minute < 60) {
      const reset = new Date(now);
      reset.setHours(hour, minute, 5, 0);
      if (reset.getTime() > minimum) return reset;
    }
  }
  return new Date(now.getTime() + RETRY_INTERVAL_MS);
}
