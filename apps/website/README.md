# Lina Terminal website

A React + Vite marketing site with an Express API for GitHub release metadata and release-news signup. This app lives inside the Lina repository at apps/website; its desktop sibling is ../desktop. Shared branding is owned by ../../packages/brand.

## Local development

Requires Node.js 22+ and npm. From this folder:

```powershell
npm ci
npm run dev
```

Open http://127.0.0.1:5174. The frontend proxies `/api` to the local backend on port 3001. Both services run together; Ctrl+C stops them. Existing `dev:frontend` and `dev:backend` scripts remain available.

## Production

```powershell
npm run build
npm test
npm start
```

Open http://localhost:3001. Express serves the built frontend, every product page, screenshots, and API from the same origin. For public hosting, run this Node service behind your normal HTTPS proxy and use persistent storage for the signup file.

## Pages

- `/` — Workspace overview, screenshot gallery, Orchestrator, Fusion modes, platform, Windows download, and release-news signup.
- `/agents` — Agentic workflows, supported coding tools, project organization, layouts, handoffs, history, and setups.
- `/docs` — Complete user documentation with 15 guides, search, section outlines, commands, and troubleshooting.
- `/pricing` — Three upcoming plans: Base, All Terminals, and Orchestrator; prices pending confirmation.
- `/voice` — Hey Lina, push-to-talk, natural answers, playback controls, setup, and an interactive walkthrough.
- `/orchestrator` — Task routing, session dashboard, voice and text control, request examples, setup, and provider requirements.
- `/fusion` — Claude/Codex planning, execution, and review.
- `/open-fusion` — Bring-your-own-provider pairing and comparison with Fusion.

Download buttons select the Windows installer from the live GitHub release assets. If release lookup fails or an installer is absent, the buttons open GitHub's latest-release page.

## Configuration

Copy `backend/.env.example` to `backend/.env` when overriding the backend defaults. `frontend/.env.example` documents the optional external API base URL; same-origin `/api` is the default.

The signup endpoint stores addresses in `backend/data/waitlist.json` by default. It does not send email; an email delivery provider is not configured. Keep this data on persistent storage and run one API process per signup file. Writes are serialized and replaced atomically; invalid existing data is preserved. Multiple API replicas need a shared database instead of this file store.

## Screenshots

The images in `frontend/public/screenshots` are captures of Lina Terminal, with demonstration workspaces; no generated UI images are used.

- Workspace: actual isolated local terminal sessions, a Node test run, project file listing, and a small local HTTP server.
- Fusion: the app's deterministic build-status fixture.
- Open Fusion: the app's provider-connection and model-selection screen.
- Orchestrator: the app's isolated dashboard with demonstration sessions, showing representative provider states.

To recapture the app views using a built Lina app checkout on Windows:

```powershell
node scripts/capture-app.cjs ../desktop split
node scripts/capture-app.cjs ../desktop fusion-builds
node scripts/capture-app.cjs ../desktop openfusion
node scripts/capture-app.cjs ../desktop orchestrator
node scripts/capture-app.cjs ../desktop voice-settings
```

Build the desktop app first with its own `npm run build`. The capture helper uses an isolated profile, hidden windows, and disposable demo folders under this website's ignored `.tmp` folder. It leaves the user's running desktop sessions alone.

Branding, motion, and screenshot provenance are documented in `docs/ui-overhaul.md`.

## Validation

`npm run build` checks TypeScript for both workspaces and builds the site. `npm test` verifies installer selection, all marketing and documentation routes, built assets, screenshot files, and signup validation/persistence using an isolated test store.
