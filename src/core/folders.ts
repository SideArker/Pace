import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";

export async function existingFolder(input: string): Promise<string> {
  const path = await realpath(resolve(input));
  if (!(await stat(path)).isDirectory()) throw new Error(`Not a folder: ${input}`);
  return path;
}

export function sameFolder(a: string, b: string): boolean {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}
