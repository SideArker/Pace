import type { Usage } from "@openai/codex-sdk";
import type { Execution } from "./codex-types.js";
import { isRecord } from "./app-server-process.js";
import { appUsage } from "./app-server-protocol.js";
import { contextMeasurement } from "../core/context.js";

function sumUsage(left: Usage, right: Usage): Usage {
  return {
    input_tokens: left.input_tokens + right.input_tokens,
    cached_input_tokens: left.cached_input_tokens + right.cached_input_tokens,
    cache_write_input_tokens: left.cache_write_input_tokens + right.cache_write_input_tokens,
    output_tokens: left.output_tokens + right.output_tokens,
    reasoning_output_tokens: left.reasoning_output_tokens + right.reasoning_output_tokens,
  };
}

/** A cumulative total identifies one model request within an identified turn.
 * Repeated readings update that request; they are not additional inference. */
export class TurnUsage {
  private readonly requests = new Map<number, Usage | undefined>();
  private unidentified = false;
  private fallback?: Usage;
  private billingStopped = false;
  context?: Execution["context"];
  private contextTotal = -1;

  markUnknown(): void { this.unidentified = true; }

  stopBilling(): void {
    // Without per-request model metadata, later inference cannot be priced on
    // the requested route. Preserve only the subtotal observed before reroute.
    this.billingStopped = true;
    this.markUnknown();
    this.context = undefined;
  }

  observe(value: unknown, model?: string): void {
    if (this.billingStopped) return;
    const raw = isRecord(value) ? value : {};
    const total = isRecord(raw.total) ? raw.total.totalTokens : undefined;
    if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0) {
      this.markUnknown();
      this.context = undefined;
      return;
    }
    this.requests.set(total, billableUsage(raw));
    if (total >= this.contextTotal) {
      this.contextTotal = total;
      this.context = contextMeasurement(raw, model);
    }
  }

  complete(...values: unknown[]): void {
    // Completion usage is a compatibility fallback, never a second charge.
    if (!this.requests.size && !this.billingStopped) this.fallback = values.map(billableUsage).find(value => value !== undefined);
  }

  get knownUsage(): Usage | undefined {
    let sum = this.fallback;
    for (const reading of this.requests.values()) if (reading) sum = sum ? sumUsage(sum, reading) : reading;
    return sum;
  }

  get usageComplete(): boolean {
    return !this.unidentified && (this.requests.size > 0
      ? [...this.requests.values()].every(reading => reading !== undefined)
      : this.fallback !== undefined);
  }

  get usage(): Usage | undefined { return this.usageComplete ? this.knownUsage : undefined; }
}

function billableUsage(value: unknown): Usage | undefined {
  if (!isRecord(value)) return undefined;
  const last = isRecord(value.last) ? value.last : value;
  const keys = [
    ["input_tokens", "inputTokens"], ["cached_input_tokens", "cachedInputTokens"],
    ["cache_write_input_tokens", "cacheWriteInputTokens"], ["output_tokens", "outputTokens"],
    ["reasoning_output_tokens", "reasoningOutputTokens"],
  ];
  if (keys.some(([snake, camel]) => {
    const number = last[snake!] ?? last[camel!];
    return typeof number !== "number" || !Number.isSafeInteger(number) || number < 0;
  })) return undefined;
  const usage = appUsage(value);
  if (!usage || usage.cached_input_tokens + usage.cache_write_input_tokens > usage.input_tokens ||
      usage.reasoning_output_tokens > usage.output_tokens) return undefined;
  // Native compaction can report context size with no billing measurement.
  if (typeof last.totalTokens === "number" && last.totalTokens > 0 &&
      usage.input_tokens === 0 && usage.output_tokens === 0) return undefined;
  return usage;
}
