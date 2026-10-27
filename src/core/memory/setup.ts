import { randomUUID } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicJson } from '../sessions.js';
import { candidateMemory, loadMemory, memoryConfigPath, saveMemory, setMemoryEnabled, type MemoryConfig } from './config.js';
import { configureBasicMemory, connectBasicMemory, detectBasicMemory, installBasicMemory, validateBasicMemory } from '../../integrations/basic-memory.js';

export const memorySetupService = {
  load: loadMemory, detect: detectBasicMemory, install: installBasicMemory, toggle: setMemoryEnabled,
  async check(config: MemoryConfig, signal?: AbortSignal) {
    await validateBasicMemory(config.executable, signal);
    const backend = await connectBasicMemory(config, signal);
    const title = `pace-probe-${randomUUID()}`, identifier = `pace-setup/${title}`;
    let written = false;
    try {
      const projects = await backend.call('list_memory_projects', {}, signal) as { projects?: { name?: string }[] };
      if (!projects?.projects?.some(project => project.name === config.backendProject)) throw new Error('Configured project is unavailable; no new database was created');
      await backend.call('write_note', { title, directory: 'pace-setup', content: title, overwrite: false }, signal); written = true;
      const read = await backend.call('read_note', { identifier }, signal);
      if (!JSON.stringify(read).includes(title)) throw new Error('Temporary write was not confirmed');
    } finally {
      // Cancellation still cleans only our own known temporary record, with its own bounded request.
      if (written) await backend.call('delete_note', { identifier }).catch(error => { throw new Error(`Probe note ${identifier} remains: ${String(error)}`); });
      await backend.close();
    }
    await atomicJson(join(config.configDirectory, 'pace-health.json'), { revision: config.revision, at: new Date().toISOString(), degraded: false });
  },
  async setup(project: string, dataDirectory: string, executable: string, base: string, signal?: AbortSignal, onOutput?: (text: string) => void): Promise<MemoryConfig> {
    signal?.throwIfAborted();
    const config = await candidateMemory(project, dataDirectory, executable, base);
    const file = await memoryConfigPath(project, base);
    await atomicJson(file + '.pending', { version: 1, config, startedAt: new Date().toISOString() });
    await configureBasicMemory(config, signal, onOutput);
    await memorySetupService.check(config, signal);
    signal?.throwIfAborted();
    await saveMemory(config, base);
    await unlink(file + '.pending');
    return config;
  },
  async repair(config: MemoryConfig, base: string, signal?: AbortSignal): Promise<MemoryConfig> {
    await memorySetupService.check(config, signal);
    await saveMemory(config, base);
    return config;
  },
};
export type MemorySetupService = typeof memorySetupService;
