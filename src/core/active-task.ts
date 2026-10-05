import type { Session } from "../shared/types.js";

type ActiveTask = NonNullable<Session["activeTask"]>;
export type TaskRelation = "continue" | "replace" | "aside";

const excerpt = (value: string, limit: number) => value.trim().slice(0, limit);

export function retainedTask(session: Session): ActiveTask | undefined {
  if (session.activeTask) return session.activeTask;
  if (session.checkpoint?.note.unfinished.length) {
    return {
      originalRequest: excerpt(session.checkpoint.note.goal, 8000),
      instructions: session.checkpoint.note.unfinished.map(item => excerpt(item, 4000)).slice(-12),
    };
  }
  // The first retained turn is reliable only when the session has not reached its 20-turn cap.
  const first = session.turns.length < 20 ? session.turns[0] : undefined;
  if (!first || first.failed || first.routeNote === "Vex requested clarification") return undefined;
  const last = [...session.turns].reverse().find(turn => turn.routeNote !== "Vex requested clarification") ?? first;
  return {
    originalRequest: excerpt(first.prompt, 8000),
    instructions: [],
    latestOutcome: excerpt(last.result, 2000),
    failed: !!last.failed,
  };
}

export function advanceTask(
  current: ActiveTask | undefined,
  relation: TaskRelation,
  prompt: string,
  result: string,
  failed: boolean,
): ActiveTask | undefined {
  if (relation === "aside") return current;
  if (relation === "replace" || !current) {
    return { originalRequest: excerpt(prompt, 8000), instructions: [], latestOutcome: excerpt(result, 2000), failed };
  }
  return {
    originalRequest: current.originalRequest,
    instructions: current.instructions.at(-1) === excerpt(prompt, 4000)
      ? current.instructions : [...current.instructions, excerpt(prompt, 4000)].slice(-12),
    latestOutcome: excerpt(result, 2000),
    failed,
  };
}
