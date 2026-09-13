# Shared Lina identity

This directory is the source of truth for the Lina app mark and exported icons.
Desktop, website and mobile runtime code consume copied assets within their own app.

- `lina-mark.svg`: canonical mark.
- `lina-symbol.svg`: transparent symbol.
- `lina-logo.png`: 512px renderer/raster export.
- `lina-logo-1024.png`: 1024px export for mobile app and splash icons.
- `lina-logo-adaptive-1024.png`: 1024px transparent canvas with the mark at 66%
  of the frame, for the Android adaptive-icon foreground safe zone.
- `lina-logo.ico`: Windows icon with seven resolutions.

Run `npm run brand:sync` at the repository root to copy assets to every app.
Each app also synchronizes its own assets before building. After editing the
vector, run `npm run brand:export` to regenerate the PNG/ICO exports through the
installed desktop Electron runtime and synchronize all consumers.

There is no shared server, terminal, or billing code in this package.
