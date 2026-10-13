import { expect, it } from "vitest";
import React from "react";
import { renderToString } from "ink";
import { formatLiveUsage, formatTurnFooter, formatUsageLimits } from "../src/components/turn-format.js";
import { UsageBar } from "../src/components/UsageBar.js";
import { parseUsageLimits, usageWarnings } from "../src/integrations/usage.js";

it("shows a compact two-line turn footer with the routing source", () => {
  expect(formatTurnFooter(
    { model: "gpt-6-sol", effort: "medium" },
    "Selected by Vex",
    { input_tokens: 15878, cached_input_tokens: 11904, cache_write_input_tokens: 0, output_tokens: 27, reasoning_output_tokens: 11 },
    1200,
  )).toBe("Completed · Sol · Medium · 1.2s · 15.9k input · 27 output\nCache: 11.9k hit, 0 write · Route: auto → Sol");
  expect(formatTurnFooter({ model: "gpt-6-luna", effort: "low" }, "Policy fallback after Vex abstained or was uncertain"))
    .toBe("Completed · Luna · Low\nRoute: auto (policy) → Luna");
});

it("formats observed in-turn usage with the active stage price", () => {
  expect(formatLiveUsage({ input_tokens: 1200, cached_input_tokens: 200, cache_write_input_tokens: 0, output_tokens: 30, reasoning_output_tokens: 10 }, { model: 'gpt-6-sol', effort: 'high' }))
    .toContain('1.2k input · 30 output · ~$');
});

it("shows reported account usage percentages and omits missing windows", () => {
  const limits = parseUsageLimits({ rateLimits: {
    primary: { usedPercent: 37.5, windowDurationMins: 300, resetsAt: 0 },
    secondary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: 0 },
  } });
  expect(formatUsageLimits(limits)).toBe("Usage: 5h 62.5% left · 7d 88% left");
  expect(formatUsageLimits(parseUsageLimits({ rateLimits: { primary: null, secondary: { usedPercent: 8, windowDurationMins: 60 } } })))
    .toBe("Usage: 1h 92% left");
  expect(formatUsageLimits(parseUsageLimits({ rateLimits: { primary: { usedPercent: "40", windowDurationMins: 300 } } })))
    .toBe("Usage unavailable");
});

it("shows remaining Codex usage as the primary meter value", () => {
  const output = renderToString(React.createElement(UsageBar, {
    limits: { primary: { usedPercent: 88, windowDurationMins: 300 } },
  }), { columns: 80 });
  expect(output).toContain("Codex Usage");
  expect(output).toContain("12% left");
  expect(output).toContain("88% used");
});

it("shows local reset times for valid windows and omits invalid or absent times", () => {
  const resetsAt = 1_800_000_000;
  const output = renderToString(React.createElement(UsageBar, {
    limits: { primary: { usedPercent: 12, windowDurationMins: 300, resetsAt },
      secondary: { usedPercent: 34, windowDurationMins: 10080 } }, width: 42,
  }), { columns: 42 });
  expect(output).toContain(`Resets ${new Date(resetsAt * 1000).toLocaleString()}`);
  expect(output.match(/Resets/g)).toHaveLength(1);
  expect(output).toContain('88% left');
  const invalid = renderToString(React.createElement(UsageBar, {
    limits: { primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: Number.POSITIVE_INFINITY } },
  }), { columns: 80 });
  expect(invalid).toContain('75% left');
  expect(invalid).not.toContain('Resets');
  const parsed = parseUsageLimits({ rateLimits: { primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 'invalid' } } });
  expect(parsed?.primary).toEqual({ usedPercent: 25, windowDurationMins: 300 });
});

it("keeps the last usage reading visible after a refresh failure", () => {
  const output = renderToString(React.createElement(UsageBar, {
    limits: { primary: { usedPercent: 60, windowDurationMins: 300 } },
    error: "Usage unavailable",
  }), { columns: 80 });
  expect(output).toContain("40% left");
  expect(output).toContain("showing last reading");
});

it("warns once per crossed usage threshold and re-arms after recovery", () => {
  const reading = (fiveHourUsed: number, sevenDayUsed: number) => ({
    primary: { usedPercent: sevenDayUsed, windowDurationMins: 10080 },
    secondary: { usedPercent: fiveHourUsed, windowDurationMins: 300 },
  });
  let levels = usageWarnings(reading(40, 20), {}).levels;
  let result = usageWarnings(reading(51, 76), levels);
  expect(result.messages).toEqual([
    "Codex 5h usage warning: 49.0% remaining (below 50%).",
    "Codex 7d usage warning: 24.0% remaining (below 25%).",
  ]);
  levels = result.levels;
  expect(usageWarnings(reading(51, 76), levels).messages).toEqual([]);
  result = usageWarnings(reading(91, 76), levels);
  expect(result.messages).toEqual(["Codex 5h usage warning: 9.0% remaining (below 10%)."]);
  levels = usageWarnings(reading(0, 76), result.levels).levels;
  expect(usageWarnings(reading(51, 76), levels).messages).toEqual([
    "Codex 5h usage warning: 49.0% remaining (below 50%).",
  ]);
});

it("ignores unrecognized and missing usage windows", () => {
  const result = usageWarnings({ primary: { usedPercent: 95, windowDurationMins: 60 } }, {});
  expect(result.messages).toEqual([]);
  expect(result.levels).toEqual({});
});
