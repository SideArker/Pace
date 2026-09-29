import { isRecord } from "../shared/config.js";
import type { ContextMeasurement, Session } from "../shared/types.js";

/** App Server thread/tokenUsage/updated reports the last model request separately
 * from cumulative thread usage. Only the former describes occupied context. */
export function contextMeasurement(value: unknown, model?: string): ContextMeasurement | undefined {
  if (!isRecord(value) || !isRecord(value.last)) return undefined;
  const tokens = value.last.totalTokens;
  const windowTokens = value.modelContextWindow;
  if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens < 0 ||
      typeof windowTokens !== "number" || !Number.isFinite(windowTokens) || windowTokens <= 0)
    return undefined;
  return { tokens, windowTokens, ...(model ? { model } : {}) };
}

export function measuredContext(session: Session): ContextMeasurement | undefined {
  const reading = session.threadId && session.contextByThread?.[session.threadId];
  return reading && reading.model === session.route.model ? reading : undefined;
}

export function contextPercent(reading: ContextMeasurement | undefined): number | undefined {
  return reading ? Math.min(100, Math.round(reading.tokens / reading.windowTokens * 100)) : undefined;
}
