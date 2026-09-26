import { readFile, readdir, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { existingFolder } from "./folders.js";

export type Skill = { name: string; description: string; path: string };

export async function discoverSkills(input: string): Promise<Skill[]> {
  const folder = await existingFolder(input);
  const entries = await readdir(folder, { withFileTypes: true });
  const candidates = [folder, ...entries.filter(entry => entry.isDirectory()).map(entry => join(folder, entry.name))];
  const skills: Skill[] = [];
  for (const candidate of candidates.slice(0, 65)) {
    const file = join(candidate, "SKILL.md");
    let actual: string;
    try { actual = await realpath(file); } catch { continue; }
    const inside = relative(folder, actual);
    if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) continue;
    const source = await readFile(actual, "utf8");
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source)?.[1];
    if (!frontmatter) continue;
    const name = /^name:\s*(.+)$/m.exec(frontmatter)?.[1]?.trim().replace(/^['"]|['"]$/g, "") ?? basename(candidate);
    const rawDescription = /^description:\s*(.*)$/m.exec(frontmatter)?.[1]?.trim();
    const description = rawDescription === ">" || rawDescription === "|"
      ? /^description:[^\n]*\n((?:[ \t]+[^\n]*\n?)*)/m.exec(frontmatter)?.[1]?.trim().replace(/\s*\r?\n\s*/g, " ")
      : rawDescription?.replace(/^['"]|['"]$/g, "");
    if (!name || !description) continue;
    skills.push({ name: name.slice(0, 80), description: description.slice(0, 300), path: actual });
    if (skills.length === 32) break;
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export function skillPrompt(prompt: string, skills: Skill[]): string {
  if (!skills.length) return prompt;
  return `${prompt}\n\nAvailable skills from the user-selected folder (read SKILL.md before using a relevant skill):\n${skills.map(skill => `- ${skill.name}: ${skill.description} (${skill.path})`).join("\n")}`;
}
