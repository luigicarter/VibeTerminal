# Release 0.1.127 review

Publishes all pending desktop fixes documented in [the pane-height and launcher repair](pane-height-and-launcher-routing-2026-09-16.md).

## Scope

- One 520px starting height for new panes, clamped to the available region, with legacy layout migration preserved.
- Shared spoken-launcher parsing and explicit launcher precedence, separate assignment families for Codex/Open Codex/Codex Web, remembered project defaults, and provider-preserving open-new clarification answers.
- Broader direct terminal-status replies, launcher-choice diagnostics, regression fixtures, and bounded provider stream-error details in Open Codex.
- Desktop package and lockfile version 0.1.127, matching public download links and release notes. No account, website or mobile feature is enabled.

## Acceptance

- The production renderer build passed.
- The complete local Windows gate passed all **59 release checks**, including **2,587/2,587** Orchestrator tests, **29/29** performance tests, **67/67** frontend tests, **26/26** model-provider tests, and native/Electron terminal, board, voice, history and navigation checks. No gate repair was needed.
- Root `npm test` passed repository boundary checks, website checks and **79/79** mobile tests.
- Compiler-only fidelity passed all 131 saved utterances: 100% precision and recall for the 9 accepted/compilable requests, and 13 in the mobile-workspace variant. No live Brain or external model acceptance run was performed for this release.
- The hosted Windows workflow passed all **59 release checks**, including **2,587/2,587** Orchestrator tests. Installer/feed verification, packaged voice inference, Open Codex console/model routing, workspace/task interfaces, pane closure/process termination, navigation, microphone/voice and history/context checks all passed before publication. No suite in the hosted log reported a failure.

## Publication

- Release commit `32601bd255dfa96ec0060c75ec07f1583753ba5c`, tag `v0.1.127`, pushed atomically with `main`.
- [Windows release run 35299169955](https://github.com/luigicarter/VibeTerminal/actions/runs/35299169955) completed successfully. The Windows job ran for **20 minutes 25 seconds**.
- [Public release v0.1.127](https://github.com/luigicarter/VibeTerminal/releases/tag/v0.1.127) published September 18, 2026 at **02:44:14 UTC** (September 17 in Toronto), neither draft nor prerelease, and is the latest release.
- Assets: `latest.yml` (359 bytes), `LinaTerminal-Setup-0.1.127.exe` (**533,251,246 bytes**), and its blockmap (533,969 bytes).
- The unauthenticated public `releases/latest/download/latest.yml` resolves to **0.1.127**, with `releaseDate: '2026-09-18T02:41:14.361Z'`. The downloaded installer matches its declared size and SHA-512: `d1Wpx2J4fPNFhFx1SUTwBwZoXJJaf45FzJmuff91e5nyV6ifCgHFJKLpCvEcIJcJ+emlDLsqpHI+1os3q6dRIw==`.
- Its SHA-256 is `215d44a770ed89015766c317c5db0e46e6ccb225f6319d45be06014a71caf25c`, also matching GitHub's asset digest.

Installed applications keep running until their user chooses Update / Restart. This release does not replace the local installation or modify its active profile. Automatic Orchestrator settlement of every failed Codex turn remains outside this repair, as documented in the source investigation.
