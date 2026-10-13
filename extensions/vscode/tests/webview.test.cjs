const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");

test("plan webview comments work on paragraphs and tight list items", () => {
  let provider;
  const disposable = { dispose() {} };
  const vscode = {
    EventEmitter: class { event = () => {}; },
    Uri: { joinPath: () => ({}) },
    workspace: {
      createFileSystemWatcher: () => ({ onDidCreate() {}, onDidChange() {}, onDidDelete() {} }),
      onDidChangeWorkspaceFolders: () => disposable,
      onDidChangeTextDocument: () => disposable,
    },
    window: {
      registerTreeDataProvider: () => disposable,
      registerCustomEditorProvider: (_view, editor) => { provider = editor; return disposable; },
    },
    commands: { registerCommand: () => disposable },
  };
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    return request === "vscode" ? vscode : originalLoad.call(this, request, parent, isMain);
  };
  let extension;
  try {
    extension = require(path.join(__dirname, "..", "out", "extension.js"));
  } finally {
    Module._load = originalLoad;
  }

  extension.activate({ extensionUri: {}, subscriptions: [] });
  const webview = {
    options: {},
    cspSource: "test-source",
    asWebviewUri: () => "test-style",
    onDidReceiveMessage: () => disposable,
  };
  let state = { comments: { "0": { quote: "Intro paragraph.", text: "Existing feedback", section: "Plan" } } };
  let copied;
  provider.resolveCustomTextEditor(
    {
      getText: () => "# Plan\n\nIntro paragraph.\n\n## User Review\n\n> [!USER REVIEW]\n> 1. First decision\n> 2. Second decision\n\n## Risk\n\n- First risk\n- Second risk",
      uri: { toString: () => "plan" },
    },
    { webview, onDidDispose() {} },
  );
  const script = webview.html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new vm.Script(script));
  assert.match(script, /\+ Comment/);

  const fileReference = script.slice(script.indexOf("const supportedExtensions"), script.indexOf("function makeFileIcon"));
  const result = vm.runInNewContext(`${fileReference}\nfileReference('src/main.ts#L12')`);
  assert.equal(result.href, "src/main.ts#L12");
  assert.equal(result.name, "main.ts");

  const errors = [];
  const dom = new JSDOM(webview.html, {
    url: "https://example.test",
    runScripts: "dangerously",
    beforeParse(window) {
      window.acquireVsCodeApi = () => ({
        getState: () => state,
        setState: value => { state = value; },
        postMessage: message => { copied = message; },
      });
      window.addEventListener("error", event => errors.push(event.message));
    },
  });
  assert.deepEqual(errors, []);
  const document = dom.window.document;
  const [review, risk] = document.querySelectorAll(".plan-section");
  const reviewItems = review.querySelectorAll("ol > li");
  const riskItems = risk.querySelectorAll("ul > li");
  assert.equal(reviewItems.length, 2);
  assert.equal(riskItems.length, 2);
  for (const item of [...reviewItems, ...riskItems]) {
    assert.ok(item.querySelector(":scope > .list-comment-tools > .comment-trigger"));
  }
  assert.equal(state.comments["0"].text, "Existing feedback");

  reviewItems[0].querySelector(".comment-trigger").click();
  const input = reviewItems[0].querySelector(".comment-input");
  assert.ok(input);
  input.value = "Clarify this decision";
  reviewItems[0].querySelector(".comment-actions button").click();
  assert.equal(state.comments["li-0"].quote, "First decision");
  assert.equal(state.comments["li-0"].text, "Clarify this decision");

  riskItems[0].querySelector(".comment-trigger").click();
  riskItems[0].querySelector(".comment-input").value = "Mitigate this risk";
  riskItems[0].querySelector(".comment-actions button").click();
  assert.equal(state.comments["li-2"].quote, "First risk");
  document.querySelector(".copy-comments").click();
  assert.equal(copied.count, 3);
  assert.match(copied.text, /\[User Review\][\s\S]*> First decision\n- Clarify this decision/);
  assert.match(copied.text, /\[Risk\][\s\S]*> First risk\n- Mitigate this risk/);
});
