import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicJson } from '../sessions.js';
import { candidateMemory, loadMemory, memoryConfigPath, saveMemory, setMemoryEnabled, type MemoryConfig } from './config.js';
import { configureBasicMemory, connectBasicMemory, detectBasicMemory, installBasicMemory, validateBasicMemory } from '../../integrations/basic-memory.js';
import { memoryWriterLocked, repairMemoryWriter } from './access.js';

export const memorySetupService = {
  load: loadMemory, detect: detectBasicMemory, install: installBasicMemory, toggle: setMemoryEnabled,
  async check(config: MemoryConfig, signal?: AbortSignal, writeProbe = false) {
    try {
      if (await memoryWriterLocked(config)) throw new Error('Memory writer lock requires repair after verifying its process owner');
      await validateBasicMemory(config.executable, signal);
      const backend = await connectBasicMemory(config, signal, 60_000);
      const title = `pace-probe-${randomUUID()}`, identifier = `pace-setup/${title}`;
      let attemptedWrite = false;
      try {
        const projects = await backend.call('list_memory_projects', {}, signal) as { projects?: { name?: string }[] };
        if (!projects?.projects?.some(project => project.name === config.backendProject)) throw new Error('Configured project is unavailable; no new database was created');
        if (writeProbe) {
          attemptedWrite = true;
          await backend.call('write_note', { title, directory: 'pace-setup', content: title, overwrite: false }, signal);
          const read = await backend.call('read_note', { identifier }, signal);
          if (!JSON.stringify(read).includes(title)) throw new Error('Temporary write was not confirmed');
        }
      } finally {
        if (attemptedWrite) {
          try {
            if (signal?.aborted) throw new Error('Original connection cancelled');
            await backend.call('delete_note', { identifier });
          } catch {
            // Cancellation may close the original transport. Delete only this owned probe.
            await backend.close();
            const cleanup = await connectBasicMemory(config, AbortSignal.timeout(60_000), 60_000);
            try { await cleanup.call('delete_note', { identifier }); }
            catch (error) { throw new Error(`Temporary probe ${identifier} could not be removed; user notes were preserved: ${String(error)}`); }
            finally { await cleanup.close(); }
          } finally { await backend.close(); }
        } else await backend.close();
      }
      await atomicJson(join(config.configDirectory, 'pace-health.json'), { revision: config.revision, at: new Date().toISOString(), degraded: false });
    } catch (error) {
      await atomicJson(join(config.configDirectory, 'pace-health.json'), { revision: config.revision, at: new Date().toISOString(), degraded: true, error: String(error) }).catch(() => {});
      throw error;
    }
  },
  async setup(project: string, dataDirectory: string, executable: string, base: string, signal?: AbortSignal, onOutput?: (text: string) => void): Promise<MemoryConfig> {
    signal?.throwIfAborted();
    const previous = await loadMemory(project, base);
    if (previous.state === 'unavailable' && !previous.config) throw new Error('Invalid existing configuration must be repaired before setup can replace it');
    const config = await candidateMemory(project, dataDirectory, executable, base);
    const file = await memoryConfigPath(project, base);
    await atomicJson(file + '.pending', { version: 1, config, startedAt: new Date().toISOString() });
    await configureBasicMemory(config, signal, onOutput);
    await memorySetupService.check(config, signal, true);
    signal?.throwIfAborted();
    await saveMemory(config, base, previous.config?.revision ?? null);
    await unlink(file + '.pending');
    return config;
  },
  async repair(config: MemoryConfig, base: string, signal?: AbortSignal): Promise<MemoryConfig> {
    signal?.throwIfAborted();
    await repairMemoryWriter(config);
    let next = config;
    try { await memorySetupService.check(config, signal); }
    catch (error) {
      signal?.throwIfAborted();
      const detected = await detectBasicMemory(base, signal);
      if (!detected.executable || detected.executable === config.executable) throw error;
      next = { ...config, executable: detected.executable, revision: randomUUID() };
      await memorySetupService.check(next, signal);
    }
    await saveMemory(next, base, config.revision);
    return next;
  },
};
export type MemorySetupService = typeof memorySetupService;
