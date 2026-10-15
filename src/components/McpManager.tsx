import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { TextInput } from "@inkjs/ui";
import { executeMcpCommand, readMcpServers, type McpServerConfig } from "../integrations/codex-cli.js";

type Service = { list: typeof readMcpServers; run: typeof executeMcpCommand };
const nativeService: Service = { list: readMcpServers, run: executeMcpCommand };
type Screen = "list" | "actions" | "name" | "transport" | "command" | "argument" | "environment" | "url" | "bearer" | "review" | "remove";
type NewServer = { name: string; transport: "stdio" | "streamable_http"; command: string; args: string[]; environment: string[]; url: string; bearer: string };
const emptyServer = (): NewServer => ({ name: "", transport: "stdio", command: "", args: [], environment: [], url: "", bearer: "" });
const fields: Partial<Record<Screen, string>> = {
  name: "Server name", command: "Executable (without arguments)", argument: "Next argument (Enter empty to finish)",
  environment: "Environment variable: NAME=value (Enter empty to finish)", url: "Server URL", bearer: "Bearer token environment variable (optional)",
};

export function McpManager({ project, width, height, onClose, service = nativeService }: {
  project: string; width: number; height: number; onClose: () => void; service?: Service;
}) {
  const [servers, setServers] = useState<McpServerConfig[]>([]);
  const [screen, setScreen] = useState<Screen>("list");
  const [index, setIndex] = useState(0);
  const [selected, setSelected] = useState<McpServerConfig>();
  const [server, setServer] = useState(emptyServer);
  const [draft, setDraft] = useState("");
  const [fieldRevision, setFieldRevision] = useState(0);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [output, setOutput] = useState("");
  const mounted = useRef(false);
  const operation = useRef<AbortController | undefined>(undefined);

  const perform = async (args?: string[]) => {
    if (operation.current) return;
    let controller = new AbortController();
    operation.current = controller;
    const current = () => mounted.current && operation.current === controller;
    setBusy(args ? `${args[0]} ${args[1]}…` : "Loading servers…");
    setScreen("list"); setIndex(0); setError(""); setMessage(""); setOutput("");
    try {
      if (args) {
        await service.run(args, project, { signal: controller.signal, onOutput: text => {
          if (current()) setOutput(value => (value + text).slice(-16_384));
        } });
        if (current()) setMessage("Saved. Server changes apply to the next turn; active turns keep their connections.");
      } else {
        const listed = await service.list(project, controller.signal);
        if (current()) setServers(listed);
      }
    } catch (failure) {
      if (current()) setError(controller.signal.aborted ? "MCP operation cancelled." : String(failure));
    } finally {
      // Native add can save configuration before an OAuth failure or cancellation.
      if (args && current()) {
        controller = new AbortController(); operation.current = controller;
        try {
          const listed = await service.list(project, controller.signal);
          if (current()) setServers(listed);
        } catch (failure) { if (current()) setError(value => [value, `Could not refresh servers: ${String(failure)}`].filter(Boolean).join("\n")); }
      }
      if (current()) { operation.current = undefined; setBusy(""); }
    }
  };
  useEffect(() => {
    mounted.current = true;
    void perform();
    return () => { mounted.current = false; const pending = operation.current; operation.current = undefined; pending?.abort(); };
  }, [project, service]);

  const go = (next: Screen) => { setScreen(next); setIndex(0); setDraft(""); setError(""); setFieldRevision(value => value + 1); };
  const addArgs = () => server.transport === "stdio"
    ? ["add", server.name, ...server.environment.flatMap(value => ["--env", value]), "--", server.command, ...server.args]
    : ["add", server.name, "--url", server.url, ...(server.bearer ? ["--bearer-token-env-var", server.bearer] : [])];
  const submit = (raw: string) => {
    const value = raw.trim();
    if (screen === "name") {
      if (!/^[a-zA-Z0-9_-]+$/.test(value)) { setError("Use letters, numbers, hyphens, or underscores for the server name."); return; }
      if (servers.some(item => item.name === value)) { setError("That server already exists. Choose a different name."); return; }
      setServer(previous => ({ ...previous, name: value })); go("transport");
    } else if (screen === "command") {
      if (!value) { setError("Enter an executable, such as node or npx."); return; }
      setServer(previous => ({ ...previous, command: value })); go("argument");
    } else if (screen === "argument") {
      if (!raw) { go("environment"); return; }
      setServer(previous => ({ ...previous, args: [...previous.args, raw] })); go("argument");
    } else if (screen === "environment") {
      if (!raw) { go("review"); return; }
      if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(raw)) { setError("Use NAME=value for an environment variable."); return; }
      setServer(previous => ({ ...previous, environment: [...previous.environment, raw] })); go("environment");
    } else if (screen === "url") {
      try { if (!["http:", "https:"].includes(new URL(value).protocol)) throw new Error(); }
      catch { setError("Enter a valid http:// or https:// URL."); return; }
      setServer(previous => ({ ...previous, url: value })); go("bearer");
    } else if (screen === "bearer") {
      if (value && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) { setError("Enter the environment variable name, not the token value."); return; }
      setServer(previous => ({ ...previous, bearer: value })); go("review");
    }
  };
  const actions = selected?.transport.type === "streamable_http"
    ? ["Log in with OAuth", "Log out", "Remove server", "Back"] : ["Remove server", "Back"];
  const choices = screen === "list" ? [...servers.map(item => `${item.name} · ${item.transport.type === "stdio" ? "stdio" : "HTTP"} · ${item.enabled ? "enabled" : "disabled"}${item.authStatus ? ` · ${item.authStatus}` : ""}`), "Add server", "Refresh", "Close"]
    : screen === "actions" ? actions
    : screen === "transport" ? ["Local command (stdio)", "Remote URL (HTTP)"]
    : screen === "review" ? ["Save server", "Cancel"]
    : screen === "remove" ? ["Keep server", "Remove server"] : [];
  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === "c")) {
      if (operation.current) operation.current.abort();
      else if (screen !== "list") go("list");
      else onClose();
      return;
    }
    if (busy || !choices.length) return;
    if (key.upArrow || key.downArrow || key.tab) {
      setIndex(value => (value + (key.upArrow || key.shift ? -1 : 1) + choices.length) % choices.length);
    } else if (key.return) {
      if (screen === "list") {
        if (index < servers.length) { setSelected(servers[index]); go("actions"); }
        else if (index === servers.length) { setServer(emptyServer()); setMessage(""); setOutput(""); go("name"); }
        else if (index === servers.length + 1) void perform();
        else onClose();
      } else if (screen === "transport") {
        setServer(previous => ({ ...previous, transport: index ? "streamable_http" : "stdio" })); go(index ? "url" : "command");
      } else if (screen === "review") {
        if (index === 0) void perform(addArgs()); else go("list");
      } else if (screen === "remove") {
        if (index === 1 && selected) void perform(["remove", selected.name]); else go("actions");
      } else if (screen === "actions") {
        const action = actions[index];
        if (action === "Remove server") go("remove");
        else if (action === "Back") go("list");
        else if (selected) void perform([action === "Log out" ? "logout" : "login", selected.name]);
      }
    }
  });

  const visibleRows = Math.max(3, Math.min(10, height - 12));
  const start = Math.max(0, Math.min(index - Math.floor(visibleRows / 2), choices.length - visibleRows));
  return <Box flexDirection="column" paddingX={1} width={width} height={Math.max(8, height)} overflowY="hidden">
    <Text bold color="#A5B4FC">MCP servers{screen === "actions" || screen === "remove" ? ` · ${selected?.name}` : ""}</Text>
    <Text dimColor>Shared with Codex · configuration only; connection health is checked during turns</Text>
    {busy ? <Text color="#FBBF24">{busy} · Esc cancels this operation</Text> : null}
    {screen === "list" && !servers.length && !busy ? <Text>No external MCP servers configured. Select Add server to connect one.</Text> : null}
    {screen === "actions" && selected ? <Text wrap="wrap">{selected.transport.url ?? `${selected.transport.command} ${(selected.transport.args ?? []).join(" ")}`}</Text> : null}
    {screen === "remove" ? <Text>Remove {selected?.name} from your shared Codex configuration?</Text> : null}
    {fields[screen] ? <Box flexDirection="column" marginY={1}>
      <Text>{fields[screen]}</Text>
      {screen === "argument" ? <Text dimColor>One argument per entry. Spaces stay literal; no shell quoting needed. Added: {server.args.length}</Text> : null}
      {screen === "environment" ? <Text dimColor>Added: {server.environment.length}. Values are stored in Codex configuration.</Text> : null}
      {screen === "bearer" ? <Text dimColor>Leave empty for no bearer token. OAuth login remains available from the server menu.</Text> : null}
      <TextInput key={`${screen}-${fieldRevision}`} onChange={setDraft} onSubmit={submit} />
    </Box> : null}
    {screen === "review" ? <Box flexDirection="column" marginY={1}>
      <Text>Save {server.name} ({server.transport === "stdio" ? "stdio" : "HTTP"})?</Text>
      <Text wrap="wrap">{server.transport === "stdio" ? `${server.command} ${server.args.map(arg => JSON.stringify(arg)).join(" ")}` : server.url}</Text>
      {server.bearer ? <Text>Token from environment: {server.bearer}</Text> : null}
      {server.environment.length ? <Text>Environment: {server.environment.map(value => value.slice(0, value.indexOf("="))).join(", ")}</Text> : null}
    </Box> : null}
    {!busy ? choices.slice(start, start + visibleRows).map((label, offset) => <Text key={offset} color={start + offset === index ? "#59E6A7" : undefined} wrap="truncate-end">{start + offset === index ? "❯" : " "} {label}</Text>) : null}
    {choices.length > visibleRows ? <Text dimColor>{start + 1}–{Math.min(choices.length, start + visibleRows)} of {choices.length}</Text> : null}
    {error ? <Text color="red" wrap="wrap">{error}</Text> : null}
    {message ? <Text color="#59E6A7">{message}</Text> : null}
    {output ? <Box flexDirection="column" flexShrink={1} overflowY="hidden"><Text wrap="wrap">{output.trim().split("\n").slice(-8).join("\n")}</Text></Box> : null}
    <Box flexGrow={1} />
    <Text dimColor>{fields[screen] ? `Enter ${draft ? "continue" : "submit / skip optional field"}` : "↑/↓ or Tab select · Enter choose"} · Esc {screen === "list" ? "close" : "cancel"}</Text>
  </Box>;
}
