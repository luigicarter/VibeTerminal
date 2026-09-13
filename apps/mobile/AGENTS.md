# Mobile application

This directory owns the Lina Terminal mobile app: an Expo + React Native
TypeScript codebase that targets iOS and Android from one source tree. It keeps
its own npm installation, lockfile and build output. Run `npm run dev` here, or
root `npm run dev:mobile`.

Development runs the Metro bundler on port 8081 and loads the app in Expo Go or
a development build on a device or emulator. iOS binaries cannot be compiled on
this Windows development machine; store binaries for both platforms come from
EAS Build, which is not configured yet.

The app is a remote for the desktop: it reads and writes through the desktop's
local HTTP bridge (API contract v1, transcribed in `src/api/types.ts`). Develop
against `npm run mock`, the local stand-in on port 47832, and verify
screens with `npm run capture`, which walks the whole UX in a phone-sized
Electron window and writes PNGs to `.tmp/screens`.

Do not import desktop or website runtime code into this app. Shared branding is
sourced from `../../packages/brand` and copied into `assets/brand` by
`scripts/sync-brand.cjs`, which runs before this app's build. Engineering notes
live in the repository's root `docs`; see `docs/mobile-app.md`.

Respect the root directory ownership rules and `../../docs/repository-layout.md`.
Hosted identity, account/tier policy, database migrations, and centralized
activity/monitoring belong in `../server`. This app owns mobile login screens,
secure local session handling, HTTPS clients, and activity emitters. Do not
import server runtime code or database credentials. The desktop's local bridge
stays in `../desktop/backend` and is distinct from the hosted account server.
