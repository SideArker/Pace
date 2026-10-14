import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { FileEdits, type FileEditRecord } from "../core/file-edits.js";
import { changeFileHistory } from "../core/file-history.js";
import type { PaceStore } from "../core/sessions.js";
import type { Session } from "../shared/types.js";

export function FileDiffPanel({ store, session, width, height, onClose, onChange }: {
  store: PaceStore; session: Session; width: number; height: number;
  onClose: () => void; onChange: (session: Session) => void;
}) {
  const turns = [...session.turns, ...[...(session.undoneTurns ?? [])].reverse()]
    .map((turn, index) => ({ id: turn.fileEdits, label: `Turn ${index + 1}: ${turn.displayPrompt ?? turn.prompt}` }))
    .filter((turn): turn is { id: string; label: string } => !!turn.id && turn.id !== "none");
  const [turnIndex, setTurnIndex] = useState(Math.max(0, turns.length - 1));
  const selected = turns[Math.min(turnIndex, turns.length - 1)];
  const [record, setRecord] = useState<FileEditRecord>();
  const [fileIndex, setFileIndex] = useState(0);
  const [patch, setPatch] = useState("");
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const changing = useRef(false);
  const edits = useMemo(() => new FileEdits(store, session), [store, session.projectPath, session.id]);
  const file = record?.changes[fileIndex];
  const fileRows = Math.min(4, record?.changes.length ?? 0);
  const patchRows = Math.max(1, height - fileRows - 8);
  const lines = patch.split("\n");

  useEffect(() => {
    let current = true;
    setRecord(undefined); setPatch(""); setError(undefined);
    if (selected) void edits.load(selected.id).then(value => { if (current) setRecord(value); })
      .catch(error => { if (current) setError(String(error)); });
    return () => { current = false; };
  }, [edits, selected?.id, revision]);
  useEffect(() => {
    let current = true;
    setPatch(""); setOffset(0);
    if (file) void edits.diff(file).then(value => { if (current) setPatch(value); })
      .catch(error => { if (current) setError(String(error)); });
    return () => { current = false; };
  }, [edits, file]);

  const change = async (direction: "undo" | "redo") => {
    if (changing.current || !selected || !file) return;
    changing.current = true; setBusy(true); setError(undefined);
    try {
      await changeFileHistory(store, session, selected.id, direction, file.path);
      onChange(session);
      setRevision(value => value + 1);
    } catch (error) { setError(String(error)); }
    finally { changing.current = false; setBusy(false); }
  };
  useInput((input, key) => {
    if (changing.current) return;
    if (key.escape || (key.ctrl && input === "c")) { onClose(); return; }
    if (key.leftArrow || key.rightArrow) {
      setTurnIndex(value => Math.max(0, Math.min(turns.length - 1, value + (key.leftArrow ? -1 : 1))));
      setFileIndex(0); return;
    }
    if (key.upArrow || key.downArrow || key.tab) {
      const count = record?.changes.length ?? 0;
      if (count) setFileIndex(value => (value + (key.upArrow || (key.tab && key.shift) ? -1 : 1) + count) % count);
      return;
    }
    if (key.pageDown || key.pageUp) {
      setOffset(value => Math.max(0, Math.min(Math.max(0, lines.length - patchRows), value + (key.pageUp ? -patchRows : patchRows))));
      return;
    }
    if (input.toLowerCase() === "u") void change("undo");
    if (input.toLowerCase() === "r") void change("redo");
  });

  const start = Math.max(0, Math.min(fileIndex - Math.floor(fileRows / 2), (record?.changes.length ?? 0) - fileRows));
  return <Box flexDirection="column" paddingX={1} width={width} height={Math.max(8, height)} overflowY="hidden">
    <Text bold color="#A5B4FC">File changes · {selected ? `${Math.min(turnIndex + 1, turns.length)}/${turns.length}` : "0"}</Text>
    <Text dimColor wrap="truncate-end">{selected?.label.replace(/\s+/g, " ") ?? "No saved file edits. Run a new agent turn to record changes."}</Text>
    {record?.changes.slice(start, start + fileRows).map((edit, index) => <Text key={edit.path} bold={start + index === fileIndex} color={edit.undone ? "yellow" : "green"} wrap="truncate-end">
      {start + index === fileIndex ? "❯" : " "} {edit.undone ? "undone" : !edit.before ? "added" : !edit.after ? "deleted" : "modified"} {edit.path}
    </Text>)}
    <Text dimColor wrap="truncate-end">{file ? `${fileIndex + 1}/${record!.changes.length} files · lines ${Math.min(offset + 1, lines.length)}–${Math.min(offset + patchRows, lines.length)}/${lines.length}` : selected && !error ? "Loading…" : ""}</Text>
    <Box flexDirection="column" height={patchRows} overflowY="hidden">
      {lines.slice(offset, offset + patchRows).map((line, index) => <Text key={offset + index} wrap="truncate-end"
        color={line.startsWith("+") ? "green" : line.startsWith("-") ? "red" : line.startsWith("@@") ? "cyan" : undefined}>{line || " "}</Text>)}
    </Box>
    {error ? <Text color="red" wrap="truncate-end">{error}</Text> : <Text dimColor>{busy ? "Saving file history…" : " "}</Text>}
    <Text dimColor wrap="truncate-end">↑/↓ file · ←/→ turn · PgUp/PgDn scroll · U undo file · R redo file · Esc close</Text>
  </Box>;
}
