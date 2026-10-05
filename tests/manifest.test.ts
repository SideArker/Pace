import { expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { currentManifestSource, currentVersionManifest, modelRates, newerPaceVersion, parseVersionManifest, refreshVersionManifest } from '../src/core/routing/pricing.js';

it('validates the published catalog and compares installed versions numerically', () => {
  const manifest = currentVersionManifest();
  expect(manifest.models?.['gpt-6.1-sol']?.defaultEffort).toBe('medium');
  expect(manifest.pricing.rates['gpt-6.1-sol']).toEqual({ input: 2, cachedInput: 0.1, cacheWriteInput: 2.5, output: 10 });
  expect(newerPaceVersion('0.9.9', '0.10.0')).toBe(true);
  expect(newerPaceVersion('1.0.0', '0.99.0')).toBe(false);
  expect(() => parseVersionManifest({ ...manifest, pricing: { ...manifest.pricing, rates: { bad: { input: -1 } } } })).toThrow();
  expect(() => parseVersionManifest({ ...manifest, models: { 'gpt-6.1-sol': { efforts: ['max'], defaultEffort: 'max' } } })).toThrow();
});

it('refreshes prices from GitHub and uses cached data when offline', async () => {
  const base = currentVersionManifest();
  const dir = await mkdtemp(join(tmpdir(), 'pace-manifest-'));
  const cache = join(dir, 'versions-cache.json');
  const updated = { ...base, pace: { ...base.pace, latest: '0.2.0' }, pricing: {
    ...base.pricing, rates: { ...base.pricing.rates, 'gpt-6.1-sol': { input: 3, cachedInput: 0.15, cacheWriteInput: 3.75, output: 15 } },
  } };
  const success = async () => new Response(JSON.stringify(updated), { status: 200 });
  const offline = async (): Promise<Response> => { throw new Error('offline'); };
  try {
    expect((await refreshVersionManifest(success as typeof fetch, cache, true)).pace.latest).toBe('0.2.0');
    expect(currentManifestSource()).toBe('github');
    expect(modelRates('gpt-6.1-sol')?.input).toBe(3);
    expect((await refreshVersionManifest(offline as typeof fetch, cache, true)).pricing.rates['gpt-6.1-sol']?.input).toBe(3);
    expect(currentManifestSource()).toBe('cache');
  } finally {
    await refreshVersionManifest((async () => new Response(JSON.stringify(base))) as typeof fetch, cache, true);
    await rm(dir, { recursive: true, force: true });
  }
});
