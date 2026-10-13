import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PaceStore } from "../sessions.js";
import type { Session } from "../../shared/types.js";

export const artifactDirectory = (store: PaceStore, session: Session) => join(store.conversationDir(session.projectPath, session.id), "artifacts");
export const legacyArtifactDirectory = (project: string) => join(project, ".pace", "artifacts");

export function artifactPath(store: PaceStore, session: Session, reference: string): string {
  if (/^artifacts\/[^/\\]+\.md$/.test(reference)) return join(store.conversationDir(session.projectPath, session.id), reference);
  if (/^\.pace\/artifacts\/[^/\\]+\.md$/.test(reference)) return join(session.projectPath, reference);
  return reference;
}

export function planArtifactReference(sessionId: string, request: string, existing?: string, separate = false): string {
  if (!separate && /^artifacts\/[^/\\]+\.pace-plan\.md$/.test(existing ?? "")) return existing!;
  const slug = request.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48).replace(/-$/, "") || "implementation";
  return `artifacts/${slug}-${sessionId.slice(0, 8)}${separate ? `-${Date.now()}` : ""}.pace-plan.md`;
}

export async function savePlanArtifact(directory: string, sessionId: string, request: string, plan: string, existing?: string): Promise<string> {
  const reference = planArtifactReference(sessionId, request, existing);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, reference.slice("artifacts/".length)), `${plan.trim()}\n`, "utf8");
  return reference;
}

/** A small workspace convention for Codex, only when the user mentions artifacts. */
export function artifactPrompt(prompt: string, directory?: string): string {
  if (!/\bartifacts?\b/i.test(prompt) && !/artefakt/i.test(prompt)) return prompt;
  if (!directory) return prompt;
  return `Pace artifact storage for this conversation: ${directory}. When asked to create or update an artifact, write a descriptive Markdown file there, read existing artifacts there when relevant, and include its absolute path in your final response. Keep the user's request authoritative.\n\nUser request:\n${prompt}`;
}

export async function artifactSnapshot(directory: string): Promise<Map<string, number>> {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw error;
  }
  const files = await Promise.all(entries.filter(entry => entry.isFile() && entry.name.endsWith(".md"))
    .map(async entry => [entry.name, (await stat(join(directory, entry.name))).mtimeMs] as const));
  return new Map(files);
}

export function changedArtifacts(before: Map<string, number>, after: Map<string, number>): string[] {
  return [...after].filter(([name, time]) => before.get(name) !== time).map(([name]) => `artifacts/${name}`).sort();
}
