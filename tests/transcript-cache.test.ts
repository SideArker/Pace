import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PaceStore, newSession } from "../src/core/sessions.js";
import { TranscriptLineCache } from "../src/components/transcript-cache.js";
import { linesFromSession } from "../src/components/session-transcript.js";
import type { Line } from "../src/components/Transcript.js";

let directory: string;
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

const line = (id: number): Line[] => [{ id, role: "info", text: `line ${id}`, spaceBefore: false }];

it("evicts least recently used completed transcripts but keeps active and running sessions", () => {
  const cache = new TranscriptLineCache(2);
  cache.set("active", line(1), "active");
  cache.set("running", line(2), "active", ["running"]);
  cache.set("older", line(3), "active", ["running"]);
  expect(cache.size).toBe(3);
  expect(cache.has("active")).toBe(true);
  expect(cache.has("running")).toBe(true);
  cache.set("newer", line(4), "active", ["running"]);
  expect(cache.has("older")).toBe(false);
  cache.retain("active");
  expect(cache.size).toBe(2);
  expect(cache.has("running")).toBe(false);
  expect(cache.get("newer")?.[0]?.text).toBe("line 4");
});

it("restores an evicted conversation from saved turns after background completion", async () => {
  directory = await mkdtemp(join(tmpdir(), "pace-transcript-cache-"));
  const store = new PaceStore(join(directory, "storage"));
  const project = join(directory, "project");
  const completed = newSession(project, "manual");
  completed.turns = [{
    prompt: "Inspect code", result: "Found issue", at: "2026-10-13T12:00:00Z",
    activities: [{ category: "command", text: "Ran: build", detail: "success", durationMs: 900 }],
    artifacts: ["artifacts/report.md"],
  }];
  await store.save(completed);
  const cache = new TranscriptLineCache(1);
  cache.set(completed.id, line(1), "other", [completed.id]);
  cache.set("other", line(2), "other", [completed.id]);
  expect(cache.has(completed.id)).toBe(true);
  cache.retain("other");
  expect(cache.has(completed.id)).toBe(false);

  const loaded = await store.load(project, completed.id);
  expect(loaded).toBeDefined();
  const { lines, nextId } = linesFromSession(loaded!, 10, reference => `/${reference}`);
  cache.set(completed.id, lines, completed.id);
  expect(cache.has("other")).toBe(false);
  expect(cache.get(completed.id)).toEqual(lines);
  expect(lines.map(item => item.role)).toEqual(["you", "activity", "codex", "meta", "artifact", "divider"]);
  expect(lines.find(item => item.role === "codex")?.text).toBe("Found issue");
  expect(lines.find(item => item.role === "artifact")?.text).toBe("/artifacts/report.md");
  expect(nextId).toBe(16);
});
