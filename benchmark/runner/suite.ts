import { join, resolve } from "node:path";
import type { Suite } from "../types.js";

export function args() {
  const values = process.argv.slice(2);
  if (values.includes("--help") || !values.length) {
    console.log(
      "Usage: npm run benchmark -- --suite <file.json> [--list] [--repeat 3] [--case id] [--include-auto] [--include-luna] [--out directory] [--timeout-minutes 12]",
    );
    process.exit(values.includes("--help") ? 0 : 2);
  }
  const get = (key: string) => {
    const index = values.indexOf(key);
    return index < 0 ? undefined : values[index + 1];
  };
  const suite = get("--suite");
  const repeat = Number(get("--repeat") ?? "1");
  const timeoutMinutes = Number(get("--timeout-minutes") ?? "12");
  if (!suite || !Number.isInteger(repeat) || repeat < 1 || repeat > 10 || !Number.isFinite(timeoutMinutes) || timeoutMinutes < 1 || timeoutMinutes > 120)
    throw new Error("Provide --suite, --repeat between 1 and 10, and --timeout-minutes between 1 and 120");
  return {
    suite: resolve(suite),
    repeat,
    timeoutMinutes,
    selectedCase: get("--case"),
    list: values.includes("--list"),
    includeAuto: values.includes('--include-auto'),
    includeLuna: values.includes('--include-luna'),
    out: resolve(
      get("--out") ??
        join(
          "benchmark",
          "results",
          new Date().toISOString().replace(/[:.]/g, "-"),
        ),
    ),
  };
}

export function parseSuite(value: unknown): Suite {
  if (!value || typeof value !== "object")
    throw new Error("Suite must be an object");
  const suite = value as Partial<Suite>;
  if (
    typeof suite.repository !== "string" ||
    !Array.isArray(suite.cases) ||
    !suite.cases.length
  )
    throw new Error("Suite needs a repository and cases");
  if (suite.ref !== undefined && typeof suite.ref !== "string")
    throw new Error("Invalid suite ref");
  const ids = new Set<string>();
  for (const task of suite.cases) {
    if (
      !task ||
      typeof task.id !== "string" ||
      !/^[a-z0-9_-]+$/.test(task.id) ||
      ids.has(task.id) ||
      typeof task.prompt !== "string" ||
      !task.prompt.trim()
    )
      throw new Error("Each case needs a unique slug id and nonempty prompt");
    if (task.ref !== undefined && typeof task.ref !== "string")
      throw new Error(`Invalid ref for ${task.id}`);
    if (task.rubric !== undefined && (typeof task.rubric !== "string" || !task.rubric.trim()))
      throw new Error(`Invalid rubric for ${task.id}`);
    for (const key of ["setup", "checks"] as const)
      if (
        task[key] !== undefined &&
        (!Array.isArray(task[key]) ||
          !task[key].every(
            (command: unknown) => typeof command === "string" && command.trim(),
          ))
      )
        throw new Error(`Invalid ${key} for ${task.id}`);
    ids.add(task.id);
  }
  return suite as Suite;
}

