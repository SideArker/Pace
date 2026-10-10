import type { PaceStore } from "../core/sessions.js";
import type { Session } from "../shared/types.js";

export async function loadResumeChoices(
  store: Pick<PaceStore, "listProjects">,
  openSessions: Session[],
  runningSessions: Session[],
): Promise<{ sessions: Session[]; missingProjectPaths: string[] }> {
  const projects = await store.listProjects();
  const sessions = new Map<string, Session>();
  for (const session of openSessions) sessions.set(session.id, session);
  for (const project of projects) {
    for (const session of project.sessions) if (!sessions.has(session.id)) sessions.set(session.id, session);
  }
  for (const session of runningSessions) sessions.set(session.id, session);
  return {
    sessions: [...sessions.values()],
    missingProjectPaths: projects.filter(project => !project.exists).map(project => project.projectPath),
  };
}
