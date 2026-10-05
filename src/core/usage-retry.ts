import type { UsageLimits } from "../integrations/usage.js";

const RETRY_INTERVAL_MS = 5 * 60_000;

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
