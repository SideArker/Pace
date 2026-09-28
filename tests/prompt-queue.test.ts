import { describe, expect, it } from "vitest";
import { PromptQueue } from "../src/core/prompt-queue.js";

describe("PromptQueue", () => {
  it("runs prompts in order within each conversation", () => {
    const queue = new PromptQueue();
    expect(queue.add("first", "one")).toBe(1);
    expect(queue.add("first", "two")).toBe(2);
    expect(queue.add("second", "other")).toBe(1);
    expect(queue.take("first")).toBe("one");
    expect(queue.take("second")).toBe("other");
    expect(queue.take("first")).toBe("two");
    expect(queue.take("first")).toBeUndefined();
  });

  it("clears pending prompts without affecting another conversation", () => {
    const queue = new PromptQueue();
    queue.add("first", "one");
    queue.add("first", "two");
    queue.add("second", "other");
    expect(queue.clear("first")).toBe(2);
    expect(queue.list("first")).toEqual([]);
    expect(queue.take("second")).toBe("other");
  });
});
