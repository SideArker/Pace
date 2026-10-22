import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const command = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const sourcePaths = [
  "src", "benchmark", "skills", "package.json", "package-lock.json", "routing-prompts.default.json", "versions.json",
  ...(basename(fileURLToPath(new URL("../", import.meta.url))) === "dist" ? ["dist"] : []),
];
export const baselineBuildPaths = ["dist", "skills", "package.json", "package-lock.json", "routing-prompts.default.json", "versions.json"];

/** Hash file names and bytes, including dirty and new sources; exclude run artifacts. */
export async function fingerprintSources(root = repositoryRoot, paths: readonly string[] = sourcePaths) {
  const files = new Set<string>();
  const visit = async (path: string): Promise<void> => {
    const normalized = path.split(sep).join("/");
    if (normalized === "benchmark/results" || normalized === "benchmark/reports") return;
    if ((await stat(resolve(root, path))).isDirectory()) {
      await Promise.all((await readdir(resolve(root, path))).map(name => visit(join(path, name))));
    } else files.add(normalized);
  };
  await Promise.all(paths.map(visit));
  const sourceHashes = Object.fromEntries(await Promise.all([...files].sort().map(async path => [
    path, createHash("sha256").update(await readFile(resolve(root, path))).digest("hex"),
  ] as const)));
  return { sourceHashes, sourceSha256: createHash("sha256").update(JSON.stringify(sourceHashes)).digest("hex") };
}

export async function benchmarkProvenance(root = repositoryRoot, paths?: readonly string[]) {
  const [fingerprint, revision, status] = await Promise.all([
    fingerprintSources(root, paths),
    command("git", ["rev-parse", "HEAD"], { cwd: root }),
    command("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: root }),
  ]);
  return { ...fingerprint, commit: revision.stdout.trim(), dirty: status.stdout.length > 0, nodeVersion: process.version };
}
