const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const fs = require("node:fs/promises");
const os = require("node:os");

test("ArtifactTree discovers all artifacts in general, not just plans", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pace-vscode-test-"));
  const workspaceDir = path.join(tmpDir, "workspace");
  const wsArtifactsDir = path.join(workspaceDir, ".pace", "artifacts");
  await fs.mkdir(wsArtifactsDir, { recursive: true });

  // Create workspace-level artifacts: one plan and one regular markdown artifact
  await fs.writeFile(path.join(wsArtifactsDir, "sample.pace-plan.md"), "# Plan\n");
  await fs.writeFile(path.join(wsArtifactsDir, "notes.md"), "# Notes\n");
  await fs.writeFile(path.join(wsArtifactsDir, "schema.json"), "{}");
  await fs.writeFile(path.join(wsArtifactsDir, ".hidden"), "hidden");

  // Create fake ~/.pace/sessions structure
  const fakeHome = path.join(tmpDir, "home");
  const origHomedir = os.homedir;
  os.homedir = () => fakeHome;

  const crypto = require("node:crypto");
  const project = path.resolve(workspaceDir);
  const normalized = process.platform === "win32" ? project.toLowerCase() : project;
  const key = crypto.createHash("sha256").update(normalized).digest("hex");
  const sessionId = "12345678-abcd-ef01-2345-6789abcdef01";
  const sessionArtifactsDir = path.join(fakeHome, ".pace", "sessions", key, sessionId, "artifacts");
  await fs.mkdir(sessionArtifactsDir, { recursive: true });

  await fs.writeFile(path.join(sessionArtifactsDir, "feature-design.md"), "# Feature Design\n");
  await fs.writeFile(path.join(sessionArtifactsDir, "architecture.pace-plan.md"), "# Architecture\n");

  const registeredCommands = new Map();
  const disposable = { dispose() {} };
  const mockVscode = {
    EventEmitter: class {
      event = (cb) => { this.cb = cb; return disposable; };
      fire() { if (this.cb) this.cb(); }
    },
    ThemeIcon: class { constructor(id) { this.id = id; } },
    TreeItem: class {
      constructor(label, collapsibleState) {
        this.label = label;
        this.collapsibleState = collapsibleState;
      }
    },
    TreeItemCollapsibleState: { None: 0 },
    Uri: {
      file: (fsPath) => ({ fsPath, scheme: "file" }),
      joinPath: () => ({}),
    },
    workspace: {
      workspaceFolders: [{ uri: { scheme: "file", fsPath: workspaceDir } }],
      findFiles: async (glob) => [],
      createFileSystemWatcher: () => ({ onDidCreate() {}, onDidChange() {}, onDidDelete() {} }),
      onDidChangeWorkspaceFolders: () => disposable,
      onDidChangeTextDocument: () => disposable,
    },
    window: {
      registerTreeDataProvider: () => disposable,
      registerCustomEditorProvider: () => disposable,
    },
    commands: {
      registerCommand: (cmd, handler) => {
        registeredCommands.set(cmd, handler);
        return disposable;
      },
      executeCommand: async () => {},
    },
  };

  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    return request === "vscode" ? mockVscode : originalLoad.call(this, request, parent, isMain);
  };

  let extension;
  try {
    extension = require(path.join(__dirname, "..", "out", "extension.js"));
  } finally {
    Module._load = originalLoad;
    os.homedir = origHomedir;
  }

  try {
    os.homedir = () => fakeHome;
    const tree = new extension.ArtifactTree();
    const children = await tree.getChildren();
    const fileNames = children.map(uri => path.basename(uri.fsPath));

    // Ensure all artifacts are found in general:
    // plans, non-plan markdown artifacts, and other non-hidden files
    assert.ok(fileNames.includes("sample.pace-plan.md"), "Includes workspace plan");
    assert.ok(fileNames.includes("notes.md"), "Includes workspace non-plan markdown");
    assert.ok(fileNames.includes("schema.json"), "Includes workspace other files");
    assert.ok(!fileNames.includes(".hidden"), "Excludes hidden files");
    assert.ok(fileNames.includes("feature-design.md"), "Includes session non-plan markdown artifact");
    assert.ok(fileNames.includes("architecture.pace-plan.md"), "Includes session plan");

    // Check tree items
    const planItemUri = children.find(uri => uri.fsPath.endsWith("architecture.pace-plan.md"));
    const planItem = tree.getTreeItem(planItemUri);
    assert.equal(planItem.iconPath.id, "book");
    assert.equal(planItem.description, "12345678");
    assert.equal(planItem.command.command, "pace.openArtifact");

    const mdItemUri = children.find(uri => uri.fsPath.endsWith("feature-design.md"));
    const mdItem = tree.getTreeItem(mdItemUri);
    assert.equal(mdItem.iconPath.id, "file-text");
    assert.equal(mdItem.description, "12345678");

    const jsonItemUri = children.find(uri => uri.fsPath.endsWith("schema.json"));
    const jsonItem = tree.getTreeItem(jsonItemUri);
    assert.equal(jsonItem.iconPath.id, "file");

    // Check activation registers both commands and view
    const subscriptions = [];
    extension.activate({ extensionUri: {}, subscriptions });
    assert.ok(registeredCommands.has("pace.openArtifact"), "pace.openArtifact registered");
    assert.ok(registeredCommands.has("pace.openPlan"), "pace.openPlan registered");
    assert.ok(registeredCommands.has("pace.refreshArtifacts"), "pace.refreshArtifacts registered");
    assert.ok(registeredCommands.has("pace.refreshPlans"), "pace.refreshPlans registered");
  } finally {
    os.homedir = origHomedir;
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
