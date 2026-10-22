import * as path from "node:path";
import { readFile } from "node:fs/promises";
import * as vscode from "vscode";
import { htmlFor } from "./plan-webview";

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
  const sessionMatch = plan.fsPath.match(/[\\/]sessions[\\/][^\\/]+[\\/]([0-9a-f-]{36})[\\/]artifacts/);
  if (sessionMatch) {
    const sessionId = sessionMatch[1];
    const sessionDir = plan.fsPath.slice(0, plan.fsPath.indexOf(`${path.sep}artifacts`));
    const sessionFile = path.join(path.dirname(sessionDir), `${sessionId}.json`);
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

export class PlanEditor implements vscode.CustomTextEditorProvider {
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
