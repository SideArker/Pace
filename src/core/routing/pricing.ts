import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Effort, ModelOption, Route, Usage } from "../../shared/types.js";
import { EFFORTS, isRecord } from "../../shared/config.js";
import { atomicJson } from "../sessions.js";

export type Rates = { input: number; cachedInput: number; cacheWriteInput: number; output: number };
export type PriceSnapshot = {
  checkedAt: string;
  source: string;
  processing: "standard";
  context: string;
  rates: Record<string, Rates>;
};
export type VersionManifest = {
  schemaVersion: 1;
  pace: { latest: string; releaseUrl: string };
  models?: Record<string, { efforts: Effort[]; defaultEffort: Effort }>;
  pricing: PriceSnapshot;
};
export const MANIFEST_URL = "https://raw.githubusercontent.com/SideArker/Pace/main/versions.json";
const cachePath = join(homedir(), ".pace", "versions-cache.json");
const bundled = parseVersionManifest(JSON.parse(readFileSync(new URL("../../../versions.json", import.meta.url), "utf8")));
let manifest = bundled;
let manifestSource: "bundled" | "github" | "cache" = "bundled";
export let PRICE_SNAPSHOT: PriceSnapshot = manifest.pricing;
let refreshedAt = 0;
let pending: Promise<VersionManifest> | undefined;

export function parseVersionManifest(value: unknown): VersionManifest {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.pace) || !isRecord(value.pricing))
    throw new Error("Invalid Pace versions manifest");
  const { pace, pricing } = value;
  if (typeof pace.latest !== "string" || !/^\d+\.\d+\.\d+$/.test(pace.latest) ||
      typeof pace.releaseUrl !== "string" || !pace.releaseUrl.startsWith("https://github.com/SideArker/Pace/releases") ||
      typeof pricing.checkedAt !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(pricing.checkedAt) ||
      !Number.isFinite(Date.parse(pricing.checkedAt)) ||
      pricing.source !== "https://developers.openai.com/api/docs/pricing" ||
      pricing.processing !== "standard" || typeof pricing.context !== "string" ||
      !pricing.context.trim() || !isRecord(pricing.rates) || !Object.keys(pricing.rates).length)
    throw new Error("Invalid Pace versions manifest metadata");
  const rates: Record<string, Rates> = {};
  for (const [model, entry] of Object.entries(pricing.rates)) {
    if (!/^[a-zA-Z0-9._-]+$/.test(model) || !isRecord(entry) ||
        !["input", "cachedInput", "cacheWriteInput", "output"].every(key =>
          typeof entry[key] === "number" && Number.isFinite(entry[key]) && (entry[key] as number) > 0))
      throw new Error(`Invalid price for ${model}`);
    rates[model] = Object.freeze({
      input: entry.input as number,
      cachedInput: entry.cachedInput as number,
      cacheWriteInput: entry.cacheWriteInput as number,
      output: entry.output as number,
    });
  }
  const models: NonNullable<VersionManifest["models"]> = {};
  if (value.models !== undefined && !isRecord(value.models)) throw new Error("Invalid Pace model hints");
  for (const [model, entry] of Object.entries(value.models ?? {})) {
    if (!/^[a-zA-Z0-9._-]+$/.test(model) || !isRecord(entry) || !Array.isArray(entry.efforts) ||
        !entry.efforts.length || !entry.efforts.every(effort => EFFORTS.includes(effort as Effort)) ||
        !entry.efforts.includes(entry.defaultEffort) || !rates[model])
      throw new Error(`Invalid model hint for ${model}`);
    models[model] = Object.freeze({ efforts: [...new Set(entry.efforts)] as Effort[], defaultEffort: entry.defaultEffort as Effort });
  }
  return Object.freeze({
    schemaVersion: 1,
    pace: Object.freeze({ latest: pace.latest, releaseUrl: pace.releaseUrl }),
    models: Object.freeze(models),
    pricing: Object.freeze({
      checkedAt: pricing.checkedAt,
      source: pricing.source,
      processing: "standard" as const,
      context: pricing.context,
      rates: Object.freeze(rates),
    }),
  });
}

export function currentVersionManifest(): VersionManifest { return manifest; }
export function currentManifestSource(): "bundled" | "github" | "cache" { return manifestSource; }

export function newerPaceVersion(installed: string, latest: string): boolean {
  const parse = (version: string) => /^\d+\.\d+\.\d+$/.test(version) ? version.split(".").map(Number) : undefined;
  const left = parse(installed);
  const right = parse(latest);
  if (!left || !right) return false;
  for (let index = 0; index < 3; index++) {
    if (right[index]! !== left[index]!) return right[index]! > left[index]!;
  }
  return false;
}

function shouldUse(candidate: VersionManifest, current: VersionManifest): boolean {
  if (candidate.pricing.checkedAt < current.pricing.checkedAt ||
      newerPaceVersion(candidate.pace.latest, current.pace.latest)) return false;
  return candidate.pricing.checkedAt > current.pricing.checkedAt ||
    Object.keys(current.pricing.rates).every(model => candidate.pricing.rates[model]);
}

export async function refreshVersionManifest(
  fetcher: typeof fetch = fetch,
  cache = cachePath,
  force = false,
): Promise<VersionManifest> {
  if (!force && refreshedAt && Date.now() - refreshedAt < 3_600_000) return manifest;
  if (pending) return pending;
  pending = (async () => {
    try {
      const response = await fetcher(MANIFEST_URL, { signal: AbortSignal.timeout(5000), headers: { accept: "application/json" } });
      if (!response.ok || Number(response.headers.get("content-length") ?? 0) > 65_536)
        throw new Error("Pace versions manifest unavailable");
      const body = await response.text();
      if (body.length > 65_536) throw new Error("Pace versions manifest too large");
      const candidate = parseVersionManifest(JSON.parse(body));
      if (shouldUse(candidate, manifest)) {
        manifest = candidate;
        manifestSource = "github";
        PRICE_SNAPSHOT = candidate.pricing;
        await atomicJson(cache, candidate).catch(() => {});
      }
    } catch {
      try {
        const candidate = parseVersionManifest(JSON.parse(await readFile(cache, "utf8")));
        if (shouldUse(candidate, manifest)) {
          manifest = candidate;
          manifestSource = "cache";
          PRICE_SNAPSHOT = candidate.pricing;
        }
      } catch { /* Bundled manifest remains available. */ }
    } finally {
      refreshedAt = Date.now();
    }
    return manifest;
  })();
  try { return await pending; }
  finally { pending = undefined; }
}

export function modelRates(model: string, snapshot: PriceSnapshot = PRICE_SNAPSHOT): Rates | undefined {
  return snapshot.rates[model];
}
export function pricedModels(models: ModelOption[], snapshot: PriceSnapshot = PRICE_SNAPSHOT): ModelOption[] {
  const missing = models.filter(model => !modelRates(model.model, snapshot)).map(model => model.model);
  if (missing.length)
    throw new Error(`No verified price for ${missing.join(", ")}. Disable these models before auto routing.`);
  return models;
}
export function costForUsage(
  route: Route,
  usage: Usage | undefined,
  snapshot: PriceSnapshot = PRICE_SNAPSHOT,
): number | undefined {
  const rates = route.model && modelRates(route.model, snapshot);
  if (!rates || !usage) return undefined;
  const ordinary = usage.input_tokens - usage.cached_input_tokens - usage.cache_write_input_tokens;
  if (ordinary < 0) throw new Error(`Invalid token usage for ${route.model}: cache tokens exceed input tokens`);
  return (ordinary * rates.input + usage.cached_input_tokens * rates.cachedInput +
    usage.cache_write_input_tokens * rates.cacheWriteInput + usage.output_tokens * rates.output) / 1_000_000;
}
