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
- The hosted Windows workflow must also pass the full gate, installer/feed verification and packaged runtime checks before publication.

## Publication

Pending publication of tag `v0.1.127` and verification of the public installer and update feed.

Installed applications keep running until their user chooses Update / Restart. This release does not replace the local installation or modify its active profile. Automatic Orchestrator settlement of every failed Codex turn remains outside this repair, as documented in the source investigation.
