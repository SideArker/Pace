import { expect, it } from "vitest";
import { formatTurnFooter } from "../src/turn-format.js";

it("shows a compact two-line turn footer with the routing source", () => {
  expect(formatTurnFooter(
    { model: "gpt-6-sol", effort: "medium" },
    "Selected by Vex",
    { input_tokens: 15878, cached_input_tokens: 11904, cache_write_input_tokens: 0, output_tokens: 27, reasoning_output_tokens: 11 },
    1200,
  )).toBe("↳ Sol · Medium · 1.2s · 15.9k input · 27 output\nCache: 11.9k hit · Route: auto → Sol");
  expect(formatTurnFooter({ model: "gpt-6-luna", effort: "low" }, "Policy fallback after Vex abstained or was uncertain"))
    .toBe("↳ Luna · Low\nRoute: auto (policy) → Luna");
});
