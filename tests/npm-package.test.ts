import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

it("includes the default routing prompts in the npm package", () => {
  const result = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  const packed = JSON.parse(result) as Record<string, { files: { path: string }[] }>;
  const pack = Object.values(packed)[0];
  expect(pack?.files.map(file => file.path)).toContain("routing-prompts.default.json");
});
