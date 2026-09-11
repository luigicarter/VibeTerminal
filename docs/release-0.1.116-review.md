# Release 0.1.116 review

This release combines the desktop/website repository split with shared model
settings, Open Codex, native Codex Web, current-conversation resume tracking,
Fusion menus, Git branch inspection, and the scoped Orchestrator harness work.
The unchanged directory moves were separated from content changes during review.
The previous public release was 0.1.113: 0.1.114 failed and 0.1.115 was cancelled.
Those tags remain intact.

## Repairs found during release review

- Resizing a wrapped terminal exposed an xterm 5.5 zero-scrollback reflow bug:
  its screen decoder could reference a missing row and crash the main process.
  One spare decoder row prevents that condition while keeping screen/history
  reads bounded. A small deterministic regression reproduces the original
  exception and verifies the complete redraw after narrowing and growing.
- Open Codex released its provider adapter on any nested process exit. Cleanup
  now requires the owning native invocation. A regression exercises the actual
  main-process telemetry handler and runtime, including stale generations.
- Concurrent website signups could overwrite earlier entries. The API now
  serializes writes, atomically replaces the file, validates input types, and
  preserves malformed existing stores. Parallel requests and recovery are tested.
- The Windows workflow retained old artifact and release-note paths. It now
  uses the desktop app paths, initializes the fixture submodule, and prepares
  the new native integrations before testing them.
- Release gates now include the new integrations and packaged native resources.
  Existing fixture assertions were updated for the shared settings, native
  provider list, command palette, links, and image-drop handler.
- Voice acceptance now advertises the scripted relay model's context capacity;
  the expanded agent schema exceeded the unspecified-capacity fixture budget.
  Background-launch acceptance records uncaught decoder errors and retries only
  explicit, proven-unsent screen-freshness refusals during ConPTY startup.

## Acceptance

The desktop and website production builds pass. All 57 release gates passed
locally across the initial run and focused reruns after the repairs. These
include the 59-test frontend suite, 2,072-test backend suite, new Codex native
fixtures, provider migration, Fusion menus, Git inspection, voice, and terminal
process/lifecycle checks. The final decoder repair additionally passed its
24-test observation/resource/performance group and the previously failing
background-launch Electron scenario.

Local installer/feed hashes, both additional Codex native payloads, the Web
runtime manifest, and all voice resources were verified. Packaged voice
inference, workspace startup, and the 28-pane/two-process resume fixture passed.
Final package closure and navigation also passed, including descendant process
termination and project-file preservation. All 169 packaged backend, preload,
shared, and renderer files matched the final source/build. Task UI, real
Electron voice transport/playback, and history/context acceptance passed.
The tagged production workflow must pass before publication. Logs are retained
under `.tmp/release-review-20260911`.

The website has independent build/test output. Its production host is a separate
deployment decision. Native and Electron fixtures use isolated homes and local
model endpoints; they do not certify every live provider/account combination.
