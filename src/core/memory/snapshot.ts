import { z } from 'zod';
import { exportMemory, memoryRecordSchema, memoryTransaction, noteText } from './access.js';
import { MEMORY_POLICY, BASIC_MEMORY_VERSION, type MemoryConfig } from './config.js';
import { connectBasicMemory } from '../../integrations/basic-memory.js';
import { PaceStore } from '../sessions.js';
import { parseSession } from '../session-record.js';
import type { Session } from '../../shared/types.js';
import { createHash } from 'node:crypto';

export const snapshotSchema = z.object({ version: z.literal(1), backendVersion: z.literal(BASIC_MEMORY_VERSION), policy: z.unknown(),
  records: z.array(memoryRecordSchema).max(1000), sources: z.array(z.unknown()).max(1000), preparation: z.object({ model: z.string(), effort: z.string(), usage: z.unknown(), costUsd: z.number().nonnegative().nullable(), durationMs: z.number().nonnegative(), knownModelSubtotalUsd: z.number().nonnegative().optional() }) });
export type MemorySnapshot = z.infer<typeof snapshotSchema>;
export async function freezeMemory(config: MemoryConfig, store: PaceStore, preparation: MemorySnapshot['preparation']): Promise<MemorySnapshot> {
  const records = (await exportMemory(config)).records;
  if (records.some(record => record.status === 'pending')) throw new Error('Cannot freeze pending memory writes');
  const sources: Session[] = [];
  for (const id of new Set(records.map(record => record.source.sessionId))) {
    const sourcePath = records.find(record => record.source.sessionId === id)!.source.projectPath ?? config.canonicalPath;
    const session = await store.load(sourcePath, id);
    if (!session) throw new Error(`Cannot freeze missing source ${id}`);
    sources.push(session);
  }
  const snapshot = snapshotSchema.parse({ version: 1, backendVersion: BASIC_MEMORY_VERSION, policy: MEMORY_POLICY, records, sources, preparation });
  validateSources(snapshot, sources);
  return snapshot;
}
function validateSources(snapshot: MemorySnapshot, sources: Session[]) {
  if (new Set(snapshot.records.map(record => record.id)).size !== snapshot.records.length || new Set(sources.map(source => source.id)).size !== sources.length) throw new Error('Duplicate frozen memory identity');
  for (const record of snapshot.records) {
    const source = sources.find(source => source.id === record.source.sessionId);
    if (record.status === 'pending' || !source?.attempts?.some(attempt => attempt.id === record.source.attemptId && attempt.role === 'main' && attempt.status === 'completed')) throw new Error('Frozen note has no completed main source');
    if (record.status === 'active' && source.memoryRetractedAttempts?.includes(record.source.attemptId)) throw new Error('Frozen active note has a retracted source');
    if ([...record.relations, ...record.supersedes].some(id => !snapshot.records.some(target => target.id === id))) throw new Error('Frozen relation has no source record');
  }
}
export async function importMemory(snapshotInput: unknown, config: MemoryConfig, store: PaceStore, signal?: AbortSignal): Promise<void> {
  const snapshot = snapshotSchema.parse(snapshotInput);
  if (JSON.stringify(snapshot.policy) !== JSON.stringify(MEMORY_POLICY)) throw new Error('Frozen memory policy differs from production policy');
  if ((await exportMemory(config)).records.length) throw new Error('Import requires a fresh Pace memory namespace');
  const sources: Session[] = [];
  for (const input of snapshot.sources) {
    if (!input || typeof input !== 'object' || !('projectPath' in input) || typeof input.projectPath !== 'string') throw new Error('Invalid memory source');
    const source = parseSession(input, input.projectPath);
    if (!source || source.attempts?.some(attempt => ['running', 'awaiting_user'].includes(attempt.status))) throw new Error('Cannot import an invalid or live source session');
    sources.push(source);
  }
  validateSources(snapshot, sources);
  const backend = await connectBasicMemory(config, signal);
  try {
    await memoryTransaction(config, async ledger => {
      for (const original of snapshot.records) {
        signal?.throwIfAborted();
        const record = { ...original, projectId: config.id, source: { ...original.source, projectPath: config.canonicalPath } };
        const content = `# ${record.id}\n\n${record.content}\n\n## Original provenance\n${JSON.stringify(original.source)}\n\n## Relations\n${record.relations.map(id => `- relates_to [[pace/${id}]]`).join('\n')}\n`;
        await backend.call('write_note', { title: record.id, directory: 'pace', content, note_type: record.type, overwrite: false, metadata: { pace_id: record.id, pace_project_id: config.id, original_project_id: original.projectId, source: original.source } }, signal);
        const confirmed = noteText(await backend.call('read_note', { identifier: `pace/${record.id}` }, signal));
        if (!confirmed.includes(record.id) || !confirmed.includes(record.content)) throw new Error('Imported memory write was not confirmed');
        record.backendHash = createHash('sha256').update(confirmed).digest('hex');
        ledger.records.push(record);
      }
    });
    for (const source of sources) {
      // Preserve original source IDs; only the explicitly imported namespace/path changes.
      const imported = { ...source, projectPath: config.canonicalPath, revision: undefined };
      await store.save(imported, false);
    }
  } finally { await backend.close(); }
}
