import type { Usage } from "@openai/codex-sdk";
import type { ModelOption, Route } from "../../shared/types.js";

/** Standard, short-context API prices in USD per million tokens, checked 2026-09-26. */
export const PRICE_SNAPSHOT = {
  checkedAt: "2026-09-26",
  source: "https://developers.openai.com/api/docs/pricing",
  processing: "standard",
  context: "short (at most 272K input tokens per request)",
  rates: {
    "gpt-6-luna": {
      input: 0.1,
      cachedInput: 0.01,
      cacheWriteInput: 0.125,
      output: 0.5,
    },
    "gpt-6-sol": {
      input: 2.0,
      cachedInput: 0.2,
      cacheWriteInput: 2.5,
      output: 10.0,
    },
    "gpt-6-astra": {
      input: 10.0,
      cachedInput: 1.0,
      cacheWriteInput: 12.5,
      output: 50.0,
    },
  },
} as const;

export type Rates = {
  input: number;
  cachedInput: number;
  cacheWriteInput: number;
  output: number;
};
export function modelRates(model: string): Rates | undefined {
  return PRICE_SNAPSHOT.rates[model as keyof typeof PRICE_SNAPSHOT.rates];
}
export function pricedModels(models: ModelOption[]): ModelOption[] {
  const missing = models
    .filter((model) => !modelRates(model.model))
    .map((model) => model.model);
  if (missing.length)
    throw new Error(
      `No verified price for ${missing.join(", ")}. Disable these models before auto routing.`,
    );
  return models;
}
export function costForUsage(
  route: Route,
  usage: Usage | undefined,
): number | undefined {
  const rates = route.model && modelRates(route.model);
  if (!rates || !usage) return undefined;
  const ordinary =
    usage.input_tokens -
    usage.cached_input_tokens -
    usage.cache_write_input_tokens;
  if (ordinary < 0)
    throw new Error(
      `Invalid token usage for ${route.model}: cache tokens exceed input tokens`,
    );
  return (
    (ordinary * rates.input +
      usage.cached_input_tokens * rates.cachedInput +
      usage.cache_write_input_tokens * rates.cacheWriteInput +
      usage.output_tokens * rates.output) /
    1_000_000
  );
}
