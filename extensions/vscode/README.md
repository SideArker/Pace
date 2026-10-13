# Pace for VS Code

Read Pace implementation plans and artifacts saved in conversation `artifacts/` folders under `~/.pace/sessions/` or in `.pace/artifacts/`. Opening a `.pace-plan.md` file uses the Pace reader by default. For any other Markdown file, select **Pace Markdown Preview** in **Reopen Editor With...**. The normal Markdown editor remains available.

The Pace activity bar view lists all artifacts from saved conversations for the current workspace, as well as project-local artifacts. Use its refresh button after Pace saves a new artifact. Reader headings form a colored table of contents. `User Review`, `Info`, `Warning`, and legacy `Decision` callouts use purple, blue, red, and yellow accents. Section headings and dividers use their category color; callouts keep one tinted panel. File references show a type icon and filename. The contents list sits at the left, with wider plan text beside it. Add a comment to any paragraph or list item, then use the fixed **Copy comments** button to copy compact, grouped feedback with its section and quoted text. Comments stay in preview state and do not change the Markdown file.

For a reader test, open `.pace/artifacts/sample-plans-view-auto-refresh.pace-plan.md` from the repository. It contains navigation, callouts, task lists, and source-file links. This project-local sample is separate from plans generated for a Pace conversation.

## Local install

From `extensions/vscode`, run `npm ci --include=dev && npm run package`, then run `code --install-extension pace-plan-reader-0.1.7.vsix`. The Pace artifacts view shows plan and file icons with any VS Code file icon theme.

