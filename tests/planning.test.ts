import { describe, expect, it } from "vitest";
import { planningPrompt, executePlanPrompt, verifyPlanPrompt } from "../src/core/orchestrator-helpers.js";
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

  it("formats planning prompt with read-only instructions", () => {
    const prompt = planningPrompt("Add user authentication");
    expect(prompt).toContain("Add user authentication");
    expect(prompt).toContain("read-only planning mode");
    expect(prompt).toContain("Do NOT edit or write code files");
  });

  it("formats execution prompt with explore then implement phases", () => {
    const plan = "1. Add User model\n2. Add Auth controller";
    const prompt = executePlanPrompt(plan);
    expect(prompt).toContain("PHASE 1 (EXPLORE & GROUND)");
    expect(prompt).toContain("PHASE 2 (IMPLEMENT & VERIFY)");
    expect(prompt).toContain(plan);
  });

  it("formats verification prompt with review instructions", () => {
    const plan = "Draft plan";
    const prompt = verifyPlanPrompt(plan, "User goal");
    expect(prompt).toContain("User goal");
    expect(prompt).toContain("Draft plan");
    expect(prompt).toContain("Work read-only; do not implement or edit code");
  });
});
