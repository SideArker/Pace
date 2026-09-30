import { expect, it } from "vitest";
import { contextMeasurement, contextPercent, measuredContext } from "../src/core/context.js";
import { contextLabel } from "../src/components/ComposerFrame.js";
import { newSession } from "../src/core/sessions.js";

it("uses the last model request and never cumulative billed tokens for context", () => {
  const reading = contextMeasurement({
    total: { totalTokens: 760_000 },
    last: { totalTokens: 130_000, inputTokens: 120_000, outputTokens: 10_000 },
    modelContextWindow: 250_000,
  }, "gpt-6-sol");
  expect(reading).toEqual({ tokens: 130_000, windowTokens: 250_000, model: "gpt-6-sol" });
  expect(contextPercent(reading)).toBe(52);
});

it("shows unknown when either measured value is unavailable or the selected model changes", () => {
  expect(contextMeasurement({ last: { totalTokens: 42 }, modelContextWindow: null })).toBeUndefined();
  expect(contextMeasurement({ total: { totalTokens: 42 }, modelContextWindow: 100 })).toBeUndefined();
  const session = newSession(process.cwd(), "manual");
  session.threadId = "thread-1";
  session.route = { model: "gpt-6-sol", effort: "high" };
  session.contextByThread = { "thread-1": { tokens: 130, windowTokens: 250, model: "gpt-6-sol" } };
  expect(measuredContext(session)?.tokens).toBe(130);
  expect(contextLabel(session)).toBe("◕ Context 52%");
  session.route = { model: "gpt-6-luna", effort: "low" };
  expect(contextLabel(session)).toBe("○ Context ?");
  session.threadId = "thread-2";
  expect(contextLabel(session)).toBe("○ Context ?");
});
