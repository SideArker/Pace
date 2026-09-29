import type { TurnSummary } from "../shared/types.js";
import type { RoutingCase, RoutingRun } from "./routing-types.js";

export function turnsFor(item: RoutingCase): TurnSummary[] {
  return (item.conversation ?? []).map((turn, index) => ({
    prompt: turn.user,
    result: turn.assistant,
    at: new Date(index * 1000).toISOString(),
  }));
}

export function summarizeRouting(runs: RoutingRun[]) {
  const completed = runs.filter((run) => !!run.shape && !run.error);
  const counts = (items: string[]) =>
    Object.fromEntries(
      [...new Set(items)]
        .sort()
        .map((item) => [item, items.filter((value) => value === item).length]),
    );
  const categories = [...new Set(runs.map((run) => run.category))]
    .sort()
    .map((category) => {
      const group = runs.filter((run) => run.category === category);
      return {
        category,
        total: group.length,
        completed: group.filter((run) => !!run.shape && !run.error).length,
        acceptable: group.filter((run) => !run.error && run.acceptableHit)
          .length,
        preferred: group.filter((run) => !run.error && run.preferredHit).length,
        selected: counts(
          group
            .map((run) => run.shape)
            .filter((shape): shape is string => !!shape),
        ),
      };
    });
  const byCase = [...new Set(runs.map((run) => run.id))].sort().map((id) => {
    const group = runs.filter((run) => run.id === id);
    return {
      id,
      selected: counts(
        group
          .map((run) => run.shape)
          .filter((shape): shape is string => !!shape),
      ),
      acceptable: group.filter((run) => !run.error && run.acceptableHit).length,
      preferred: group.filter((run) => !run.error && run.preferredHit).length,
      failures: group.filter((run) => !!run.error).length,
    };
  });
  return {
    total: runs.length,
    completed: completed.length,
    errors: runs.length - completed.length,
    acceptable: completed.filter((run) => run.acceptableHit).length,
    preferred: completed.filter((run) => run.preferredHit).length,
    selectedShapes: counts(completed.map((run) => run.shape!)),
    categories,
    byCase,
    vexCalls: runs.reduce((sum, run) => sum + run.vexCalls, 0),
    retries: runs.reduce((sum, run) => sum + run.retries, 0),
    elapsedMs: runs.reduce((sum, run) => sum + run.elapsedMs, 0),
  };
}
