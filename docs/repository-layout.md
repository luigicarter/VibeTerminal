# Repository layout and migration

Lina's desktop application and website live in one Git repository with separate
dependency installations, build outputs, runtime configuration, and release paths.

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
packages/brand/        Canonical shared logo and exports
docs/                  Desktop and repository engineering documentation
scripts/               App command forwarding and shared brand tooling
```

## Commands

Run these from the repository root:

| Command | Purpose |
| --- | --- |
| `npm run setup:desktop` | Install the desktop app's locked dependencies |
| `npm run setup:website` | Install the website's locked dependencies |
| `npm run setup` | Install both apps |
| `npm run dev:desktop` | Desktop development, renderer on 5173 |
| `npm run dev:website` | Website on 5174, API on 3001 |
| `npm run build:desktop` | Type-check and build the desktop renderer |
| `npm run build:website` | Type-check and build website frontend/API |
| `npm run start:website` | Serve the production website/API on 3001 |
| `npm test` | Repository boundaries, branding, website and docs checks |
| `npm run test:desktop` | Desktop frontend and Orchestrator suites |
| `npm run brand:sync` | Synchronize brand exports into both apps |
| `npm run brand:export` | Regenerate PNG/ICO from the canonical SVG |

Existing desktop npm script names remain available at the root through a runner
that sets the app working directory and forwards arguments. Inside either app,
its normal npm commands still work. Root npm has no runtime dependencies; each
app keeps its own package-lock.json. The website retains its frontend/backend npm
workspaces. Native desktop dependencies are not hoisted into website installs.

## Build and deployment boundaries

The Windows workflow and model-drift workflow run from apps/desktop. Windows
release version checks read the desktop package, and installer output is under
apps/desktop/release. Failure-artifact paths follow the new location. The website
has its own path-filtered CI workflow, dependency cache, build, tests and artifact.
Website changes do not create desktop releases. No deployment was triggered by
this migration.

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

Verification exposed one lifecycle fixture that assumed asynchronous preparation
arrival order matched request order. The fixture now releases preparation by pane
ID; its independent-pane check and the full suite pass. Desktop runtime behavior
was not changed to hide the issue.

The move updates source, tooling and CI definitions. A Windows installer was not
rebuilt or published, and the installed application was not replaced.

Migration paths, app snapshots, root tooling, and related documentation are staged
for review. No commit or push was made. The staged app snapshots include the
pre-existing feature work that was already present before the directory move.
