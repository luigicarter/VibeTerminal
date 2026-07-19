# Vendor

The `vendor/` folder stores external reference material that is useful locally but is not active vibeTerminal app source.

## Folders

- `vendor/codex-official/` - Local copy of the official Codex project/reference tree. The app does not import from this folder, and normal build, run, typecheck, and screenshot commands should not depend on it.
- `vendor/kimi-custom/` - Runtime copy of the custom Kimi Code fork (kimi-k3 via Moonshot's Anthropic-compatible endpoint + claude-code profile set): the prebuilt `dist/main.mjs`, `native/` console-mode prebuilds, `package.json`, and the `bin/kimi-custom(.cmd)` launcher wrappers that the "Kimi + CC" agent option runs via the shim. The app *executes* this bundle (like `vendor/codex-bin/`) but never imports its code; the API key file `api.txt` is gitignored. Refresh by re-copying `dist/`, `native/`, and `package.json` from the fork's `apps/kimi-code/` after a rebuild there.

## Rules of Thumb

- Treat files under `vendor/` as read-only reference material unless the task explicitly asks to update vendored content.
- Do not add imports from active app code into `vendor/`; copy only the small behavior needed into first-party code when appropriate.
- Exclude `vendor/` when doing app-specific path audits unless the audit is intentionally checking external reference material.
