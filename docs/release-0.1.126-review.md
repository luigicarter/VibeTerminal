# Release 0.1.126 review

Publishes the source fixes documented in [the Orchestrator clarification and partial-launch repair](orchestrator-repair-implementation-2026-09-16.md) and [the more forgiving voice pause](voice-cutoff-repair-2026-09-16.md), together with the Chats section's hidden-by-default switch recorded in [the Chats implementation](chat-section-implementation-2026-09-13.md). Those repairs follow [the incident review](orchestrator-incident-review-2026-09-16.md), [the repair plan](orchestrator-repair-plan-2026-09-16.md) and [the voice cutoff analysis](voice-cutoff-analysis-2026-09-16.md).

## Scope

- Orchestrator: unknown opening names are clarified before interpretation or creation, and the clarification retains the original task and its constraints. A sibling pane's startup failure no longer discards work bound to panes that did start, each work item settles on its own delivery and result waits, retry reuses the originally recovered pane, partial requests publish receipt-derived replies naming each pane once and without a completion cue, and the routing startup gate reports its actual phase and last blocker within a bounded number of records per wait.
- Voice: the 600 ms confidence shortcut is removed. Automatic capture commits after 1,500 ms of classified quiet, and "Pause before sending (seconds)" accepts 1 to 3 seconds, captured per recording and validated on save. Speculative early transcription, resumed-speech invalidation, the uncertain-completion fallback and manual hold/send are retained.
- Chats: the section is hidden by default behind the renderer switch `lina:chats:visible`. The catalog, workspace checkpoints, drafts, recovery and exact native resume keep running underneath, and every existing chat row reappears when the switch is set to `1`.
- The release increments only the desktop package and its lockfile to 0.1.126. README/download documentation and release notes match that version. No account, website or mobile feature is enabled.

## Acceptance

- The local Windows release gate finished with **All 59 release checks passed.** Its final check, the complete Orchestrator gate, reported **2,579/2,579** tests with zero failures, after the 29-test performance suite it chains. The frontend suite reported **67/67**.
- The gate's first run stopped at check 50, `smoke:frontend:voice-experience`, with `TypeError: Cannot read properties of undefined (reading 'defaultPauseMs')`. Its harness transpiles the settings component without `esModuleInterop`, so the new `shared/voiceEndpointing.json` default import compiled to a `.default` lookup on a module that has none. The desktop `tsconfig.json` sets `esModuleInterop` and `resolveJsonModule`, and the production renderer build passes, so this was a stale harness rather than an application defect. Adding `esModuleInterop: true` to that single transpile call in `scripts/frontend/voice-experience-smoke.cjs` fixed it. No application source was changed, and the smoke's assertions were not weakened.
- The repaired check passed on its own, and the gate was then resumed at index 50 through the same runner and the same per-check `npm run` invocation, carrying checks 50 through 58 to the passing total. Checks 0 through 49 come from the first run of the same tree.
- The production publication request retains the user's constraint against opening additional local terminals. Native/Electron acceptance and installer packaging therefore run in the existing hosted Windows release workflow, with its complete release gate unchanged.
- Source-level acceptance for the shipped work is recorded in its own documents: the Orchestrator repair's real-Brain ladder scenario, native Codex Web TUI probe and packaged backend/UI checks, and the voice repair's offline workflow, Electron settings and microphone-capture smokes.

## Publication

Pending: filled after the hosted Windows release run. This section records the release commit and tag, the workflow run and its release-check total, the public release with its timestamp and assets, the unauthenticated `releases/latest/download/latest.yml` resolution, and the downloaded installer's size and SHA-512/SHA-256 verification.

Installed applications continue running until their user chooses Update / Restart. This publication does not modify the active profile or restart the local installation.
