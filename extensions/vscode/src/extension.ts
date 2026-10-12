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
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${style}"><title>Pace Plan</title></head><body><div class="reader-toolbar"><button class="copy-comments" type="button" disabled>Copy comments</button></div><div class="layout"><nav class="toc" aria-label="Plan sections"><strong>Sections</strong>${contents}</nav><main>${body}</main></div><script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const main = document.querySelector('main');
const state = vscode.getState() || {};
const comments = state.comments && typeof state.comments === 'object' ? state.comments : {};
const category = text => ({ 'USER REVIEW': 'review', INFO: 'info', WARNING: 'warning', DECISION: 'decision' })[text.trim().toUpperCase()] || '';
for (const heading of [...main.querySelectorAll('h2')]) {
  if (heading.parentElement !== main) continue;
  const section = document.createElement('section');
  section.className = 'plan-section';
  main.insertBefore(section, heading);
  let node = heading;
  while (node && !(node !== heading && node.tagName === 'H2')) { const next = node.nextSibling; section.append(node); node = next; }
  const headingKind = category(heading.textContent || '');
  const callout = section.querySelector('.callout');
  const calloutKind = callout && [...callout.classList].find(name => name.startsWith('callout-') && name !== 'callout');
  const kind = headingKind || (calloutKind ? calloutKind.slice('callout-'.length) : '');
  if (kind) {
    section.classList.add('section-' + kind);
    const link = [...document.querySelectorAll('.toc a')].find(item => item.getAttribute('href') === '#' + heading.id);
    link?.classList.add('toc-' + kind);
  }
}
const supportedExtensions = new Set('ts tsx js jsx mjs cjs json md mdx yml yaml toml css scss html htm py sh bash go rs java kt swift c h cpp hpp cs php rb sql xml svg lock env txt'.split(' '));
function fileReference(value) {
  const match = /^(?:\.\.?\/)?(?:[A-Za-z0-9_.@-]+\/)*([A-Za-z0-9_.@-]+)(?:#L(\d+))?$/.exec(value.trim());
  if (!match) return undefined;
  const path = value.trim().replace(/#L\d+$/, '');
  const name = path.split('/').pop();
  const extension = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  if (!supportedExtensions.has(extension) && !/^(Dockerfile|Makefile|Justfile)$/i.test(name)) return undefined;
  return { path, name, href: path + (match[1] && /#L\d+$/.test(value.trim()) ? '#L' + match[2] : '') };
}
function makeFileIcon(name) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 20 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('file-icon');
  if (/docker-compose/i.test(name)) {
    svg.classList.add('file-icon-docker');
    for (const [x, y] of [[3, 2], [7, 2], [11, 2], [7, 6], [11, 6], [15, 6]]) {
      const box = document.createElementNS(ns, 'rect');
      box.setAttribute('x', String(x)); box.setAttribute('y', String(y));
      box.setAttribute('width', '3.5'); box.setAttribute('height', '3'); box.setAttribute('rx', '.5');
      svg.append(box);
    }
    const hull = document.createElementNS(ns, 'path');
    hull.setAttribute('d', 'M1 10h18c-.4 3.2-2.9 5-6.5 5H7C3.4 15 1 13.2 1 10Z');
    svg.append(hull);
    return svg;
  }
  const page = document.createElementNS(ns, 'path');
  page.setAttribute('d', 'M4 1.5h8l4 4v9H4z M12 1.5v4h4');
  page.setAttribute('fill', 'none'); page.setAttribute('stroke', 'currentColor');
  page.setAttribute('stroke-width', '1.5'); page.setAttribute('stroke-linejoin', 'round');
  svg.append(page);
  return svg;
}
function fileLink(reference) {
  const link = document.createElement('a');
  link.className = 'file-reference';
  link.href = reference.href;
  link.title = reference.path;
  link.append(makeFileIcon(reference.name), document.createTextNode(reference.name));
  return link;
}
for (const link of main.querySelectorAll('a[href]')) {
  const reference = fileReference(link.getAttribute('href'));
  if (!reference) continue;
  link.classList.add('file-reference');
  if (fileReference(link.textContent || '')) link.textContent = reference.name;
  link.title ||= reference.path;
  link.prepend(makeFileIcon(reference.name));
}
for (const code of main.querySelectorAll('code')) {
  if (code.closest('pre, a')) continue;
  const reference = fileReference(code.textContent || '');
  if (reference) code.replaceWith(fileLink(reference));
}
const mentionPattern = /(^|[^A-Za-z0-9_./-])((?:\.\.?\/)?(?:[A-Za-z0-9_.@-]+\/)*[A-Za-z0-9_.@-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|mdx|yml|yaml|toml|css|scss|html|htm|py|sh|bash|go|rs|java|kt|swift|c|h|cpp|hpp|cs|php|rb|sql|xml|svg|lock|env|txt)(?:#L\d+)?)(?=$|[\s.,;:!?)\]}])/gi;
const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT, {
  acceptNode: node => node.parentElement?.closest('a, code, pre, button') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
});
const textNodes = [];
while (walker.nextNode()) textNodes.push(walker.currentNode);
for (const node of textNodes) {
  const value = node.nodeValue || '';
  const pieces = [];
  let offset = 0;
  let replaced = false;
  for (const match of value.matchAll(new RegExp(mentionPattern.source, 'gi'))) {
    const start = match.index + match[1].length;
    const reference = fileReference(match[2]);
    if (!reference) continue;
    pieces.push(document.createTextNode(value.slice(offset, start)), fileLink(reference));
    offset = start + match[2].length;
    replaced = true;
  }
  if (replaced) {
    pieces.push(document.createTextNode(value.slice(offset)));
    const fragment = document.createDocumentFragment();
    fragment.append(...pieces);
    node.replaceWith(fragment);
  }
}
const toolbarButton = document.querySelector('.copy-comments');
const paragraphById = id => [...main.querySelectorAll('p[data-comment-id]')].find(paragraph => paragraph.dataset.commentId === id);
const persist = () => { vscode.setState({ comments }); updateToolbar(); };
function updateToolbar() {
  const count = Object.keys(comments).length;
  toolbarButton.disabled = count === 0;
  toolbarButton.textContent = count ? 'Copy comments (' + count + ')' : 'Copy comments';
}
function showComment(id) {
  const paragraph = paragraphById(id);
  if (!paragraph) return;
  const tools = paragraph.nextElementSibling;
  tools.querySelector('.comment-card')?.remove();
  const comment = comments[id];
  const trigger = tools.querySelector('.comment-trigger');
  trigger.textContent = comment ? 'Edit comment' : '+ Comment';
  if (!comment) return;
  const card = document.createElement('div');
  card.className = 'comment-card';
  const label = document.createElement('strong');
  label.textContent = 'Your comment';
  const content = document.createElement('span');
  content.textContent = comment.text;
  const remove = document.createElement('button');
  remove.className = 'comment-remove';
  remove.type = 'button';
  remove.dataset.action = 'remove';
  remove.dataset.id = id;
  remove.textContent = 'Remove';
  card.append(label, content, remove);
  tools.append(card);
}
let paragraphIndex = 0;
for (const paragraph of main.querySelectorAll('p')) {
  const id = String(paragraphIndex++);
  const quote = (paragraph.textContent || '').trim();
  if (!quote) continue;
  if (comments[id]?.quote !== quote) delete comments[id];
  paragraph.dataset.commentId = id;
  const tools = document.createElement('div');
  tools.className = 'comment-tools';
  const trigger = document.createElement('button');
  trigger.className = 'comment-trigger';
  trigger.type = 'button';
  trigger.dataset.action = 'edit';
  trigger.dataset.id = id;
  trigger.setAttribute('aria-label', 'Add comment to paragraph');
  trigger.textContent = '+ Comment';
  tools.append(trigger);
  paragraph.after(tools);
  showComment(id);
}
persist();
main.addEventListener('click', event => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const id = button.dataset.id;
  const paragraph = paragraphById(id);
  if (!paragraph) return;
  const tools = paragraph.nextElementSibling;
  if (button.dataset.action === 'remove') {
    delete comments[id];
    persist();
    showComment(id);
    return;
  }
  if (button.dataset.action !== 'edit' || tools.querySelector('.comment-editor')) return;
  const form = document.createElement('div');
  form.className = 'comment-editor';
  const input = document.createElement('textarea');
  input.className = 'comment-input';
  input.setAttribute('aria-label', 'Comment on this paragraph');
  input.placeholder = 'Write your review or requested change…';
  input.value = comments[id]?.text || '';
  const actions = document.createElement('div');
  actions.className = 'comment-actions';
  const save = document.createElement('button');
  save.type = 'button';
  save.textContent = 'Save comment';
  save.addEventListener('click', () => {
    const text = input.value.trim();
    if (!text) { input.focus(); return; }
    comments[id] = { quote: (paragraph.textContent || '').trim(), text, section: tools.closest('.plan-section')?.querySelector('h2')?.textContent || '' };
    persist();
    form.remove();
    showComment(id);
  });
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'comment-cancel';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => form.remove());
  actions.append(save, cancel);
  form.append(input, actions);
  tools.append(form);
  input.focus();
});
toolbarButton.addEventListener('click', () => {
  const entries = Object.entries(comments).sort(([a], [b]) => Number(a) - Number(b));
  if (!entries.length) return;
  const groups = new Map();
  for (const [, comment] of entries) {
    const section = comment.section || 'Plan';
    if (!groups.has(section)) groups.set(section, []);
    groups.get(section).push(comment);
  }
  const report = ['Revise plan using comments below.'];
  for (const [section, items] of groups) {
    report.push('', '[' + section + ']');
    for (const comment of items) {
      report.push(...comment.quote.split(String.fromCharCode(10)).map(line => '> ' + line));
      const feedback = comment.text.split(String.fromCharCode(10));
      report.push('- ' + feedback[0], ...feedback.slice(1).map(line => '  ' + line));
    }
  }
  vscode.postMessage({ type: 'copy-comments', text: report.join(String.fromCharCode(10)), count: entries.length });
});
document.addEventListener('click', event => {
  const link = event.target.closest('a[href]');
  if (!link) return;
  const href = link.getAttribute('href');
  if (!href || href.startsWith('#')) return;
  event.preventDefault();
  vscode.postMessage({ type: 'open', href });
});
</script></body></html>`;
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
      if (message?.type === "copy-comments" && typeof message.text === "string") {
        await vscode.env.clipboard.writeText(message.text);
        const count = Number.isInteger(message.count) ? message.count : 0;
        void vscode.window.showInformationMessage(`Copied ${count} plan comment${count === 1 ? "" : "s"}.`);
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
