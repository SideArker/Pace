import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export function getGitBranch(projectPath: string): string | undefined {
  try {
    let gitPath = join(projectPath, ".git");
    if (!existsSync(gitPath)) return undefined;
    const stat = statSync(gitPath);
    if (stat.isFile()) {
      const gitDirLine = readFileSync(gitPath, "utf8").trim();
      const match = /^gitdir:\s*(.+)$/m.exec(gitDirLine);
      if (match) gitPath = resolve(projectPath, match[1]!);
    }
    const headPath = join(gitPath, "HEAD");
    if (!existsSync(headPath)) return undefined;
    const head = readFileSync(headPath, "utf8").trim();
    if (head.startsWith("ref: refs/heads/")) return head.slice(16);
    if (/^[0-9a-f]{40}$/i.test(head)) return head.slice(0, 7);
  } catch {
    // Gracefully handle any fs permission or format errors
  }
  return undefined;
}
