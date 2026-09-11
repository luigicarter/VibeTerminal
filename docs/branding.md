# Lina Terminal identity

The app's primary identity is a geometric L with a detached terminal cursor, in silver on a graphite app tile. It is shared with the Lina Terminal website.

- `packages/brand/lina-mark.svg`: canonical editable vector.
- `apps/desktop/frontend/assets/lina-logo.png`: synchronized 512px renderer asset.
- `apps/desktop/frontend/assets/lina-logo.ico`: synchronized Windows window/installer icon (16, 24, 32, 48, 64, 128, 256px).
- Legacy `vibeterminal-logo` assets also carry the new mark for compatibility.

The renderer import, main-process window icon, and electron-builder Windows icon configuration reference the new canonical asset names. Open Fusion keeps its separate feature identity.

SVG rasterization and ICO export live in root `scripts/export-brand.cjs`. Run `npm run brand:export` to regenerate, or `npm run brand:sync` to synchronize existing exports. Both apps synchronize their own assets before building. No credentials or application sessions are needed to regenerate the assets.

Validation: desktop TypeScript/Vite build, actual isolated Electron screenshots with the new mark, PNG dimensions, and all seven ICO entries passed. This is a source/packaging change; it is not an installed or published release.
