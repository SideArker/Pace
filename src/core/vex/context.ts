// Bound the serialized context, including JSON escaping and UTF-8 expansion.
const MAX_CONTEXT_BYTES = 24_000;
const OMISSION = "\n[Text omitted from Vex context; full record retained in Pace session.]\n";

function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const remaining = limit - OMISSION.length;
  const head = Math.ceil(remaining / 2);
  return text.slice(0, head) + OMISSION + text.slice(-(remaining - head));
}

function compact(value: unknown, textLimit: number, itemLimit: number, depth = 0): unknown {
  if (typeof value === "string") return clip(value, textLimit);
  if (value === null || typeof value !== "object") return value;
  if (depth >= 8) return clip(JSON.stringify(value), textLimit);
  if (Array.isArray(value)) {
    const selected = value.length <= itemLimit ? value : [
      ...value.slice(0, Math.ceil(itemLimit / 2)),
      { omittedItems: value.length - itemLimit },
      ...(Math.floor(itemLimit / 2) ? value.slice(-Math.floor(itemLimit / 2)) : []),
    ];
    return selected.map(item => compact(item, textLimit, itemLimit, depth + 1));
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, compact(item, textLimit, itemLimit, depth + 1)]));
}

/** A projection for decisions; never mutates or replaces the persisted evidence. */
export function boundedContext(context: Record<string, unknown>): Record<string, unknown> {
  const serialized = JSON.stringify(context);
  const originalBytes = Buffer.byteLength(serialized);
  if (originalBytes <= MAX_CONTEXT_BYTES) return context;
  const projection = {
    truncated: true, originalBytes, maxBytes: MAX_CONTEXT_BYTES,
    notice: "Text or items are omitted. Full evidence remains in the saved Pace session. Omitted material does not establish completion.",
  };
  for (let textLimit = 1600, itemLimit = 16; textLimit >= 100; textLimit = Math.floor(textLimit / 2), itemLimit = Math.max(1, Math.floor(itemLimit / 2))) {
    const projected = { ...compact(context, textLimit, itemLimit) as Record<string, unknown>, projection };
    if (Buffer.byteLength(JSON.stringify(projected)) <= MAX_CONTEXT_BYTES) return projected;
  }
  // Pathological object/key counts still have a fixed ceiling. Each UTF-16 unit
  // takes at most six bytes after JSON escaping.
  return { projection, excerpt: clip(serialized, 3200) };
}

export const PROJECTION_CONSTRAINT = "Context may contain a projection.truncated flag and omission markers. Do not infer success or full coverage from omitted material. Choose unknown for a completion assessment when required evidence is omitted; technical execution status alone does not establish completion.";
