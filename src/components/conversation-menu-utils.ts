import { basename, join } from "node:path";
import { existsSync } from "node:fs";
import type { Session } from "../shared/types.js";

export type ConversationChoice = {
  id: string;
  kind?: Session["kind"];
  projectPath?: string;
  section?: "pace" | "saved";
  sectionTitle?: string;
  sectionKey?: string;
  title?: string;
  prompt: string;
  state: "ready" | "running" | "approval" | "question" | "done";
  updatedAt?: string;
};

export function resolveRepoTitle(
  projectPath: string,
  allProjectPaths: string[] = [],
): { title: string; isRepo: boolean } {
  const isGit = existsSync(join(projectPath, ".git"));
  const base = basename(projectPath);
  const duplicates = allProjectPaths.filter(
    (p) => p !== projectPath && basename(p) === base,
  );
  if (duplicates.length > 0) {
    return { title: projectPath, isRepo: isGit };
  }
  return { title: base, isRepo: isGit };
}

export function sortConversations<T extends { state: "ready" | "running" | "approval" | "question" | "done"; updatedAt?: string }>(
  items: T[],
): T[] {
  const getRank = (state: string): number => {
    if (state === "running") return 1;
    if (state === "approval" || state === "question") return 2;
    return 3; // done | ready
  };

  return [...items].sort((a, b) => {
    const rankA = getRank(a.state);
    const rankB = getRank(b.state);
    if (rankA !== rankB) return rankA - rankB;

    const timeA = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
    const timeB = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
    return timeB - timeA;
  });
}

export function sectionConversations<T extends { id: string; projectPath?: string; state: "ready" | "running" | "approval" | "question" | "done"; updatedAt?: string }>(
  items: T[],
  thisPaceIds: ReadonlySet<string>,
  currentProjectPath?: string,
): (T & { section: "pace" | "saved"; sectionTitle: string; sectionKey: string })[] {
  const current = sortConversations(items.filter(item => thisPaceIds.has(item.id)));

  const allProjectPaths = Array.from(
    new Set(items.map(item => item.projectPath).filter((p): p is string => Boolean(p))),
  );

  const savedItems = items.filter(item => !thisPaceIds.has(item.id));
  const savedGroups = new Map<string, T[]>();
  for (const item of savedItems) {
    const key = item.projectPath ?? item.id;
    savedGroups.set(key, [...(savedGroups.get(key) ?? []), item]);
  }

  // Sort groups: currentProjectPath first (if present in savedGroups), then by newest updatedAt
  const sortedGroupKeys = [...savedGroups.keys()].sort((keyA, keyB) => {
    const isCurrentA = currentProjectPath && keyA === currentProjectPath;
    const isCurrentB = currentProjectPath && keyB === currentProjectPath;
    if (isCurrentA && !isCurrentB) return -1;
    if (!isCurrentA && isCurrentB) return 1;

    const groupA = savedGroups.get(keyA)!;
    const groupB = savedGroups.get(keyB)!;
    const maxTimeA = groupA.reduce((max, i) => (i.updatedAt && i.updatedAt > max ? i.updatedAt : max), "");
    const maxTimeB = groupB.reduce((max, i) => (i.updatedAt && i.updatedAt > max ? i.updatedAt : max), "");
    return maxTimeB.localeCompare(maxTimeA);
  });

  const saved: (T & { section: "pace" | "saved"; sectionTitle: string; sectionKey: string })[] = [];
  for (const key of sortedGroupKeys) {
    const group = sortConversations(savedGroups.get(key)!);
    const firstItem = group[0];
    const resolved = firstItem?.projectPath
      ? resolveRepoTitle(firstItem.projectPath, allProjectPaths).title
      : "Saved conversations";
    for (const item of group) {
      saved.push({
        ...item,
        section: "saved" as const,
        sectionTitle: resolved,
        sectionKey: key,
      });
    }
  }

  return [
    ...current.map(item => ({
      ...item,
      section: "pace" as const,
      sectionTitle: "This pace",
      sectionKey: "pace",
    })),
    ...saved,
  ];
}

export function menuWindow(length: number, selectedIndex: number, size = 5): { start: number; end: number } {
  const start = Math.max(0, Math.min(selectedIndex - Math.floor(size / 2), length - size));
  return { start, end: Math.min(start + size, length) };
}

export function truncateWithEllipsis(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}
