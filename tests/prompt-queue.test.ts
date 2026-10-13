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

  it("supports inspecting, editing, removing, and popping queued prompts", () => {
    const queue = new PromptQueue();
    queue.add("sess", "prompt 1");
    queue.add("sess", "prompt 2");
    queue.add("sess", "prompt 3");

    expect(queue.get("sess", 1)).toBe("prompt 2");
    expect(queue.set("sess", 1, "prompt 2 edited")).toBe(true);
    expect(queue.get("sess", 1)).toBe("prompt 2 edited");

    expect(queue.pop("sess")).toBe("prompt 3");
    expect(queue.list("sess")).toEqual(["prompt 1", "prompt 2 edited"]);

    expect(queue.remove("sess", 0)).toBe("prompt 1");
    expect(queue.list("sess")).toEqual(["prompt 2 edited"]);

    expect(queue.remove("sess", 5)).toBeUndefined();
    expect(queue.set("sess", 5, "nope")).toBe(false);
  });

  it("reports each queue change and restores saved prompts without rewriting them", () => {
    const changes: string[][] = [];
    const queue = new PromptQueue((_id, prompts) => changes.push([...prompts]));
    queue.restore("sess", ["one"]);
    expect(changes).toEqual([]);
    queue.add("sess", "two");
    queue.set("sess", 0, "edited");
    queue.take("sess");
    queue.clear("sess");
    expect(changes).toEqual([["one", "two"], ["edited", "two"], ["two"], []]);
  });
});
