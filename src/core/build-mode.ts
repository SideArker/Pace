import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** npm installs Pace under node_modules/@sidearker/pace; checkout builds do not. */
export function isNpmInstalledBuild(modulePath: string): boolean {
  const parts = resolve(modulePath).split(/[\\/]+/).map(part => part.toLowerCase());
  return parts.some((part, index) =>
    part === "node_modules" && parts[index + 1] === "@sidearker" && parts[index + 2] === "pace",
  );
}

export const isDebugBuild = !isNpmInstalledBuild(fileURLToPath(import.meta.url));
