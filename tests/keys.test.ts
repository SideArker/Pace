import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseKeyFormat, saveApiKey, hasConfiguredKey, ensureLocalBinInPath } from '../src/core/system/keys.js';

let testDir: string | undefined;

afterEach(async () => {
  if (testDir) {
    await rm(testDir, { recursive: true, force: true });
    testDir = undefined;
  }
});

it('identifies TypeSafe and OpenRouter key formats correctly', () => {
  expect(parseKeyFormat('ts-live-12345')).toBe('typesafe');
  expect(parseKeyFormat('ts_test_67890')).toBe('typesafe');
  expect(parseKeyFormat('sk-or-v1-abcdef')).toBe('openrouter');
  expect(parseKeyFormat('sk-general-key')).toBe('openrouter');
  expect(parseKeyFormat('not-a-valid-key')).toBe('unknown');
  expect(parseKeyFormat('   ')).toBe('unknown');
});

it('saves OpenRouter key to ~/.openrouter_key with 0600 permissions', async () => {
  testDir = await mkdtemp(join(tmpdir(), 'pace-keys-'));
  const dummyKey = 'sk-or-v1-testopenrouterkey123';

  const prevEnv = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;

  try {
    const result = saveApiKey(dummyKey, testDir);
    expect(result.success).toBe(true);
    expect(result.provider).toBe('openrouter');

    const keyPath = join(testDir, '.openrouter_key');
    const content = await readFile(keyPath, 'utf8');
    expect(content.trim()).toBe(dummyKey);

    const fileStat = await stat(keyPath);
    // Verify file mode ends with 0600 (owner read/write only)
    expect(fileStat.mode & 0o777).toBe(0o600);
    expect(process.env.OPENROUTER_API_KEY).toBe(dummyKey);
  } finally {
    if (prevEnv) process.env.OPENROUTER_API_KEY = prevEnv;
    else delete process.env.OPENROUTER_API_KEY;
  }
});

it('saves TypeSafe key to ~/.typesafe_key with 0600 permissions', async () => {
  testDir = await mkdtemp(join(tmpdir(), 'pace-keys-'));
  const dummyKey = 'ts-live-typesafekey999';

  const prevEnv = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;

  try {
    const result = saveApiKey(dummyKey, testDir);
    expect(result.success).toBe(true);
    expect(result.provider).toBe('typesafe');

    const keyPath = join(testDir, '.typesafe_key');
    const content = await readFile(keyPath, 'utf8');
    expect(content.trim()).toBe(dummyKey);

    const fileStat = await stat(keyPath);
    expect(fileStat.mode & 0o777).toBe(0o600);
    expect(process.env.TYPESAFE_API_KEY).toBe(dummyKey);
  } finally {
    if (prevEnv) process.env.TYPESAFE_API_KEY = prevEnv;
    else delete process.env.TYPESAFE_API_KEY;
  }
});

it('rejects invalid key formats when saving', async () => {
  testDir = await mkdtemp(join(tmpdir(), 'pace-keys-'));
  const result = saveApiKey('invalid-token', testDir);
  expect(result.success).toBe(false);
  expect(result.error).toContain('Invalid key format');
});

it('detects whether a key is configured', async () => {
  testDir = await mkdtemp(join(tmpdir(), 'pace-keys-'));

  const prevOr = process.env.OPENROUTER_API_KEY;
  const prevTs = process.env.TYPESAFE_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.TYPESAFE_API_KEY;

  try {
    expect(hasConfiguredKey(testDir)).toBe(false);

    saveApiKey('sk-or-v1-mykey', testDir);
    expect(hasConfiguredKey(testDir)).toBe(true);
  } finally {
    if (prevOr) process.env.OPENROUTER_API_KEY = prevOr;
    else delete process.env.OPENROUTER_API_KEY;
    if (prevTs) process.env.TYPESAFE_API_KEY = prevTs;
    else delete process.env.TYPESAFE_API_KEY;
  }
});

it('ensures local bin directory is added to PATH without error', () => {
  expect(() => ensureLocalBinInPath()).not.toThrow();
});
