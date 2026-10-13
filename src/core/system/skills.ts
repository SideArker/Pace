import { readFile, readdir, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import type { Config, Session } from "../../shared/types.js";
import { existingFolder } from "./folders.js";

export type Skill = { name: string; description: string; path: string };

export const defaultSkillFolder = () => join(homedir(), ".agents", "skills");
const bundledSkillFolder = () => fileURLToPath(new URL("../../../skills/", import.meta.url));

export async function configuredSkills(config: Config): Promise<Skill[]> {
  if (config.skillFolder === null) return [];
  const bundled = await discoverSkills(bundledSkillFolder());
  try {
    const local = await discoverSkills(config.skillFolder ?? defaultSkillFolder());
    return [...local, ...bundled.filter(skill => !local.some(item => item.name.toLowerCase() === skill.name.toLowerCase()))];
  } catch (error) {
    if (config.skillFolder === undefined && (error as NodeJS.ErrnoException).code === "ENOENT") return bundled;
    throw error;
  }
}

export const enabledSkills = (skills: Skill[], config: Config) =>
  skills.filter(skill => !config.disabledSkills?.includes(skill.name));

export const validSkillName = (name: string): boolean => /^[a-z0-9][a-z0-9_-]*$/i.test(name);

export function updateAutoLaunchSkills(session: Session, name?: string, toggle = false): string[] {
  const current = session.autoLaunchSkills ?? [];
  session.autoLaunchSkills = name === undefined ? []
    : current.includes(name) ? (toggle ? current.filter(item => item !== name) : current)
    : [...current, name];
  if (session.threadId) session.autoLaunchThreadId = session.threadId;
  return session.autoLaunchSkills;
}

export function autoLaunchPrompt(prompt: string, selected: Skill[]): string {
  if (!selected.length) return prompt;
  return `ON-LAUNCH skills for this new Codex thread: ${selected.map(skill => `${skill.name} (${skill.path})`).join(", ")}. Read each SKILL.md and follow its instructions for this thread.\n\n${prompt}`;
}

export function skillCommand(prompt: string, skills: Skill[]): Skill | undefined {
  const command = /^\/([^\s]+)(?:\s|$)/.exec(prompt)?.[1]?.toLowerCase();
  return skills.find(skill => skill.name.toLowerCase() === command && validSkillName(skill.name));
}

export function skillMention(prompt: string, skills: Skill[]): Skill | undefined {
  for (const match of prompt.matchAll(/(?:^|\s)@([a-z0-9][a-z0-9_-]*)(?=\s|$)/gi)) {
    const skill = skills.find(candidate => candidate.name.toLowerCase() === match[1]!.toLowerCase());
    if (skill) return skill;
  }
  return undefined;
}

export function skillRequest(prompt: string, skill: Skill): string {
  return prompt.slice(skill.name.length + 1).trim();
}

export function skillOption(skill: Skill, request: string): string | undefined {
  return skill.name === "caveman" && /^(?:lite|full|ultra|wenyan-lite|wenyan-full|wenyan-ultra)$/.test(request)
    ? request : undefined;
}

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

export function skillPrompt(prompt: string, skills: Skill[], activeSkills: string[] = [], skillOptions: Record<string, string> = {}): string {
  if (!skills.length) return prompt;
  const slashSkill = skillCommand(prompt, skills);
  const invoked = slashSkill ?? skillMention(prompt, skills);
  const request = slashSkill ? skillRequest(prompt, slashSkill) : prompt;
  const active = skills.filter(skill => activeSkills.includes(skill.name) || skill.name === invoked?.name);
  const instruction = active.length
    ? `Skills for this turn: ${active.map(skill => `/${skill.name}${skillOptions[skill.name] ? ` ${skillOptions[skill.name]}` : ""} (${skill.path})`).join(", ")}. Read each SKILL.md and follow its instructions.`
    : "No skills are active for this conversation.";
  return `${request}\n\n${instruction} Previous slash-command activations not listed here no longer apply. The user's request is the text above.\n\nAvailable skills (read SKILL.md before using a relevant skill):\n${skills.map(skill => `- ${skill.name}: ${skill.description} (${skill.path})`).join("\n")}`;
}
