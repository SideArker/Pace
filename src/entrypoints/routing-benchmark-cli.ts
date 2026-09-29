import { resolve, join } from "node:path";

export function benchmarkArgs(argv: string[]) {
  if (argv.includes("--help") || !argv.length) {
    console.log(
      "Usage: npm run benchmark:routing -- --suite benchmark/suites/routing-suite.json [--repeat 3] [--case id] [--shape-only] [--out directory]",
    );
    process.exit(argv.includes("--help") ? 0 : 2);
  }
  const get = (key: string) => {
    const index = argv.indexOf(key);
    return index < 0 ? undefined : argv[index + 1];
  };
  const repeat = Number(get("--repeat") ?? "3");
  if (!get("--suite") || !Number.isInteger(repeat) || repeat < 1 || repeat > 20)
    throw new Error("Provide --suite and --repeat between 1 and 20");
  return {
    suite: resolve(get("--suite")!),
    repeat,
    selectedCase: get("--case"),
    shapeOnly: argv.includes("--shape-only"),
    out: resolve(
      get("--out") ??
        join(
          "benchmark",
          "results",
          `routing-${new Date().toISOString().replace(/[:.]/g, "-")}`,
        ),
    ),
  };
}
