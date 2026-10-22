import * as vscode from "vscode";
import { ARTIFACT_GLOB, ArtifactTree, savedArtifacts } from "./artifact-tree";
import { PlanEditor } from "./plan-editor";

export { ArtifactTree, collectFiles, savedArtifacts, workspaceArtifacts } from "./artifact-tree";
export const PlanTree = ArtifactTree;
export const savedPlans = savedArtifacts;

const VIEW = "pace.planPreview";
const MARKDOWN_VIEW = "pace.markdownPreview";

async function openArtifact(uri?: vscode.Uri): Promise<void> {
  const file = uri ?? vscode.window.activeTextEditor?.document.uri;
  if (!file) return;
  if (file.fsPath.endsWith(".pace-plan.md")) {
    await vscode.commands.executeCommand("vscode.openWith", file, VIEW);
  } else if (file.fsPath.endsWith(".md")) {
    await vscode.commands.executeCommand("vscode.openWith", file, MARKDOWN_VIEW);
  } else {
    await vscode.commands.executeCommand("vscode.open", file);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const tree = new ArtifactTree();
  const watcher = vscode.workspace.createFileSystemWatcher(ARTIFACT_GLOB);
  watcher.onDidCreate(() => tree.refresh(), null, context.subscriptions);
  watcher.onDidChange(() => tree.refresh(), null, context.subscriptions);
  watcher.onDidDelete(() => tree.refresh(), null, context.subscriptions);
  context.subscriptions.push(watcher);

  context.subscriptions.push(vscode.window.registerTreeDataProvider("pace.artifacts", tree));
  try {
    context.subscriptions.push(vscode.window.registerTreeDataProvider("pace.plans", tree));
  } catch {}
  const editor = new PlanEditor(context.extensionUri);
  context.subscriptions.push(vscode.window.registerCustomEditorProvider(VIEW, editor, { supportsMultipleEditorsPerDocument: true }));
  context.subscriptions.push(vscode.window.registerCustomEditorProvider(MARKDOWN_VIEW, editor, { supportsMultipleEditorsPerDocument: true }));
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => tree.refresh()));
  context.subscriptions.push(vscode.commands.registerCommand("pace.refreshArtifacts", () => tree.refresh()));
  context.subscriptions.push(vscode.commands.registerCommand("pace.refreshPlans", () => tree.refresh()));
  context.subscriptions.push(vscode.commands.registerCommand("pace.openArtifact", openArtifact));
  context.subscriptions.push(vscode.commands.registerCommand("pace.openPlan", openArtifact));
}

export function deactivate(): void {}
