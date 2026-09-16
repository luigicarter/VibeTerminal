# Repository layout and migration

Lina's desktop application, website and mobile application live in one Git
repository with separate dependency installations, build outputs, runtime
configuration, and release paths.

```text
apps/
  desktop/             Electron app root
    backend/           Main process, PTYs, agent integrations
    frontend/          React desktop renderer
    preload/           Electron IPC bridge
    shared/            Desktop runtime contracts
    build/             Installer customization
    vendor/            Desktop vendor sources and prepared resources
    scripts/           Desktop tests, development and release helpers
  website/
    frontend/          Marketing site and public user documentation
    backend/           Website API and local signup storage
    scripts/           Website development, captures and checks
  mobile/              Expo/React Native app root (iOS and Android)
    assets/brand/      Brand copies synchronized from packages/brand
    scripts/           Mobile configuration checks
  server/              Bun/TypeScript account backend
    src/               Auth, account/tier policy, activity, monitoring and jobs
    migrations/        PostgreSQL auth/application schema changes
    contracts/         OpenAPI and activity contract documentation
    tests/             Isolated database/API and built-server checks
    scripts/           App-owned setup, migration, backup and test helpers
    deploy/            Container, proxy and monitoring configuration
packages/brand/        Canonical shared logo and exports
docs/                  Desktop and repository engineering documentation
scripts/               App command forwarding and shared brand tooling
```

## Required placement rules for agents

Read the root `AGENTS.md` and the owning app's `AGENTS.md` before adding or
moving files. These boundaries apply to implementation, tests, configuration,
dependencies, and later refactoring.

| Responsibility | Canonical location |
| --- | --- |
| Hosted identity, login/session services, account states, tiers and grants | `apps/server/src` |
| Account database schema and migrations | `apps/server/migrations` |
| Hosted activity intake, admin APIs, operational monitoring and jobs | `apps/server/src` |
| Server API contracts, tests, helpers, dependencies and deployment configuration | `apps/server/contracts`, `tests`, `scripts`, package files and `deploy` |
| Electron runtime, local terminals/agents, desktop mobile bridge | `apps/desktop/backend` |
| Desktop screens, account client and local activity emitters | `apps/desktop/frontend`, `backend`, `preload` as appropriate |
| Marketing pages, public docs and marketing APIs | `apps/website` |
| Website account/admin screens and HTTPS client, when implemented | `apps/website/frontend` |
| Mobile screens, device integration and HTTPS clients | `apps/mobile` |
| Shared branding | `packages/brand` |
| Engineering documentation and plans | Root `docs`; website-specific notes in `apps/website/docs` |
| Repository command forwarding and CI entry points | Root `scripts`, `package.json`, `.github/workflows` |

The server owns the subdirectories above. Do not create
duplicate hosted authentication/database services under the website or desktop.
Connect client apps through documented HTTPS contracts; keep server-only code,
secrets, and dependencies out of clients and installers. A local desktop bridge
remains a desktop responsibility even though it exposes an HTTP endpoint.

The account screens are currently disconnected previews. Desktop personal
account components live in `apps/desktop/frontend/account`; web account and
administration components live in `apps/website/frontend/src/account` and
`src/admin`. Administration is web-only. The user has not requested wiring these
previews to startup, production routes, IPC, storage, or the account server.
See [phase 2 previews](account-phase-2-previews.md).

Use canonical `apps/` paths rather than root compatibility junctions. Keep
runtime data and credentials in ignored app-owned storage or managed production
storage, never in committed fixtures. If a responsibility moves, update this
map and affected app guides together; preserve unrelated work.

## Commands

Disconnected account/payment preparation follows the same ownership map:
server modules/SQL/contracts stay server-owned, native services stay desktop-owned,
and web clients stay website-owned. Prepared migration SQL is nested outside
normal discovery. Dedicated test harnesses may connect these modules only to
disposable local fixtures. See [account paid readiness](account-paid-readiness.md).

The `apps/server` service is independent of the website's marketing API. It owns
login, account/tier management, PostgreSQL, activity intake and monitoring.
Source and local container acceptance are implemented; live Google deployment
is pending. See the [implementation record](server-phase-1-implementation.md).

Run these from the repository root:

| Command | Purpose |
| --- | --- |
| `npm run setup:desktop` | Install the desktop app's locked dependencies |
| `npm run setup:website` | Install the website's locked dependencies |
| `npm run setup:mobile` | Install the mobile app's locked dependencies |
| `npm run setup:server` | Install the account server's locked Bun dependencies |
| `npm run build:server` | Type-check and build the Bun account server |
| `npm run test:server` | Run all server tests with isolated Linux Bun/PostgreSQL containers |
| `npm run dev:server` | Run the configured source server with Bun |
| `npm run start:server` | Run the configured Bun server |
| `npm run db:migrate:server` | Apply account database migrations and permissions |
| `npm run setup` | Install all three apps |
| `npm run dev:desktop` | Desktop development, renderer on 5173 |
| `npm run dev:website` | Website on 5174, API on 3001 |
| `npm run dev:mobile` | Mobile development, Metro bundler on 8081 |
| `npm run android:mobile` | Open the mobile app on an Android device or emulator |
| `npm run ios:mobile` | Open the mobile app on iOS; needs macOS or an EAS build |
| `npm run build:desktop` | Type-check and build the desktop renderer |
| `npm run build:website` | Type-check and build website frontend/API |
| `npm run build:mobile` | Export the iOS and Android JavaScript bundles to dist |
| `npm run start:website` | Serve the production website/API on 3001 |
| `npm run typecheck:mobile` | Type-check the mobile app |
| `npm test` | Repository boundaries, branding, website, mobile and docs checks |
| `npm run test:desktop` | Desktop frontend and Orchestrator suites |
| `npm run test:mobile` | Mobile app configuration and brand-asset checks |
| `npm run brand:sync` | Synchronize brand exports into every app |
| `npm run brand:export` | Regenerate PNG/ICO from the canonical SVG |

Existing desktop npm script names remain available at the root through a runner
that sets the app working directory and forwards arguments. Inside any app, its
normal app commands still work. Root npm has no runtime dependencies. Desktop,
website and mobile keep package-lock.json; the server owns bun.lock and pins its
Bun runtime. Root forwarding uses the server's own runner for Bun commands. The
website retains its frontend/backend npm
workspaces; desktop and mobile use none. Native desktop dependencies are not
hoisted into website or mobile installs.

## Build and deployment boundaries

The Windows workflow and model-drift workflow run from apps/desktop. Windows
release version checks read the desktop package, and installer output is under
apps/desktop/release. Failure-artifact paths follow the new location. The website
has its own path-filtered CI workflow, dependency cache, build, tests and artifact.
Website changes do not create desktop releases. No deployment was triggered by
this migration.

The mobile app has the same independence: its own path-filtered workflow on
ubuntu-latest running install, type-check, tests and `expo export` from
apps/mobile, and its own npm cache. Mobile changes trigger neither the desktop
nor the website workflow. CI exports JavaScript bundles only; iOS and Android
store binaries come from EAS Build, which is not configured, and the Windows
development machine cannot compile an iOS binary locally. The mobile app imports
no desktop or website runtime code and neither imports it; its brand assets are
copied from packages/brand by the shared sync script before each build.

Desktop packaging resolves files inside its own app directory. It cannot include
the website through a parent-directory source glob. Shared brand assets are
copied into app-owned runtime assets before builds; neither runtime imports the
other application. App-specific scripts stay with their app, while root scripts
only coordinate repository concerns.

Public documentation lives in apps/website/frontend/src/docs. Desktop engineering
documents remain in root docs. Historical source paths in those documents are
relative to apps/desktop unless stated otherwise.

The root .env was left in place and ignored. Website environment files remain
app-specific. Signup JSON is local data, excluded from Git, and is created by the
API as needed. The migration did not move or modify installed-app user data.

## Preserved work and history

The migration verified 1,662 desktop/website source files byte-for-byte immediately
after transfer, before applying path/configuration changes. Desktop tracked paths
were relocated in the Git index with their original object IDs; existing working
changes and untracked files travelled with the directories.

Original website history is preserved in the local branch
`archive/website-before-monorepo`, at the original a47c194 commit. It is an archive
branch, not a claim of rewritten per-file ancestry under apps/website. Keep/push
that branch when retaining the archive on a remote. No remote push was performed.

The original website checkout, including its .git directory and uncommitted work,
is retained at `C:/Users/ahmed/Documents/vibeTerminalwebsite.backup-20260911`.
The old `vibeTerminalwebsite` path is a compatibility junction to apps/website.
Git history bundles, the original desktop index, and source hashes are retained
locally under `.tmp/monorepo-migration-20260911`.

Ignored root junctions for backend, frontend, preload, shared, build, vendor and
desktop script groups preserve legacy local lookups and running processes. These
are aliases, not duplicate source or requirements for a fresh checkout. New work
must use apps/desktop. The desktop updater check explicitly reads root engineering
docs and does not depend on the local desktop/docs convenience junction.

Old ignored node_modules, dist, release and diagnostic folders at the repository
root were retained for running processes and historical artifacts. Fresh builds
use the independent installations and outputs inside apps/.

## Verification

- Fresh locked dependency installations in both app directories.
- Desktop and website production builds passed.
- 58 desktop frontend tests, 29 performance tests, and 2,072 Orchestrator tests passed.
- Website/docs/API tests and root dependency/branding boundary checks passed.
- Actual isolated Electron first-run settings, project creation, native history,
  draft/send, and saved-setup startup checks passed from apps/desktop.
- Updater installer-success/failure smoke and eight navigation checks passed.
- Workflow YAML parsed with the expected app working directories.
- Shared SVG → PNG/ICO export and consumer synchronization passed.
- The website launched from apps/website and opened in Chrome on port 5174.

The mobile app was added later and verified separately: `npm run typecheck:mobile`
and `npm run build:mobile` passed from the root, the latter exporting 1.4 MB
Hermes bundles for both platforms into apps/mobile/dist; root `npm test` passed
with the mobile app included in the per-app independence and brand-parity checks
plus five mobile configuration checks; the extended brand export left the existing
512px PNG and Windows ICO byte-for-byte identical and added two 1024px exports;
repeated brand synchronization was byte-stable. The app has not been run on a
device or emulator, no native or store build exists, and the mobile workflow has
not executed yet. See `docs/mobile-app.md`.

Verification exposed one lifecycle fixture that assumed asynchronous preparation
arrival order matched request order. The fixture now releases preparation by pane
ID; its independent-pane check and the full suite pass. Desktop runtime behavior
was not changed to hide the issue.

The move updates source, tooling and CI definitions. A Windows installer was not
rebuilt or published, and the installed application was not replaced.

Migration paths, app snapshots, root tooling, and related documentation are staged
for review. No commit or push was made. The staged app snapshots include the
pre-existing feature work that was already present before the directory move.
