import type { PaceStore } from '../sessions.js';
import type { Session } from '../../shared/types.js';
import { MemoryAccess, boundedText, finishMemoryAttempt } from './access.js';
import { loadMemory, MEMORY_POLICY } from './config.js';

export async function captureCheckpoint(store: PaceStore, session: Session, signal?: AbortSignal): Promise<void> {
  const checkpoint = session.checkpoint;
  if (!checkpoint) return;
  const turn = session.turns.find(turn => turn.at === checkpoint.sourceTurnAt);
  const attempt = session.attempts?.find(attempt => attempt.id === turn?.memoryAttemptId && attempt.role === 'main' && attempt.status === 'completed');
  if (!attempt) return;
  const config = (await loadMemory(session.projectPath, store.baseDir)).config;
  if (!config?.enabled || attempt.memoryProvenance?.projectId !== config.id) return;
  const scope = { config, baseDir: store.baseDir, sessionId: session.id, taskId: attempt.taskId, attemptId: attempt.id, role: 'main' as const, startedAt: attempt.startedAt, projectPath: session.projectPath, branch: attempt.memoryProvenance.branch, commit: attempt.memoryProvenance.commit };
  const access = new MemoryAccess(scope, undefined, signal);
  try {
    await access.remember({ key: `checkpoint:${checkpoint.sourceTurnAt}`, type: 'observation',
      content: boundedText(`Historical validated checkpoint, ${checkpoint.createdAt}. Reported findings (recheck current code):\n${checkpoint.note.findings.slice(0, 3).map(item => `${item.file ?? ''}: ${item.detail}`).join('\n')}\nRisks: ${checkpoint.note.risks.slice(0, 2).join('; ')}`, MEMORY_POLICY.captureBytes),
      files: checkpoint.note.findings.flatMap(item => item.file ? [item.file] : []).slice(0, 10) });
    await finishMemoryAttempt(scope, true);
  } finally { await access.close(); }
}
