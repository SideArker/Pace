import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { FileEdits, fileTurnActive, type ConversationEdits, type ConversationFileEdit } from "../core/file-edits.js";
import { reviewFileHistory, undoFileReview } from "../core/file-history.js";
import type { PaceStore } from "../core/sessions.js";
import type { Session } from "../shared/types.js";
import { GlobalColors, getTheme } from "../shared/colors.js";
import { Composer } from "./Composer.js";

type Decision = "accepted" | "rejected";
type DiffRow = { text: string; oldLine?: number; newLine?: number; kind: "addition" | "deletion" | "context" | "hunk" | "meta" };

export function parseDiffRows(patch: string): DiffRow[] {
  let oldLine = 0, newLine = 0, inHunk = false;
  return patch.split("\n").map(text => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) {
      oldLine = Number(hunk[1]); newLine = Number(hunk[2]); inHunk = true;
      return { text, kind: "hunk" };
    }
    if (inHunk) {
      if (text.startsWith("+")) return { text, newLine: newLine++, kind: "addition" };
      if (text.startsWith("-")) return { text, oldLine: oldLine++, kind: "deletion" };
      if (text.startsWith(" ")) return { text, oldLine: oldLine++, newLine: newLine++, kind: "context" };
    }
    return { text, kind: "meta" };
  });
}

function status(edit: ConversationFileEdit) {
  return edit.previousPath ? "Moved" : !edit.before ? "Created" : !edit.after ? "Deleted" : "Modified";
}

export function FileDiffPanel({ store, session, width, height, onClose, onChange, isActive, onComment, onBusyChange }: {
  store: PaceStore; session: Session; width: number; height: number;
  onClose: () => void; onChange: (session: Session) => void;
  isActive: () => boolean; onComment: (text: string) => Promise<void>;
  onBusyChange?: (busy: boolean) => void;
}) {
  const theme = getTheme(session.kind);
  const statusColors = { Created: theme.success, Deleted: theme.error, Moved: GlobalColors.default.primary, Modified: theme.warning };
  const snapshotIds = JSON.stringify(session.turns.map(turn => turn.fileEdits).filter(id => id && id !== "none"));
  const [record, setRecord] = useState<ConversationEdits>();
  const [fileIndex, setFileIndex] = useState(0);
  const [loadedPatch, setLoadedPatch] = useState<{ key: string; rows: DiffRow[] }>();
  const [offset, setOffset] = useState(0);
  const [lineIndex, setLineIndex] = useState(0);
  const [diffFocused, setDiffFocused] = useState(false);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<Decision>();
  const [commentTarget, setCommentTarget] = useState<{ label: string; snippet?: string }>();
  const commenting = !!commentTarget;
  const [comment, setComment] = useState("");
  const [notice, setNotice] = useState("");
  const changing = useRef(false);
  const selectedPath = useRef<string | undefined>(undefined);
  const edits = useMemo(() => new FileEdits(store, session), [store, session.projectPath, session.id]);
  const file = record?.changes[fileIndex];
  selectedPath.current = file?.path;
  const patchKey = JSON.stringify(file && [file.path, file.previousPath, file.before, file.after]) ?? "";
  const rows = loadedPatch?.key === patchKey ? loadedPatch.rows : [];
  const numberedRows = useMemo(() => rows.flatMap((row, index) => row.oldLine !== undefined || row.newLine !== undefined ? [index] : []), [rows]);
  const digits = Math.max(3, String(rows.reduce((max, row) => Math.max(max, row.oldLine ?? 0, row.newLine ?? 0), 0)).length);
  const patchRows = Math.max(1, height - 10 - (commenting ? 3 : 0));
  const active = isActive() || fileTurnActive(session.projectPath);
  const locked = () => isActive() || fileTurnActive(session.projectPath) || !!record?.overlapped;
  const captureWarning = record && !record.changes.length && snapshotIds === "[]" && !active
    ? session.turns.flatMap(turn => turn.systemMessages ?? []).filter(message => message.startsWith("File undo unavailable:")).at(-1)
    : undefined;

  useEffect(() => {
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setError(undefined); setConfirmation(undefined);
    const refresh = async () => {
      try {
        const value = await edits.conversation(session);
        if (current) {
          setRecord(previous => JSON.stringify(previous) === JSON.stringify(value) ? previous : value);
          const selectedIndex = value.changes.findIndex(edit => edit.path === selectedPath.current);
          setFileIndex(index => selectedIndex >= 0 ? selectedIndex : Math.max(0, Math.min(index, value.changes.length - 1)));
        }
      } catch (error) { if (current) setError(String(error)); }
      finally { if (current && active) timer = setTimeout(() => { void refresh(); }, 2000); }
    };
    void refresh();
    return () => { current = false; clearTimeout(timer); };
  }, [edits, snapshotIds, revision, active]);
  useEffect(() => {
    let current = true;
    setOffset(0);
    if (file) void edits.diff(file).then(value => {
      if (!current) return;
      const rows = parseDiffRows(value);
      setLoadedPatch({ key: patchKey, rows });
      const changed = rows.findIndex(row => row.kind === "addition" || row.kind === "deletion");
      setLineIndex(Math.max(0, changed >= 0 ? changed : rows.findIndex(row => row.oldLine !== undefined || row.newLine !== undefined)));
    }).catch(error => { if (current) setError(String(error)); });
    return () => { current = false; };
  }, [edits, patchKey]);

  const change = async (decision: Decision | "undo", wholeConversation = false) => {
    if (changing.current) return;
    if (locked()) { setError(record?.overlapped ? "Overlapping conversations: browsing and comments only." : "Wait for running work in this project before reviewing files."); setConfirmation(undefined); return; }
    if (decision === "undo" ? !session.lastFileReview : !file) return;
    changing.current = true; setBusy(true); onBusyChange?.(true); setError(undefined); setConfirmation(undefined);
    try {
      if (decision === "undo") await undoFileReview(store, session);
      else await reviewFileHistory(store, session, decision, wholeConversation ? undefined : file!.path);
      onChange(session);
      setDiffFocused(false);
      setNotice(decision === "undo" ? "Last review decision undone." : `${wholeConversation ? "Conversation changes" : file!.path} ${decision}.`);
      setRevision(value => value + 1);
    } catch (error) { setError(String(error)); }
    finally { changing.current = false; setBusy(false); onBusyChange?.(false); }
  };
  const selectLine = (index: number) => {
    setLineIndex(index);
    setOffset(value => index < value ? index : index >= value + patchRows ? Math.max(0, index - patchRows + 1) : value);
  };
  const focusDiff = () => {
    if (!file || loadedPatch?.key !== patchKey) return;
    setDiffFocused(true);
    const selected = lineIndex >= offset && lineIndex < offset + patchRows ? lineIndex
      : numberedRows.find(index => index >= offset) ?? numberedRows.at(-1) ?? 0;
    selectLine(selected);
  };
  const startComment = () => {
    setError(undefined);
    if (file && loadedPatch?.key !== patchKey) { setNotice("Wait for the diff to load."); return; }
    if (file && numberedRows.length && !diffFocused) {
      focusDiff(); setNotice("Select a line with ↑/↓, then c or Enter to comment."); return;
    }
    const row = diffFocused ? rows[lineIndex] : undefined;
    const numbered = row && (row.oldLine !== undefined || row.newLine !== undefined);
    const label = file ? `Review comment for conversation, file ${file.path}${file.previousPath ? `, moved from ${file.previousPath}` : ""}${numbered && row.oldLine !== undefined ? `, old line ${row.oldLine}` : ""}${numbered && row.newLine !== undefined ? `, new line ${row.newLine}` : ""}` : "Review comment";
    setCommentTarget({ label, snippet: numbered ? row.text : undefined });
    setError(undefined);
  };
  const sendComment = async (text: string) => {
    if (changing.current || !text.trim() || !commentTarget) return;
    changing.current = true; setBusy(true); setError(undefined);
    try {
      await onComment(`${commentTarget.label}:\n${commentTarget.snippet === undefined ? "" : `Code: ${commentTarget.snippet}\n\n`}${text.trim()}`);
      setComment(""); setCommentTarget(undefined); setNotice("Comment sent to the agent.");
    } catch (error) { setError(String(error)); }
    finally { changing.current = false; setBusy(false); }
  };
  useInput((input, key) => {
    if (changing.current) return;
    if (commenting) {
      if (key.escape) setCommentTarget(undefined);
      return;
    }
    if (key.rightArrow) { onClose(); return; }
    if (confirmation) {
      if (key.escape || input.toLowerCase() === "n") setConfirmation(undefined);
      else if (input.toLowerCase() === "y") void change(confirmation, true);
      return;
    }
    if (key.escape || (key.ctrl && input === "c")) { onClose(); return; }
    if (diffFocused && (key.leftArrow || key.tab)) { setDiffFocused(false); return; }
    if (!diffFocused && (key.return || input === " ")) { focusDiff(); return; }
    if (diffFocused && key.return) { startComment(); return; }
    if (key.upArrow || key.downArrow || key.tab || key.pageDown || key.pageUp || (diffFocused && input === " ")) {
      const page = key.pageDown || key.pageUp || input === " ";
      const direction = key.upArrow || key.pageUp || (key.tab && key.shift) ? -1 : 1;
      if (diffFocused && numberedRows.length) {
        const position = Math.max(0, numberedRows.indexOf(lineIndex));
        const next = Math.max(0, Math.min(numberedRows.length - 1, position + direction * (page ? patchRows : 1)));
        selectLine(numberedRows[next]!);
      } else if (page || diffFocused) {
        setOffset(value => Math.max(0, Math.min(Math.max(0, rows.length - patchRows), value + direction * (page ? patchRows : 1))));
      } else {
        const count = record?.changes.length ?? 0;
        if (count) setFileIndex(value => (value + direction + count) % count);
      }
      return;
    }
    if (key.ctrl || key.meta) return;
    if (input.toLowerCase() === "c") { startComment(); return; }
    if (input.toLowerCase() === "u") { void change("undo"); return; }
    if (input.toLowerCase() === "a" || input.toLowerCase() === "r") {
      const decision = input.toLowerCase() === "a" ? "accepted" : "rejected";
      if ((key.shift || input === input.toUpperCase()) && file && !locked()) setConfirmation(decision);
      else void change(decision);
    }
  });

  const start = Math.max(0, Math.min(fileIndex - Math.floor(patchRows / 2), (record?.changes.length ?? 0) - patchRows));
  const sidebarWidth = Math.max(1, Math.floor((width - 2) * 0.18));
  const row = rows[lineIndex];
  return <Box flexDirection="column" paddingX={1} width={width} height={Math.max(8, height)} overflowY="hidden">
    <Text bold color={theme.primary}>File review · Conversation changes</Text>
    <Text color={record?.overlapped ? theme.warning : theme.muted} wrap="truncate-end">{!record ? "Loading conversation changes…" : record.overlapped ? "Workspace changes · overlapping conversations; attribution unavailable." : record.changes.length ? "All file changes in this conversation so far." : snapshotIds === "[]" && !active ? "No saved file edits. Run a new agent turn to record changes." : "No file changes in this conversation."}</Text>
    <Text color={theme.muted} wrap="truncate-end">{file ? <>{fileIndex + 1}/{record!.changes.length} files · {file.previousPath ? `${file.previousPath} → ${file.path}` : file.path} · <Text color={statusColors[status(file)]}>{status(file)}</Text>{diffFocused && row ? ` · ${row.oldLine === undefined ? "" : `old ${row.oldLine}`}${row.oldLine !== undefined && row.newLine !== undefined ? " / " : ""}${row.newLine === undefined ? "" : `new ${row.newLine}`}` : ""}</> : !record && !error ? "Loading…" : " "}</Text>
    <Box flexDirection="row" height={patchRows + 1} flexShrink={0}>
      <Box flexDirection="column" width={sidebarWidth} flexShrink={0} paddingRight={1} overflowY="hidden"
        borderStyle="single" borderTop={false} borderBottom={false} borderLeft={false} borderColor={diffFocused ? theme.border : theme.primary}>
        <Text bold color={diffFocused ? theme.muted : theme.primary}>Files</Text>
        {record?.changes.slice(start, start + patchRows).map((edit, index) => <Text key={edit.path} bold={start + index === fileIndex}
          color={statusColors[status(edit)]} backgroundColor={!diffFocused && start + index === fileIndex ? theme.badgeBg : undefined} wrap="truncate-middle">
          {start + index === fileIndex ? "❯" : " "} {edit.path}
        </Text>)}
      </Box>
      <Box flexDirection="column" width={Math.max(1, width - 2 - sidebarWidth)} flexShrink={0} paddingLeft={1} overflowY="hidden">
        <Text bold color={diffFocused ? theme.primary : theme.muted}>  {"Old".padStart(digits)} {"New".padStart(digits)} │ Diff</Text>
        {rows.slice(offset, offset + patchRows).map((line, index) => {
          const selected = diffFocused && offset + index === lineIndex;
          return <Text key={offset + index} backgroundColor={selected ? theme.badgeBg : undefined} wrap="truncate-end">
            <Text color={selected ? theme.primary : theme.dim}>{selected ? "❯" : " "} {String(line.oldLine ?? "").padStart(digits)} {String(line.newLine ?? "").padStart(digits)} │ </Text>
            <Text color={line.kind === "addition" ? theme.success : line.kind === "deletion" ? theme.error : line.kind === "hunk" ? theme.accent : line.kind === "meta" ? theme.muted : undefined}>{line.text || " "}</Text>
          </Text>;
        })}
      </Box>
    </Box>
    {commenting ? <Box flexDirection="column" height={3}>
      <Text color={theme.accent} wrap="truncate-end">Comment to agent · {commentTarget.label.replace("Review comment for conversation, ", "")}{commentTarget.snippet === undefined ? "" : ` · ${commentTarget.snippet}`}</Text>
      <Composer value={comment} onChange={setComment} onSubmit={text => { void sendComment(text); }} history={[]} disabled={busy}
        shellMode={false} placeholder="Comment on this line" onComplete={() => {}} width={width - 2} maxRows={2} />
    </Box> : null}
    {confirmation ? <Text color={theme.warning}>{confirmation === "accepted" ? "Accept" : "Reject"} all {record?.changes.length} files in this conversation? Y confirm · N/Esc cancel</Text>
      : error ? <Text color={theme.error} wrap="truncate-end">{error}</Text> : captureWarning ? <Text color={theme.warning} wrap="truncate-end">{captureWarning}</Text> : <Text color={theme.muted} wrap="truncate-end">{busy ? "Saving…" : notice || " "}</Text>}
    <Text color={theme.muted} wrap="truncate-end">{commenting ? "Enter send · Esc back · Shift+Enter newline" : record?.overlapped ? "Overlapping conversations · Accept/Reject/Undo disabled" : locked() ? "Agent working · Accept/Reject/Undo disabled" : "a accept file · r reject file · u undo · Shift+A/R all"}</Text>
    <Text color={theme.muted} wrap="truncate-end">{diffFocused ? "↑/↓ line · c/Enter comment · ← files · →/Esc chat" : "↑/↓ file · Enter/Space diff · c comment · →/Esc chat"}</Text>
    <Text wrap="truncate-end"><Text color={statusColors.Created}>Created</Text> · <Text color={statusColors.Deleted}>Deleted</Text> · <Text color={statusColors.Moved}>Moved</Text> · <Text color={statusColors.Modified}>Modified</Text><Text color={theme.muted}> · PgUp/PgDn scroll</Text></Text>
  </Box>;
}
