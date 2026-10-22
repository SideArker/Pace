import { isDeepStrictEqual } from "node:util";
import { isRecord } from "../shared/config.js";

export const keyedRecords = new Set(["attempts", "sideAnswers", "controlDecisions"]);

export class SessionConflictError extends Error {
  constructor(readonly field: string) {
    super(`Session changed concurrently (${field}); reload and reapply the intended change`);
    this.name = "SessionConflictError";
  }
}

function turnBranch(base: unknown[], branch: unknown[]): { turns: Map<string, Record<string, unknown>>; additions: Record<string, unknown>[]; dropped: number } | undefined {
  const indexed = (items: unknown[]) => {
    const byAt = new Map<string, Record<string, unknown>>();
    for (const item of items) {
      if (!isRecord(item) || typeof item.at !== "string" || byAt.has(item.at)) return undefined;
      byAt.set(item.at, item);
    }
    return byAt;
  };
  const before = indexed(base), after = indexed(branch);
  if (!before || !after) return undefined;
  const retained = branch.filter(item => isRecord(item) && typeof item.at === "string" && before.has(item.at));
  const additions = [...after.values()].filter(item => !before.has(item.at as string));
  const dropped = base.length - retained.length;
  // Only the rolling history window may remove turns during a merge. Explicit
  // undo/deletion remains incompatible with concurrent history changes.
  if (dropped < 0 || (dropped > 0 && (additions.length === 0 || branch.length !== 20))) return undefined;
  const expectedRetained = base.slice(dropped);
  if (retained.length !== expectedRetained.length || retained.some((item, index) =>
    !isRecord(item) || !isRecord(expectedRetained[index]) || item.at !== expectedRetained[index]!.at)) return undefined;
  const firstAddition = branch.findIndex(item => isRecord(item) && typeof item.at === "string" && !before.has(item.at));
  if (firstAddition >= 0 && branch.slice(firstAddition).some(item => !isRecord(item) || typeof item.at !== "string" || before.has(item.at))) return undefined;
  return { turns: after, additions, dropped };
}

/** Apply only the caller's changes; concurrent edits to the same value fail closed. */
export function reapplyChanges(base: unknown, desired: unknown, latest: unknown, field: string): unknown {
  if (isDeepStrictEqual(base, desired)) return structuredClone(latest);
  if (isDeepStrictEqual(base, latest) || isDeepStrictEqual(desired, latest)) return structuredClone(desired);
  if (field === "turns" && Array.isArray(base) && Array.isArray(desired) && Array.isArray(latest)) {
    const desiredBranch = turnBranch(base, desired), latestBranch = turnBranch(base, latest);
    if (desiredBranch && latestBranch) {
      const retained = base.slice(Math.max(desiredBranch.dropped, latestBranch.dropped)).map(item => {
        const at = (item as { at: string }).at;
        return reapplyChanges(item, desiredBranch.turns.get(at), latestBranch.turns.get(at), `turns.${at}`);
      });
      const additions = new Map<string, unknown>();
      for (const item of [...latestBranch.additions, ...desiredBranch.additions]) {
        const at = (item as { at: string }).at;
        const existing = additions.get(at);
        additions.set(at, existing
          ? reapplyChanges({}, item, existing, `turns.${at}`)
          : structuredClone(item));
      }
      return [...retained, ...[...additions.values()].sort((a, b) =>
        (a as { at: string }).at.localeCompare((b as { at: string }).at))].slice(-20);
    }
  }
  if (keyedRecords.has(field) && (base === undefined || Array.isArray(base)) &&
      Array.isArray(desired) && Array.isArray(latest)) {
    const records = (items: unknown[]): Map<string, unknown> => {
      const result = new Map<string, unknown>();
      for (const item of items) {
        if (!isRecord(item) || typeof item.id !== "string" || result.has(item.id)) throw new SessionConflictError(field);
        result.set(item.id, item);
      }
      return result;
    };
    const before = records(base ?? []), after = records(desired), current = records(latest);
    for (const id of new Set([...before.keys(), ...after.keys()])) {
      if (isDeepStrictEqual(before.get(id), after.get(id))) continue;
      if (!isDeepStrictEqual(before.get(id), current.get(id)) && !isDeepStrictEqual(after.get(id), current.get(id)))
        throw new SessionConflictError(`${field}.${id}`);
      if (after.has(id)) current.set(id, structuredClone(after.get(id)));
      else current.delete(id);
    }
    return [...current.values()];
  }
  if (isRecord(base) && isRecord(desired) && isRecord(latest)) {
    const result = { ...latest };
    const keys = new Set([...Object.keys(base), ...Object.keys(desired)]);
    for (const key of keys) {
      const value = reapplyChanges(base[key], desired[key], latest[key], field ? `${field}.${key}` : key);
      if (value === undefined) delete result[key];
      else result[key] = value;
    }
    // Recursive branches already own their copies; clone only disk-only keys.
    for (const key of Object.keys(latest)) if (!keys.has(key)) result[key] = structuredClone(latest[key]);
    return result;
  }
  throw new SessionConflictError(field);
}
