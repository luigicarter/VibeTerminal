# Lina website and identity overhaul — September 10, 2026

The final visual direction is graphite, silver, and restrained cool accents. The earlier green theme is replaced throughout the website. The primary Lina identity is an original geometric L/cursor mark designed as SVG, with raster and Windows icon exports.

## Product coverage

The site has six pages:

- Home: workspace screenshots, Orchestrator, voice, Fusion modes, platform, download, and release-news signup.
- Agents & Workflows: supported tools, local projects, layouts, handoffs, saved setups, and the difference between individual agents, paired models, and workspace orchestration.
- Orchestrator: routing, session activity, task ownership, examples, voice, and setup.
- Voice: Hey Lina, Space/mouse push-to-talk, automatic answers, playback interruption, dismiss/mute controls, microphone setup, and local/cloud boundaries.
- Fusion: the planner/executor/review workflow with Claude and Codex.
- Open Fusion: connected providers, model pairing, and comparison with Fusion.

Copy is based on the desktop repository's current README and Orchestrator, voice, terminal, Fusion, and Open Fusion documentation. No invented performance comparisons or claims of fully local AI processing are included.

## Motion and interactive illustrations

- Entrance fades use IntersectionObserver and transform/opacity transitions.
- Navigation underlines, cards, buttons, and screenshot transitions use small, consistent movements.
- The Orchestrator routing illustration switches between delegation, progress, and continuation examples.
- The four-stage voice walkthrough supports play, pause, replay, and direct keyboard-accessible stage selection.
- Voice waveform animation runs only during the visible, playing walkthrough. It stops when playback stops, the page is hidden, or reduced motion is requested.
- Operating-system reduced-motion preference disables movement and gives the voice walkthrough a manual Next stage action.
- The illustrations are explicitly labeled examples. They neither record audio nor send requests.

## Logo rollout

The canonical website mark is `frontend/public/brand/lina-mark.svg`, with a transparent symbol, 512px PNG, and a seven-resolution ICO (16, 24, 32, 48, 64, 128, 256).

The desktop app uses `frontend/assets/lina-logo.png` in the renderer and `lina-logo.ico` for the window and Windows packaging configuration. Legacy filenames also contain the new mark for compatibility. SVG source is present in the desktop asset directory.

`scripts/export-brand.cjs` exports the SVG through an isolated Chromium renderer and produces PNG and ICO files for both repositories. It does not generate the logo with AI or edit existing bitmap artwork.

Desktop source and installer configuration are updated. No release or installation was performed; an already-installed app acquires the identity when built and updated.

## Screenshots

All five screenshots are fresh 1440×920 captures of the built desktop app, with the new logo:

- Workspace: an isolated local project with actual shell commands, sample Node tests, file listing, and a local HTTP server.
- Orchestrator: the real dashboard, supplied demonstration sessions with representative states. No model requests.
- Voice settings: actual settings UI with empty credentials. No microphone enabled. Its native dialog requires a transparent, unfocused compositor window to capture correctly.
- Fusion: the app's deterministic build-status demonstration.
- Open Fusion: its actual first-run provider/model setup interface.

Captures are in `frontend/public/screenshots`; `scripts/capture-app.cjs` recreates them. Demonstration fixtures do not represent production agent work or Lina's test results. All PNGs were visually inspected. The Orchestrator website page was also rendered in the user's existing browser.

## Setup and verification

- npm workspaces and existing dependencies are preserved.
- One-command dev server runs frontend and backend; production Express serves all six routes and the same-origin API.
- Download selection finds the Windows installer, with GitHub Releases as fallback.
- Signup retains the existing local JSON store. No email delivery service is configured.
- Website and desktop production builds pass.
- Site checks cover installer/fallback selection, all routes, JS/CSS, screenshots, brand assets, API health, validation, persisted signup, and duplicates using isolated test data.
- Windows ICO resolution entries and PNG dimensions were checked.
- Responsive CSS and keyboard controls are implemented; no claim is made of a complete browser/device or physical-audio test matrix.

## Pricing page

`/pricing` is a standalone route linked in both header navigation and footer. Its three cards are Base (local workspace), All Terminals (Base plus every listed agent/terminal mode, including Open Codex and Codex Web), and Orchestrator (All Terminals plus routing, voice/text, and the dashboard/work history).

No prices, billing periods, checkout, or app entitlements were invented. Until amounts are supplied, the page is clearly labeled as an upcoming plan preview and links to the existing updates signup. Provider accounts and usage are separate. The website now serves seven routes; production build and route/API checks passed after the addition.

## End-user documentation

The website now also includes `/docs` and 14 nested guide routes. Its separate documentation layout includes an introduction, quick start, grouped sidebar, full-content search, on-page outline, deep links, copyable commands, screenshots, and next/previous navigation. See `docs/documentation.md` for content ownership, current-source evidence, and checks.
