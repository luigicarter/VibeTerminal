# Release 0.1.125 review

Publishes the source fixes documented in [the Orchestrator prompt review](orchestrator-prompt-review-2026-09-15.md): unsolicited default-on warm spares, first-startup identity and duplicate ownership, existing-pane targeting and negative answers, dropped compound clauses, routing-title answers, blank-opening retries, handle compiler wiring, and launcher/payload preservation.

## Acceptance

- The release rerun exposed a shutdown race: an auto-routing test's profile removal failed with `ENOTEMPTY`, leaving the agent-store backup behind. Pane memory coalesced an update in a promise finalizer after `dispose()` had captured the agent store's current flush queue. Added a pane-memory drain, awaited before the final agent-store flush, and a deterministic regression that holds both writes separately. The cleanup assertion was not weakened.
- The implementation review passed 2,016 mocked Orchestrator/native-selection tests, TypeScript checking, renderer production build, and `git diff --check`.
- The release candidate passed **2,017/2,017** Orchestrator/native-selection tests after the persistence fix, **67/67** frontend tests, **3/3** repository-boundary tests, and the versioned production renderer build/typecheck.
- The production publication request retains the user's constraint against opening additional local terminals. Native/Electron acceptance and installer packaging therefore run in the existing hosted Windows release workflow, with its complete release gate unchanged.
- The release increments only the desktop package and its lockfile to 0.1.125. README/download documentation and release notes match that version. No account, website or mobile feature is enabled.

## Publication

The v0.1.125 tag triggers `.github/workflows/windows-release.yml`. Installer publication is conditional on its release checks, packaged-runtime checks, and artifact/feed verification. Final workflow and public-feed evidence will be recorded here after completion.

Installed applications continue running until their user chooses Update / Restart. This publication does not modify the active profile or restart the local installation.
