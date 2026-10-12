# Pace for VS Code

Read Pace implementation plans saved as `.pace/artifacts/*.pace-plan.md`. Opening a plan file uses the Pace reader by default. Use **Reopen Editor With...** to edit its Markdown source.

The Pace activity bar view lists plans in the current workspace. Reader headings form a table of contents. `User Review`, `Info`, `Warning`, and `Decision` callouts remain readable as ordinary Markdown blockquotes outside VS Code.

## Local install

From `extensions/vscode`, run `npm ci --include=dev && npm run package`, then run `code --install-extension pace-plan-reader-0.1.0.vsix`. The Pace plans view shows plan icons with any VS Code file icon theme.
