export * from "../src/benchmark/drivers/context-models-probe.js";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../src/benchmark/drivers/context-models-probe.js";
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const driver = main;
  await driver(process.argv.slice(2)).catch(error => { console.error(error); process.exitCode = 1; });
}
