import type { Config, Route, Session } from '../types.js';
import type { CodexRunner, Progress } from '../integrations/codex.js';
import { askJev } from '../integrations/jev.js';
import { selectRoute } from './router.js';
import { PaceStore } from './sessions.js';
export type TurnOutcome = { session: Session; result: string; note: string };
export class Orchestrator {
  constructor(readonly store: PaceStore, readonly runner: CodexRunner, readonly jev: typeof askJev = askJev) {}
  async turn(prompt: string, session: Session, config: Config, onProgress: (progress: Progress) => void, signal?: AbortSignal): Promise<TurnOutcome> {
    const save = async () => { try { await this.store.save(session); } catch (error) { onProgress({ kind: 'error', text: `Pace session was not saved: ${String(error)}` }); } };
    let route: Route; let note: string;
    if (session.threadId) {
      route = session.route;
      note = 'Continuing Codex thread with its saved route';
    } else {
      let suggestion: unknown;
      if (session.routingMode === 'auto' && config.models.length >= 2) {
        onProgress({ kind: 'status', text: 'Routing…' });
        try { suggestion = await this.jev(prompt, config.models); }
        catch (error) { onProgress({ kind: 'error', text: `Jev unavailable: ${String(error)}` }); }
      }
      const selected = selectRoute({ ...config, routingMode: session.routingMode }, suggestion, session.routingMode === 'manual' ? session.route.model ? session.route : undefined : undefined);
      route = selected.route;
      note = selected.note;
      if (session.routingMode === 'auto' && config.models.length < 2) note = 'Auto needs two configured models; using configured default';
      session.route = route;
      await save();
    }
    onProgress({ kind: 'status', text: `${note}: ${route.model ?? 'Codex default'}${route.effort ? ` · ${route.effort}` : ''}` });
    try {
      const execution = await this.runner.run(prompt, session.projectPath, route, session.threadId, async progress => {
        if (progress.kind === 'thread') { session.threadId = progress.text; await save(); }
        else onProgress(progress);
      }, signal);
      if (execution.threadId) session.threadId = execution.threadId;
      session.turns = [...session.turns, { prompt: prompt.slice(0, 180), result: execution.result.slice(0, 500), at: new Date().toISOString() }].slice(-20);
      await save();
      return { session, result: execution.result, note };
    } catch (error) {
      session.turns = [...session.turns, { prompt: prompt.slice(0, 180), result: String(error).slice(0, 500), at: new Date().toISOString(), failed: true }].slice(-20);
      await save();
      throw error;
    }
  }
}
