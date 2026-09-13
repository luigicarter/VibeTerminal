# Desktop application

This directory is the desktop app root. Its `backend`, `frontend`, `preload`,
`shared`, `build`, `vendor`, and `scripts` paths are relative to this directory.
Run desktop commands here, or use the root `dev:desktop`, `build:desktop`, and
`test:desktop` commands. Dependencies and the release version belong to this
directory's package.json and package-lock.json.

Engineering documentation stays in `../../docs`. Historical documents describe
desktop paths relative to this app root. Website source is in `../website` and
must not be imported by desktop runtime code or bundled into the installer.

Shared logo source is in `../../packages/brand`. The prebuild step synchronizes
consumer assets. Regenerate the identity through root `brand:export`.

Respect the root directory ownership rules and `../../docs/repository-layout.md`.
The hosted Lina account server belongs in `../server`, including authentication,
database migrations, account/tier policy, and centralized monitoring. This app
owns its login screens, HTTPS client, native enforcement, and activity emitters;
never bundle server runtime modules or database credentials into the desktop.
The local mobile bridge and terminal/agent services remain desktop-owned.

The account interfaces in `frontend/account` are disconnected previews, per the
user's request. Their standalone `account-preview.html`/Vite preview entry must
remain outside the normal App, Settings, preload and startup until wiring is
requested. Administration is web-only: never add admin controls or admin links
to the desktop account surface. See `../../docs/account-phase-2-previews.md`.
