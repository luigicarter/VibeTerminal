# Shared Lina identity

This directory is the source of truth for the Lina app mark and exported icons.
Desktop and website runtime code consume copied assets within their own app.

- `lina-mark.svg`: canonical mark.
- `lina-symbol.svg`: transparent symbol.
- `lina-logo.png`: renderer/raster export.
- `lina-logo.ico`: Windows icon with seven resolutions.

Run `npm run brand:sync` at the repository root to copy assets to both apps.
Each app also synchronizes its own assets before building. After editing the
vector, run `npm run brand:export` to regenerate PNG/ICO through the installed
desktop Electron runtime and synchronize both consumers.

There is no shared server, terminal, or billing code in this package.
