import * as path from "node:path";
import * as crypto from "node:crypto";
import * as os from "node:os";
import { readFile, readdir, realpath } from "node:fs/promises";
import * as vscode from "vscode";

export const ARTIFACT_GLOB = "**/.pace/artifacts/**";

export async function collectFiles(directory: string): Promise<string[]> {
  const result: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      result.push(...await collectFiles(full));
    } else if (entry.isFile()) {
      result.push(full);
    }
  }
  return result;
}

export async function savedArtifacts(): Promise<vscode.Uri[]> {
  const artifacts: vscode.Uri[] = [];
  const folders = vscode.workspace.workspaceFolders ?? [];
  const sessionsBase = path.join(os.homedir(), ".pace", "sessions");

  if (folders.length === 0) {
    const projectKeys = await readdir(sessionsBase, { withFileTypes: true }).catch(() => []);
    for (const projectKey of projectKeys) {
      if (!projectKey.isDirectory() || !/^[0-9a-f]{64}$/.test(projectKey.name)) continue;
      const root = path.join(sessionsBase, projectKey.name);
      const sessions = await readdir(root, { withFileTypes: true }).catch(() => []);
      for (const session of sessions) {
        if (!session.isDirectory() || !/^[0-9a-f-]{36}$/.test(session.name)) continue;
        const directory = path.join(root, session.name, "artifacts");
        const files = await collectFiles(directory);
        for (const file of files) artifacts.push(vscode.Uri.file(file));
      }
    }
    return artifacts;
  }

  const targetKeys = new Set<string>();
  for (const folder of folders) {
    if (folder.uri.scheme !== "file") continue;
    const project = path.resolve(folder.uri.fsPath);
    const normalized = process.platform === "win32" ? project.toLowerCase() : project;
    targetKeys.add(crypto.createHash("sha256").update(normalized).digest("hex"));
    try {
      const real = await realpath(project);
      const normalizedReal = process.platform === "win32" ? real.toLowerCase() : real;
      targetKeys.add(crypto.createHash("sha256").update(normalizedReal).digest("hex"));
    } catch {}
  }

  const projectEntries = await readdir(sessionsBase, { withFileTypes: true }).catch(() => []);
  for (const projectEntry of projectEntries) {
    if (!projectEntry.isDirectory() || !/^[0-9a-f]{64}$/.test(projectEntry.name)) continue;
    let isMatch = targetKeys.has(projectEntry.name);
    const root = path.join(sessionsBase, projectEntry.name);

    if (!isMatch) {
      const sessionFiles = await readdir(root, { withFileTypes: true }).catch(() => []);
      for (const sessionFile of sessionFiles) {
        if (!sessionFile.isFile() || !sessionFile.name.endsWith(".json") || sessionFile.name === "active.json") continue;
        try {
          const raw: unknown = JSON.parse(await readFile(path.join(root, sessionFile.name), "utf8"));
          if (raw && typeof raw === "object" && "projectPath" in raw && typeof raw.projectPath === "string") {
            const sessProj = path.resolve(raw.projectPath);
            const sessNorm = process.platform === "win32" ? sessProj.toLowerCase() : sessProj;
            for (const folder of folders) {
              const wfProj = path.resolve(folder.uri.fsPath);
              const wfNorm = process.platform === "win32" ? wfProj.toLowerCase() : wfProj;
              if (sessNorm === wfNorm || wfNorm.startsWith(sessNorm + path.sep) || sessNorm.startsWith(wfNorm + path.sep)) {
                isMatch = true;
                break;
              }
            }
          }
        } catch {}
        if (isMatch) break;
      }
    }

    if (isMatch) {
      const sessions = await readdir(root, { withFileTypes: true }).catch(() => []);
      for (const session of sessions) {
        if (!session.isDirectory() || !/^[0-9a-f-]{36}$/.test(session.name)) continue;
        const directory = path.join(root, session.name, "artifacts");
        const files = await collectFiles(directory);
        for (const file of files) artifacts.push(vscode.Uri.file(file));
      }
    }
  }

  return artifacts;
}

export async function workspaceArtifacts(): Promise<vscode.Uri[]> {
  const uris: vscode.Uri[] = [];
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (folder.uri.scheme !== "file") continue;
    const legacyDir = path.join(folder.uri.fsPath, ".pace", "artifacts");
    const files = await collectFiles(legacyDir);
    for (const file of files) uris.push(vscode.Uri.file(file));
  }
  return uris;
}

export class ArtifactTree implements vscode.TreeDataProvider<vscode.Uri> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  refresh(): void { this.changed.fire(); }
  getTreeItem(uri: vscode.Uri): vscode.TreeItem {
    const item = new vscode.TreeItem(path.basename(uri.fsPath), vscode.TreeItemCollapsibleState.None);
    item.resourceUri = uri;
    item.iconPath = uri.fsPath.endsWith(".pace-plan.md")
      ? new vscode.ThemeIcon("book")
      : uri.fsPath.endsWith(".md")
      ? new vscode.ThemeIcon("file-text")
      : new vscode.ThemeIcon("file");
    const sessionMatch = uri.fsPath.match(/[\\/]sessions[\\/][^\\/]+[\\/]([0-9a-f-]{36})[\\/]artifacts/);
    if (sessionMatch) item.description = sessionMatch[1].slice(0, 8);
    item.command = { command: "pace.openArtifact", title: "Open Pace Artifact", arguments: [uri] };
    item.tooltip = uri.fsPath;
    return item;
  }
  async getChildren(): Promise<vscode.Uri[]> {
    const sessionFiles = await savedArtifacts();
    const wsDirect = await workspaceArtifacts();
    const wsGlob = await Promise.resolve(vscode.workspace.findFiles(ARTIFACT_GLOB)).catch(() => []);
    const seen = new Set<string>();
    const files: vscode.Uri[] = [];
    for (const uri of [...sessionFiles, ...wsDirect, ...wsGlob]) {
      if (!seen.has(uri.fsPath)) {
        seen.add(uri.fsPath);
        files.push(uri);
      }
    }
    return files.sort((a, b) => a.fsPath.localeCompare(b.fsPath));
  }
}
