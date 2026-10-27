import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { hash } from "./storage.js";

export async function verifyFrozenSources(sources: Record<string, string>, root: string): Promise<void> {
  for (const [path, digest] of Object.entries(sources)) {
    if (hash(await readFile(join(root, path))) !== digest) throw new Error(`Frozen source changed: ${path}`);
  }
}
