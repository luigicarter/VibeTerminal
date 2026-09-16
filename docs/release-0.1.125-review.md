# Release 0.1.125 review

Publishes the source fixes documented in [the Orchestrator prompt review](orchestrator-prompt-review-2026-09-15.md): unsolicited default-on warm spares, first-startup identity and duplicate ownership, existing-pane targeting and negative answers, dropped compound clauses, routing-title answers, blank-opening retries, handle compiler wiring, and launcher/payload preservation.

## Acceptance

- The release rerun exposed a shutdown race: an auto-routing test's profile removal failed with `ENOTEMPTY`, leaving the agent-store backup behind. Pane memory coalesced an update in a promise finalizer after `dispose()` had captured the agent store's current flush queue. Added a pane-memory drain, awaited before the final agent-store flush, and a deterministic regression that holds both writes separately. The cleanup assertion was not weakened.
- The implementation review passed 2,016 mocked Orchestrator/native-selection tests, TypeScript checking, renderer production build, and `git diff --check`.
- The release candidate passed **2,017/2,017** Orchestrator/native-selection tests after the persistence fix, **67/67** frontend tests, **3/3** repository-boundary tests, and the versioned production renderer build/typecheck.
- The production publication request retains the user's constraint against opening additional local terminals. Native/Electron acceptance and installer packaging therefore run in the existing hosted Windows release workflow, with its complete release gate unchanged.
- The release increments only the desktop package and its lockfile to 0.1.125. README/download documentation and release notes match that version. No account, website or mobile feature is enabled.

## Publication

- Release commit `65ff7b7af7cc4025af13656cf96287a1f1945a2d`, tag `v0.1.125`, pushed atomically with `main`.
- [Windows release run 35094514113](https://github.com/luigicarter/VibeTerminal/actions/runs/35094514113) completed successfully. All **59 release checks** passed, including the full Orchestrator gate at **2,557/2,557** tests. Installer/feed verification, bundled voice inference, packaged Open Codex, workspace, pane closure, navigation, task UI, microphone/voice, and history checks all passed before publication.
- [Public release v0.1.125](https://github.com/luigicarter/VibeTerminal/releases/tag/v0.1.125) published September 16, 2026 at **12:32:47 UTC**, neither draft nor prerelease.
- Assets: `latest.yml` (359 bytes), `LinaTerminal-Setup-0.1.125.exe` (**533,243,506 bytes**), and its blockmap (533,819 bytes).
- The unauthenticated public `releases/latest/download/latest.yml` resolves to **0.1.125**. The downloaded installer matches its declared size and SHA-512: `7+6oB4lK2keq2j2vYRqWSobJNuCx37/mV6wuLBPOp9uciMXKJ1qvBbwIsY/JR5tl0Vm2it5SSGAuaggre9cjvw==`.
- Its SHA-256 is `9906b59e4b6ca046801ab897c08deb4f2712e60f920de49e9ea0f6cfb08c3729`, also matching GitHub's asset digest. The downloaded blockmap is nonempty.

Installed applications continue running until their user chooses Update / Restart. This publication does not modify the active profile or restart the local installation.
