import * as crypto from "node:crypto";
import * as vscode from "vscode";
import MarkdownIt from "markdown-it";

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

export function htmlFor(document: vscode.TextDocument, webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const { body, contents } = renderPlan(document.getText());
  const nonce = crypto.randomBytes(16).toString("base64");
  const style = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "reader.css"));
  return String.raw`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${style}"><title>Pace Plan</title></head><body><div class="reader-toolbar"><button class="copy-comments" type="button" disabled>Copy comments</button></div><div class="layout"><nav class="toc" aria-label="Plan sections"><strong>Sections</strong>${contents}</nav><main>${body}</main></div><script nonce="${nonce}">
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
const targets = new Map();
function quoteFor(target) {
  if (target.tagName === 'P') return (target.textContent || '').trim();
  const copy = target.cloneNode(true);
  for (const nested of copy.querySelectorAll('ol, ul, .comment-tools')) nested.remove();
  return (copy.textContent || '').trim();
}
const persist = () => { vscode.setState({ comments }); updateToolbar(); };
function updateToolbar() {
  const count = Object.keys(comments).length;
  toolbarButton.disabled = count === 0;
  toolbarButton.textContent = count ? 'Copy comments (' + count + ')' : 'Copy comments';
}
function showComment(id) {
  const tools = targets.get(id)?.tools;
  if (!tools) return;
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
function addCommentTarget(target, id) {
  const quote = quoteFor(target);
  if (!quote) return;
  if (comments[id]?.quote !== quote) delete comments[id];
  target.dataset.commentId = id;
  const tools = document.createElement('div');
  tools.className = 'comment-tools';
  if (target.tagName === 'LI') tools.classList.add('list-comment-tools');
  const trigger = document.createElement('button');
  trigger.className = 'comment-trigger';
  trigger.type = 'button';
  trigger.dataset.action = 'edit';
  trigger.dataset.id = id;
  trigger.setAttribute('aria-label', target.tagName === 'LI' ? 'Add comment to list item' : 'Add comment to paragraph');
  trigger.textContent = '+ Comment';
  tools.append(trigger);
  if (target.tagName === 'LI') target.insertBefore(tools, [...target.children].find(child => child.matches('ol, ul')) || null);
  else target.after(tools);
  targets.set(id, { target, tools });
  showComment(id);
}
for (const [index, paragraph] of [...main.querySelectorAll('p')].entries()) addCommentTarget(paragraph, String(index));
for (const [index, item] of [...main.querySelectorAll('li')].entries()) {
  if (!item.querySelector(':scope > p')) addCommentTarget(item, 'li-' + index);
}
for (const id of Object.keys(comments)) if (!targets.has(id)) delete comments[id];
persist();
main.addEventListener('click', event => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const id = button.dataset.id;
  const entry = targets.get(id);
  if (!entry) return;
  const { target, tools } = entry;
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
    comments[id] = { quote: quoteFor(target), text, section: tools.closest('.plan-section')?.querySelector('h2')?.textContent || '' };
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
  const order = new Map([...main.querySelectorAll('[data-comment-id]')].map((target, index) => [target.dataset.commentId, index]));
  const entries = Object.entries(comments).sort(([a], [b]) => order.get(a) - order.get(b));
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
