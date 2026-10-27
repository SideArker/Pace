export * from "../src/benchmark/drivers/thread-switch.js";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../src/benchmark/drivers/thread-switch.js";
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const driver = process.argv.includes("--study") ? (await import("../src/benchmark/drivers/context-models.js")).main : main;
  await driver(process.argv.slice(2)).catch(error => { console.error(error); process.exitCode = 1; });
}
