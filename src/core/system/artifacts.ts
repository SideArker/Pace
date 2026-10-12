import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const artifactDirectory = (project: string) => join(project, ".pace", "artifacts");

export async function savePlanArtifact(project: string, sessionId: string, request: string, plan: string, existing?: string): Promise<string> {
  const slug = request.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48).replace(/-$/, "") || "implementation";
  const name = /^\.pace\/artifacts\/([^/\\]+\.pace-plan\.md)$/.exec(existing ?? "")?.[1]
    ?? `${slug}-${sessionId.slice(0, 8)}.pace-plan.md`;
  await mkdir(artifactDirectory(project), { recursive: true });
  await writeFile(join(artifactDirectory(project), name), `${plan.trim()}\n`, "utf8");
  return `.pace/artifacts/${name}`;
}

/** A small workspace convention for Codex, only when the user mentions artifacts. */
export function artifactPrompt(prompt: string): string {
  if (!/\bartifacts?\b/i.test(prompt)) return prompt;
  return `Pace artifact convention: Markdown artifacts are persistent project notes in .pace/artifacts/. When asked to create or update an artifact, write a descriptive .md file there, read existing artifacts there when relevant, and include its relative path in your final response. Keep the user's request authoritative.\n\nUser request:\n${prompt}`;
}

export async function artifactSnapshot(project: string): Promise<Map<string, number>> {
  const path = artifactDirectory(project);
  let entries;
  try { entries = await readdir(path, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw error;
  }
  const files = await Promise.all(entries.filter(entry => entry.isFile() && entry.name.endsWith(".md"))
    .map(async entry => [entry.name, (await stat(join(path, entry.name))).mtimeMs] as const));
  return new Map(files);
}

export function changedArtifacts(before: Map<string, number>, after: Map<string, number>): string[] {
  return [...after].filter(([name, time]) => before.get(name) !== time).map(([name]) => `.pace/artifacts/${name}`).sort();
}
