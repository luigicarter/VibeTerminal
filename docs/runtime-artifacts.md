# Runtime Artifacts

Runtime artifacts are generated during install, build, development, smoke tests, or visual QA. They are not source.

## Generated Folders

- `node_modules/` - Installed npm dependencies. Kept during this cleanup so the app remains runnable without another install.
- `dist/` - Vite production build output from `npm run build`.
- `release/` - Windows packaged app and installer artifacts from `npm run pack:win` or `npm run dist:win`.
- `.tmp/` - Temporary user data and smoke-test working directories.
  - `.tmp/vibe-agent-shims/` - vibeTerminal-owned runtime command shims for agent telemetry. Each removable directory contains a `.vibe-agent-shims.json` ownership marker.
  - Open Fusion smoke tests use a sibling `openfusion/` runtime directory for generated pane-scoped OpenCode config, commands, TUI plugin, and pane model state.
  - In the real app the `openfusion/` directory lives under Electron userData (`%APPDATA%\vibe-terminal\openfusion\`) and also holds `opencode-home/` — the app-owned OpenCode data/config home (conversation threads in `opencode.db`, provider credentials in `auth.json`, logs, snapshots). It is user data, NOT a rebuildable artifact: deleting it deletes the user's Open Fusion conversations and connected providers. The stale-pane sweep only touches `openfusion/sessions/`.
- `artifacts/` - QA outputs such as `artifacts/vibe-terminal-screenshot.png` and `artifacts/vibe-terminal-openfusion-screenshot.png`.
- `output/` - Generated design previews, research exports, and voice QA recordings/reports. Kept locally and excluded from release source.

## Cleanup Policy

- Codex Web keeps `codex-web/{codex-home,browser,bridge,logs}` under Electron userData. Native Codex owns `codex-home/sessions/`, `history.jsonl`, its thread database and settings; Lina does not create a duplicate conversation store. These histories and browser/login stores are user data and survive pane closure and Web logout. Only bounded diagnostic logs are routinely pruned. `vendor/codex-web/` and `.tmp/codex-web-build/` are rebuildable resources; they do not contain the user's live login.

- `dist/`, `release/`, `.tmp/`, and `artifacts/` are safe to delete because they are rebuildable and ignored by `.gitignore`.
- `node_modules/` is rebuildable with `npm install`, but it is intentionally kept unless the cleanup goal is to reduce disk usage.
- Screenshot QA recreates `artifacts/` automatically.
