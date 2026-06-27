# Vendor

The `vendor/` folder stores external reference material that is useful locally but is not active vibeTerminal app source.

## Folders

- `vendor/codex-official/` - Local copy of the official Codex project/reference tree. The app does not import from this folder, and normal build, run, typecheck, and screenshot commands should not depend on it.

## Rules of Thumb

- Treat files under `vendor/` as read-only reference material unless the task explicitly asks to update vendored content.
- Do not add imports from active app code into `vendor/`; copy only the small behavior needed into first-party code when appropriate.
- Exclude `vendor/` when doing app-specific path audits unless the audit is intentionally checking external reference material.
