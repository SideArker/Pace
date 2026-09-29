import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "./routing-benchmark-runner.js";
export { parseRoutingSuite } from "./routing-suite.js";
export { summarizeRouting } from "./routing-summary.js";
export type { RoutingCase, RoutingRun, RoutingSuite } from "./routing-types.js";

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)))
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });