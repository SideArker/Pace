export type PastedBlock = { start: number; end: number; lines: number };

export function insertDraftText(value: string, cursor: number, text: string, blocks: PastedBlock[]) {
  const length = text.length;
  return {
    value: value.slice(0, cursor) + text + value.slice(cursor),
    cursor: cursor + length,
    blocks: blocks.map(block => block.start >= cursor
      ? { ...block, start: block.start + length, end: block.end + length }
      : block),
  };
}

export function insertPastedBlock(value: string, cursor: number, text: string, blocks: PastedBlock[]) {
  const next = insertDraftText(value, cursor, text, blocks);
  const lines = text.split("\n").length;
  if (lines < 10) return next;
  return { ...next, blocks: [...next.blocks, { start: cursor, end: cursor + text.length, lines }]
    .sort((a, b) => a.start - b.start) };
}

export function deleteDraftRange(value: string, start: number, end: number, blocks: PastedBlock[]) {
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const block of blocks) {
      if (start < block.end && end > block.start && (start > block.start || end < block.end)) {
        start = Math.min(start, block.start);
        end = Math.max(end, block.end);
        expanded = true;
      }
    }
  }
  const length = end - start;
  return {
    value: value.slice(0, start) + value.slice(end),
    cursor: start,
    blocks: blocks.filter(block => block.end <= start || block.start >= end).map(block => block.start >= end
      ? { ...block, start: block.start - length, end: block.end - length }
      : block),
  };
}

export function skipPastedBlock(cursor: number, direction: "left" | "right", blocks: PastedBlock[]): number {
  const block = blocks.find(item => cursor > item.start && cursor < item.end);
  return block ? direction === "left" ? block.start : block.end : cursor;
}

export function displayPastedBlocks(value: string, cursor: number, blocks: PastedBlock[]) {
  let display = "";
  let rawIndex = 0;
  let displayCursor = cursor;
  const markers: { start: number; end: number }[] = [];
  for (const block of blocks) {
    display += value.slice(rawIndex, block.start);
    const marker = `[Pasted ${block.lines} line${block.lines === 1 ? "" : "s"}]`;
    const start = display.length;
    display += marker;
    markers.push({ start, end: display.length });
    if (cursor >= block.end) displayCursor += marker.length - (block.end - block.start);
    else if (cursor > block.start) displayCursor = start;
    rawIndex = block.end;
  }
  display += value.slice(rawIndex);
  return { value: display, cursor: displayCursor, markers };
}

export function verticalCursor(value: string, cursor: number, direction: "up" | "down"): number | undefined {
  const lineStart = value.lastIndexOf("\n", cursor - 1) + 1;
  const column = cursor - lineStart;
  if (direction === "up") {
    if (lineStart === 0) return undefined;
    const end = lineStart - 1;
    const start = value.lastIndexOf("\n", end - 1) + 1;
    return Math.min(start + column, end);
  }
  const breakAt = value.indexOf("\n", cursor);
  if (breakAt < 0) return undefined;
  const start = breakAt + 1;
  const nextBreak = value.indexOf("\n", start);
  return Math.min(start + column, nextBreak < 0 ? value.length : nextBreak);
}

export function isNewlineKey(input: string, key: { return: boolean; shift: boolean; ctrl: boolean; meta: boolean }): boolean {
  return (key.return && (key.shift || key.ctrl || key.meta)) || (key.ctrl && input === "j") || input === "\n"
    || /^\[(?:27;2;13|13;2)~$/.test(input);
}

export function deleteWordForward(value: string, cursor: number): { value: string; cursor: number } {
  if (cursor >= value.length) return { value, cursor };
  const after = value.slice(cursor);
  const match = /^(\s*[\p{L}\p{N}_]+|\s*[^\s\p{L}\p{N}_]+|\s+)/u.exec(after);
  const count = match ? match[0].length : 1;
  return {
    value: value.slice(0, cursor) + value.slice(cursor + count),
    cursor,
  };
}

export function deleteWordBackward(value: string, cursor: number): { value: string; cursor: number } {
  if (cursor <= 0) return { value, cursor: 0 };
  const before = value.slice(0, cursor);
  const match = /([\p{L}\p{N}_]+\s*|[^\s\p{L}\p{N}_]+\s*|\s+)$/u.exec(before);
  const count = match ? match[0].length : 1;
  const newCursor = Math.max(0, cursor - count);
  return {
    value: value.slice(0, newCursor) + value.slice(cursor),
    cursor: newCursor,
  };
}

export function isAltDeleteKey(input: string, key: { delete?: boolean; meta?: boolean; ctrl?: boolean }): boolean {
  return !!((key.delete && (key.meta || key.ctrl))
    || input === "\x1b[3;3~" || input === "\x1b\x1b[3~" || input === "\x1b[3;5~" || (key.meta && input === "d"));
}

export function isAltBackspaceKey(input: string, key: { backspace?: boolean; meta?: boolean; ctrl?: boolean }): boolean {
  return !!((key.backspace && (key.meta || key.ctrl))
    || input === "\x1b\x7f" || input === "\x1b\b" || (key.ctrl && input === "w"));
}

export function isSteerShortcut(input: string, key: { meta?: boolean; ctrl?: boolean }): boolean {
  return !!(
    (key.meta && input.toLowerCase() === "m") ||
    (key.ctrl && input.toLowerCase() === "m") ||
    input === "\x1bm" ||
    input === "\x1bM" ||
    input === "\x1b[109;3u" ||
    input === "\x1b[109;5u" ||
    input === "µ"
  );
}

