import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { atomicJson } from '../sessions.js';

export const BASIC_MEMORY_VERSION = '0.24.1';
export const MEMORY_POLICY = Object.freeze({ version: 1, searchResults: 5, initialNotes: 2, graphDepth: 1, recallBytes: 3000, responseBytes: 4000, captureBytes: 1200, toolSteps: 8, timeoutMs: 20_000, tokenCounting: 'estimate; byte limits are independent safeguards' });
const absolutePath = z.string().min(1).refine(isAbsolute, 'Expected an absolute path');
const readySchema = z.object({
  version: z.literal(1), id: z.uuid(), canonicalPath: absolutePath, backend: z.literal('basic-memory'),
  backendVersion: z.literal(BASIC_MEMORY_VERSION), backendProject: z.string().regex(/^pace-[a-f0-9-]+$/),
  executable: absolutePath, configDirectory: absolutePath, dataDirectory: absolutePath,
  enabled: z.boolean(), revision: z.uuid(), setup: z.literal('ready'),
});
export type MemoryConfig = z.infer<typeof readySchema>;
export type MemoryState = { state: 'unconfigured' | 'configuring' | 'ready' | 'disabled' | 'unavailable'; config?: MemoryConfig; error?: string; pending?: unknown };
export const memoryRoot = (base = join(homedir(), '.pace')) => join(base, 'memory');
export async function memoryConfigPath(project: string, base?: string): Promise<string> {
  const canonical = await realpath(project);
  return join(memoryRoot(base), 'projects', createHash('sha256').update(canonical).digest('hex'), 'config.json');
}
export async function loadMemory(project: string, base?: string): Promise<MemoryState> {
  const file = await memoryConfigPath(project, base);
  let config: MemoryConfig;
  try {
    config = readySchema.parse(JSON.parse(await readFile(file, 'utf8')));
    if (config.canonicalPath !== await realpath(project)) throw new Error('Memory belongs to another canonical project path');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { state: 'unavailable', error: `Invalid memory configuration: ${String(error)}` };
    try { return { state: 'configuring', pending: JSON.parse(await readFile(file + '.pending', 'utf8')) }; }
    catch (pendingError) {
      if ((pendingError as NodeJS.ErrnoException).code !== 'ENOENT') return { state: 'unavailable', error: String(pendingError) };
      return { state: 'unconfigured' };
    }
  }
  if (!config.enabled) return { state: 'disabled', config };
  try {
    const health = JSON.parse(await readFile(join(config.configDirectory, 'pace-health.json'), 'utf8'));
    if (health.revision === config.revision && health.error) return { state: 'unavailable', config, error: health.error };
  } catch { /* No previous failure recorded. Live health is checked by the panel/adapter. */ }
  return { state: 'ready', config };
}
export async function saveMemory(config: MemoryConfig, base?: string): Promise<void> {
  config = readySchema.parse(config);
  if (await realpath(config.canonicalPath) !== config.canonicalPath) throw new Error('Project canonical path changed');
  await atomicJson(await memoryConfigPath(config.canonicalPath, base), config);
}
export async function setMemoryEnabled(config: MemoryConfig, enabled: boolean, base?: string): Promise<MemoryConfig> {
  const next = { ...config, enabled, revision: randomUUID() };
  await saveMemory(next, base);
  return next;
}
export async function candidateMemory(project: string, dataDirectory: string, executable: string, base?: string): Promise<MemoryConfig> {
  const canonicalPath = await realpath(project), id = randomUUID();
  if (!isAbsolute(dataDirectory) || !isAbsolute(executable)) throw new Error('Use absolute data and executable paths');
  await mkdir(dataDirectory, { recursive: true });
  if (!(await stat(dataDirectory)).isDirectory()) throw new Error('Memory data must be a directory');
  return readySchema.parse({ version: 1, id, canonicalPath, backend: 'basic-memory', backendVersion: BASIC_MEMORY_VERSION,
    backendProject: `pace-${id}`, executable, configDirectory: join(memoryRoot(base), 'backends', id),
    dataDirectory: await realpath(dataDirectory), enabled: true, revision: randomUUID(), setup: 'ready' });
}
