# Vendor

The `vendor/` folder stores external reference material that is useful locally but is not active vibeTerminal app source.

## Folders

- `vendor/codex-web/` - Ignored, generated executable resource for the Codex Web preview. `npm run prepare:codex-web` builds pinned `miuuyy/codex-chatgpt-web` plus a pinned Bun runtime and retained license notices. Lina loads the launcher only in a dedicated Electron process; this is an explicit runtime exception to the reference-only rule below. Do not import the bridge into the main Lina process or renderer. See `docs/codex-web.md` for patching, account isolation, setup and acceptance limits.

- `vendor/codex-official/` - Local copy of the official Codex project/reference tree. The app does not import from this folder, and normal build, run, typecheck, and screenshot commands should not depend on it.
- `vendor/kimi-custom/` - Runtime copy of the custom Kimi Code fork that the "Kimi + CC" agent option runs via the shim. The app *executes* this bundle (like `vendor/codex-bin/`) but never imports its code.

  **Provenance.** Built from `C:\Users\ahmed\Documents\kimi\kimi-code` (a private checkout, not part of this repository): upstream `MoonshotAI/kimi-code` **0.42.0** plus two harness commits that add a `claude-code` profile set (`packages/agent-core-v2/src/session/agentLifecycle/profile/claude-code/`, registered as a last-wins upsert at import, with `coder` / `explore` / `plan` subagents) and make it the **default** profile. Nothing sets `KIMI_PROFILE`; `KIMI_PROFILE=default` restores the stock profile for a one-off run.

  **What is vendored.** `dist/main.mjs` (the CLI bundle), `dist/search-worker.mjs` (the kap-server global-search worker, new since 0.29 — `main.mjs` resolves it as `new URL('./search-worker.mjs', import.meta.url)`, i.e. a sibling of `main.mjs`, so it must be copied alongside it), `native/` (pi-tui's darwin/win32 console-mode prebuilds; `main.mjs` looks for them at `<dist>/../native/<platform>/prebuilds/<platform>-<arch>/`), `package.json`, and the `bin/kimi-custom(.cmd)` launcher wrappers. `dist-web/` is **not** vendored: it is 43 MB and only the `kimi web` / `kimi server` commands read it (`WEB_ASSETS_DIR`), never the TUI path a pane runs.

  **Self-contained ESM.** 0.42 statically imports `ws` and `qrcode` (its only two runtime `dependencies`), which a vendored bundle with no sibling `node_modules` cannot resolve. The fork's `apps/kimi-code/tsdown.config.ts` therefore force-bundles them (`deps.alwaysBundle`, mirroring `tsdown.native.config.ts`), leaving only lazily loaded native bindings external — `node-pty` (`await import('node-pty')`, host terminal service) and `@mariozechner/clipboard` (`createRequire`, image paste), both guarded so their absence degrades instead of throwing. After a rebuild the bundle must contain **no** bare static import; that is what makes `node vendor/kimi-custom/dist/main.mjs --version` work anywhere.

  **Launchers.** `api.txt` next to the package is gitignored and optional: with a key the wrapper exports the platform-key environment (kimi-k3 on Moonshot's Anthropic-compatible endpoint, 1M context); with no key it exports nothing, prints a one-line note, and the providers configured in the shared `~/.kimi-code` apply. The `.cmd` wrapper keeps CRLF endings and first runs `chcp 65001` so the TUI's UTF-8 box-drawing survives legacy conhost windows that default to the OEM code page.

  **Refresh procedure.** Rebuild the fork (`C:\Users\ahmed\Documents\kimi\rebuild.sh`), then re-copy `dist/main.mjs`, `dist/search-worker.mjs`, `native/`, and `package.json` from the fork's `apps/kimi-code/`. `.gitattributes` already pins `dist/**` and `native/**` to `-text`, and `apps/desktop/package.json` `extraResources` copies the whole `vendor/kimi-custom` directory, so new files under those paths need no further wiring. `scripts/dev/model-drift.cjs` reads the pinned version straight out of the vendored `package.json`, so copying it is the version bump. Finish with `npm run smoke:provider-startup -- --only kimi,kimi-custom --no-type` and re-capture the startup fixtures (see `scripts/backend/fixtures/provider-startup-screens/README.md`).

## Rules of Thumb

- Treat files under `vendor/` as read-only reference material unless the task explicitly asks to update vendored content.
- Do not add imports from active app code into `vendor/`; copy only the small behavior needed into first-party code when appropriate.
- Exclude `vendor/` when doing app-specific path audits unless the audit is intentionally checking external reference material.
