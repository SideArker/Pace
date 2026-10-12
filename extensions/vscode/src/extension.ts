import * as path from "node:path";
import * as crypto from "node:crypto";
import * as os from "node:os";
import { readFile, readdir } from "node:fs/promises";
import * as vscode from "vscode";
import MarkdownIt from "markdown-it";

const VIEW = "pace.planPreview";
const MARKDOWN_VIEW = "pace.markdownPreview";
const PLAN_GLOB = "**/.pace/artifacts/*.pace-plan.md";

async function savedPlans(): Promise<vscode.Uri[]> {
  const plans: vscode.Uri[] = [];
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (folder.uri.scheme !== "file") continue;
    const project = path.resolve(folder.uri.fsPath);
    const normalized = process.platform === "win32" ? project.toLowerCase() : project;
    const key = crypto.createHash("sha256").update(normalized).digest("hex");
    const root = path.join(os.homedir(), ".pace", "sessions", key);
    const sessions = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const session of sessions) {
      if (!session.isDirectory() || !/^[0-9a-f-]{36}$/.test(session.name)) continue;
      const directory = path.join(root, session.name, "artifacts");
      const files = await readdir(directory, { withFileTypes: true }).catch(() => []);
      for (const file of files) {
        if (file.isFile() && file.name.endsWith(".pace-plan.md")) plans.push(vscode.Uri.file(path.join(directory, file.name)));
      }
    }
  }
  return plans;
}

class PlanTree implements vscode.TreeDataProvider<vscode.Uri> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  refresh(): void { this.changed.fire(); }
  getTreeItem(uri: vscode.Uri): vscode.TreeItem {
    const item = new vscode.TreeItem(path.basename(uri.fsPath), vscode.TreeItemCollapsibleState.None);
    item.resourceUri = uri;
    item.iconPath = new vscode.ThemeIcon("book");
    if (uri.fsPath.includes(`${path.sep}sessions${path.sep}`)) item.description = path.basename(path.dirname(path.dirname(uri.fsPath))).slice(0, 8);
    item.command = { command: "pace.openPlan", title: "Open Pace Plan", arguments: [uri] };
    item.tooltip = uri.fsPath;
    return item;
  }
  async getChildren(): Promise<vscode.Uri[]> {
    const files = [...await savedPlans(), ...await vscode.workspace.findFiles(PLAN_GLOB)];
    return files.sort((a, b) => a.fsPath.localeCompare(b.fsPath));
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

function renderPlan(source: string): { body: string; contents: string } {
  const md = new MarkdownIt({ html: false, linkify: true, typographer: true });
  const tokens = md.parse(source, {});
  const headings: { id: string; label: string; level: number }[] = [];
  const used = new Set<string>();
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.type !== "heading_open") continue;
    const label = tokens[index + 1]?.content ?? "Section";
    const base = label.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "") || "section";
    let id = base;
    let suffix = 2;
    while (used.has(id)) id = `${base}-${suffix++}`;
    used.add(id);
    token.attrSet("id", id);
    headings.push({ id, label, level: Number(token.tag.slice(1)) });
  }
  let body = md.renderer.render(tokens, md.options, {});
  const labels: Record<string, string> = { "USER REVIEW": "User Review", INFO: "Info", WARNING: "Warning", DECISION: "Decision" };
  body = body.replace(/<blockquote>\s*<p>\[!(USER REVIEW|INFO|WARNING|DECISION)\](?:\s*<br\s*\/?>)?\s*/gi, (_whole, raw: string) => {
    const key = raw.toUpperCase();
    const kind = key === "USER REVIEW" ? "review" : key.toLowerCase();
    return `<blockquote class="callout callout-${kind}"><p><span class="callout-label">${labels[key]}</span>`;
  });
  const contents = headings.map(item => `<a class="${item.level > 2 ? "minor" : ""}" href="#${escapeHtml(item.id)}">${escapeHtml(item.label)}</a>`).join("\n");
  return { body, contents };
}

function htmlFor(document: vscode.TextDocument, webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const { body, contents } = renderPlan(document.getText());
  const nonce = crypto.randomBytes(16).toString("base64");
  const style = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "reader.css"));
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${style}"><title>Pace Plan</title></head><body><div class="layout"><nav class="toc" aria-label="Plan sections"><strong>Sections</strong>${contents}</nav><main>${body}</main></div><script nonce="${nonce}">const vscode = acquireVsCodeApi(); document.addEventListener('click', event => { const link = event.target.closest('a[href]'); if (!link) return; const href = link.getAttribute('href'); if (!href || href.startsWith('#')) return; event.preventDefault(); vscode.postMessage({ type: 'open', href }); });</script></body></html>`;
}

async function openPlanLink(plan: vscode.Uri, href: string): Promise<void> {
  if (/^https?:\/\//i.test(href)) {
    await vscode.env.openExternal(vscode.Uri.parse(href));
    return;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) return;
  const match = /^([^#?]+)(?:#L(\d+))?$/.exec(decodeURIComponent(href));
  if (!match) return;
  const legacyMarker = `${path.sep}.pace${path.sep}artifacts${path.sep}`;
  const position = plan.fsPath.lastIndexOf(legacyMarker);
  let base = position >= 0 ? plan.fsPath.slice(0, position) : path.dirname(plan.fsPath);
  let allowedRoot = vscode.workspace.getWorkspaceFolder(plan)?.uri.fsPath ?? base;
  const sessionId = path.basename(path.dirname(path.dirname(plan.fsPath)));
  if (/^[0-9a-f-]{36}$/.test(sessionId)) {
    const sessionFile = path.join(path.dirname(path.dirname(path.dirname(plan.fsPath))), `${sessionId}.json`);
    try {
      const saved: unknown = JSON.parse(await readFile(sessionFile, "utf8"));
      if (saved && typeof saved === "object" && "projectPath" in saved && typeof saved.projectPath === "string") {
        base = saved.projectPath;
        allowedRoot = base;
      }
    } catch { /* Keep ordinary relative-link behavior. */ }
  }
  const target = path.resolve(base, match[1]!);
  if (!target.startsWith(allowedRoot + path.sep)) return;
  const uri = vscode.Uri.file(target);
  const document = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(document, { preview: true, viewColumn: vscode.ViewColumn.Beside });
  if (match[2]) {
    const line = Math.max(0, Number(match[2]) - 1);
    editor.selection = new vscode.Selection(line, 0, line, 0);
    editor.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.InCenter);
  }
}

class PlanEditor implements vscode.CustomTextEditorProvider {
  constructor(private readonly extensionUri: vscode.Uri) {}
  resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): void {
    panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")] };
    const update = () => { panel.webview.html = htmlFor(document, panel.webview, this.extensionUri); };
    update();
    const change = vscode.workspace.onDidChangeTextDocument(event => { if (event.document.uri.toString() === document.uri.toString()) update(); });
    const messages = panel.webview.onDidReceiveMessage(async message => {
      if (message?.type === "open" && typeof message.href === "string") {
        try { await openPlanLink(document.uri, message.href); }
        catch (error) { void vscode.window.showWarningMessage(`Could not open plan link: ${String(error)}`); }
      }
    });
    panel.onDidDispose(() => { change.dispose(); messages.dispose(); });
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const tree = new PlanTree();
  const watcher = vscode.workspace.createFileSystemWatcher(PLAN_GLOB);
  watcher.onDidCreate(() => tree.refresh(), null, context.subscriptions);
  watcher.onDidChange(() => tree.refresh(), null, context.subscriptions);
  watcher.onDidDelete(() => tree.refresh(), null, context.subscriptions);
  context.subscriptions.push(watcher);
  context.subscriptions.push(vscode.window.registerTreeDataProvider("pace.plans", tree));
  const editor = new PlanEditor(context.extensionUri);
  context.subscriptions.push(vscode.window.registerCustomEditorProvider(VIEW, editor, { supportsMultipleEditorsPerDocument: true }));
  context.subscriptions.push(vscode.window.registerCustomEditorProvider(MARKDOWN_VIEW, editor, { supportsMultipleEditorsPerDocument: true }));
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => tree.refresh()));
  context.subscriptions.push(vscode.commands.registerCommand("pace.refreshPlans", () => tree.refresh()));
  context.subscriptions.push(vscode.commands.registerCommand("pace.openPlan", async (uri?: vscode.Uri) => {
    const file = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (!file) return;
    await vscode.commands.executeCommand("vscode.openWith", file, file.fsPath.endsWith(".pace-plan.md") ? VIEW : MARKDOWN_VIEW);
  }));
}

export function deactivate(): void {}
