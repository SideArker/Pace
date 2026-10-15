import { describe, expect, it } from "vitest";
import { planningPrompt, loadPlanningInstructions, executePlanPrompt, verifyPlanPrompt } from "../src/core/orchestrator-helpers.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getTheme, GlobalColors } from "../src/shared/colors.js";
import { newSession } from "../src/core/session-model.js";

describe("Planning helpers and theme", () => {
  it("provides planning theme palette", () => {
    const defaultTheme = getTheme("normal");
    expect(defaultTheme.primary).toBe(GlobalColors.default.primary);

    const planningTheme = getTheme("planning");
    expect(planningTheme.primary).toBe(GlobalColors.planning.primary);
    expect(planningTheme.border).toBe(GlobalColors.planning.border);
  });

  it("creates planning session with kind property", () => {
    const session = newSession("/test/project", "auto", "planning");
    expect(session.kind).toBe("planning");
    expect(session.turns).toEqual([]);
  });

  it("formats planning prompt with artifact scope and existing plan", () => {
    const prompt = planningPrompt("Add user authentication", "/project", "/artifacts/plan.md", "# Existing plan", "custom guidance");
    expect(prompt).toContain("Add user authentication");
    expect(prompt).toContain("Only /artifacts is writable");
    expect(prompt).toContain("# Existing plan");
    expect(prompt).toContain("custom guidance");
    expect(prompt).toContain("Answer questions directly in chat");
    expect(prompt).toContain("use a filesystem tool to create or edit that exact Markdown file");
    expect(prompt).toContain("Pace shows your reply unchanged");
  });

  it("seeds instructions once and reloads user edits", async () => {
    const root = await mkdtemp(join(tmpdir(), "pace-planning-instructions-"));
    const file = join(root, "planning-instructions.md");
    try {
      expect(await loadPlanningInstructions(file)).toContain("fresh agent");
      expect(await readFile(file, "utf8")).toContain("Implementation steps");
      await writeFile(file, "My custom instructions\n");
      expect(await loadPlanningInstructions(file)).toBe("My custom instructions");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("formats execution prompt with explore then implement phases", () => {
    const plan = "1. Add User model\n2. Add Auth controller";
    const prompt = executePlanPrompt(plan);
    expect(prompt).toContain("PHASE 1 (EXPLORE & GROUND)");
    expect(prompt).toContain("PHASE 2 (IMPLEMENT & VERIFY)");
    expect(prompt).toContain("cannot access that conversation");
    expect(prompt).toContain("acceptance criteria");
    expect(prompt).toContain(plan);
  });

  it("formats verification prompt with review instructions", () => {
    const plan = "Draft plan";
    const prompt = verifyPlanPrompt(plan, "User goal", "Check migration risks");
    expect(prompt).toContain("User goal");
    expect(prompt).toContain("Check migration risks");
    expect(prompt).toContain("Draft plan");
    expect(prompt).toContain("Work read-only; do not implement or edit code");
    expect(prompt).toContain("Do not edit or save the plan");
  });
  it("reads an existing plan file or returns undefined", async () => {
    const { tryReadPlanFile } = await import("../src/core/orchestrator-helpers.js");
    const result = tryReadPlanFile("package.json", process.cwd());
    expect(result).toBeDefined();
    expect(result?.content).toContain("pace");

    const missing = tryReadPlanFile("non-existent-plan-file-12345.md", process.cwd());
    expect(missing).toBeUndefined();
  });
});
