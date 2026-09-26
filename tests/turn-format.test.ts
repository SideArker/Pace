import { expect, it } from "vitest";
import { formatTurnFooter, formatUsageLimits } from "../src/components/turn-format.js";
import { parseUsageLimits } from "../src/integrations/usage.js";

it("shows a compact two-line turn footer with the routing source", () => {
  expect(formatTurnFooter(
    { model: "gpt-6-sol", effort: "medium" },
    "Selected by Vex",
    { input_tokens: 15878, cached_input_tokens: 11904, cache_write_input_tokens: 0, output_tokens: 27, reasoning_output_tokens: 11 },
    1200,
  )).toBe("↳ Sol · Medium · 1.2s · 15.9k input · 27 output\nCache: 11.9k hit, 0 write · Route: auto → Sol");
  expect(formatTurnFooter({ model: "gpt-6-luna", effort: "low" }, "Policy fallback after Vex abstained or was uncertain"))
    .toBe("↳ Luna · Low\nRoute: auto (policy) → Luna");
});

it("shows reported account usage percentages and omits missing windows", () => {
  const limits = parseUsageLimits({ rateLimits: {
    primary: { usedPercent: 37.5, windowDurationMins: 300, resetsAt: 0 },
    secondary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: 0 },
  } });
  expect(formatUsageLimits(limits)).toBe("Usage: 5h 37.5% · 7d 12%");
  expect(formatUsageLimits(parseUsageLimits({ rateLimits: { primary: null, secondary: { usedPercent: 8, windowDurationMins: 60 } } })))
    .toBe("Usage: 1h 8%");
  expect(formatUsageLimits(parseUsageLimits({ rateLimits: { primary: { usedPercent: "40", windowDurationMins: 300 } } })))
    .toBe("Usage unavailable");
});
