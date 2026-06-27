# Runtime Artifacts

Runtime artifacts are generated during install, build, development, smoke tests, or visual QA. They are not source.

## Generated Folders

- `node_modules/` - Installed npm dependencies. Kept during this cleanup so the app remains runnable without another install.
- `dist/` - Vite production build output from `npm run build`.
- `release/` - Windows packaged app and installer artifacts from `npm run pack:win` or `npm run dist:win`.
- `.tmp/` - Temporary user data and smoke-test working directories.
  - `.tmp/vibe-agent-shims/` - vibeTerminal-owned runtime command shims for agent telemetry. Each removable directory contains a `.vibe-agent-shims.json` ownership marker.
- `artifacts/` - QA outputs such as `artifacts/vibe-terminal-screenshot.png`.

## Cleanup Policy

- `dist/`, `release/`, `.tmp/`, and `artifacts/` are safe to delete because they are rebuildable and ignored by `.gitignore`.
- `node_modules/` is rebuildable with `npm install`, but it is intentionally kept unless the cleanup goal is to reduce disk usage.
- Screenshot QA recreates `artifacts/` automatically.
