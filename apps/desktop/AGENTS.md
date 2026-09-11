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
