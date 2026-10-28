import { randomUUID } from 'node:crypto';
import { prepareTurnPrompt, prepareRunnerPrompt } from '../core/orchestrator-prompts.js';
import { DEFAULT_ROUTING_PROMPTS } from '../core/routing/routing-prompts.js';
import { PaceStore, newSession } from '../core/sessions.js';
import { durableRunner, ensureTask } from '../core/task-execution.js';
import type { CodexRunner, Progress } from '../integrations/codex-types.js';
import type { Route } from '../shared/types.js';

/** Fixed-route experiment using the production prompt, attempt, recall and capture paths. */
export async function runMemoryAgent({ prompt, workspace, baseDir, route, runner, signal, memory, progress = () => {} }: {
  prompt: string; workspace: string; baseDir: string; route: Route; runner: CodexRunner; signal?: AbortSignal; memory: boolean; progress?: (event: Progress) => void;
}) {
  const store = new PaceStore(baseDir), session = newSession(workspace, 'manual'); session.route = route;
  session.activeTask = { id: randomUUID(), originalRequest: prompt.slice(0, 8000), instructions: [] }; ensureTask(session, 'single', 'user');
  await store.save(session, false);
  const prepared = prepareTurnPrompt({ prompt, session, taskRelation: 'replace', priorTask: undefined, usedThreadForClarification: false, prompts: DEFAULT_ROUTING_PROMPTS, skills: [] });
  const { runnerPrompt, runThreadId } = prepareRunnerPrompt({ executionPrompt: prepared.promptWithHandoff, session, verifierTurn: false, planningTurn: false, skills: [] });
  let attemptId: string | undefined;
  const execution = await durableRunner(runner, store, session, 'main', 'final', false, undefined, id => { attemptId = id; }).run(
    runnerPrompt, workspace, route, runThreadId, event => { if (event.kind === 'approval') event.respond('decline'); else if (event.kind === 'question') event.respond({}); else progress(event); }, signal, 'main', [], 'request-approval', undefined, { recallQuery: prompt, disabled: !memory });
  session.threadId = execution.threadId;
  session.turns.push({ prompt, result: execution.result, at: new Date().toISOString(), route, memoryAttemptId: attemptId, usage: execution.usage });
  await store.saveChanges(session, false);
  return { execution, session, prompt: runnerPrompt };
}
