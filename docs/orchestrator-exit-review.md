# Terminal exit and Orchestrator chat review

## Recorded incident

Reviewed the installed app's saved conversation and private diagnostic log for
September 7, 2026. The running executable was vibeTerminal 0.1.100, whose bundled
Orchestrator/PTY modules differ from the working source. No user terminal was
interrupted or restarted during this review.

| Toronto time | Recorded behavior |
| --- | --- |
| 18:30:41–18:30:59 | A prompt request was rejected first for a stale observation, then an occupied input buffer. The operator reported itself blocked. |
| 18:31:43–18:31:57 | The user asked to clear that text. One native control request was rejected for unsupported arguments; another was accepted. The Orchestrator claimed the buffer was cleared and asked again whether to send the earlier task. |
| 18:32:30 | The user reported that the clearing operation had exited the coding agent. |

The relevant request IDs are `59c57c4d-0a51-410a-928d-a832539c333e` and
`359f1164-abc9-4bfe-8aca-425ea1cc7a89`. The affected pane was
`session_oppqpxm_mtrtd2fs`, generation `eb9d1410-4359-44fb-a25b-b122bb99e679`.
The accepted key sequence was not logged, so its exact shortcut cannot be
established retrospectively. The occupied-buffer receipt also cannot distinguish
actual draft text from stale input bookkeeping.

## Confirmed gaps and repairs

- **Clearing could use quit controls.** Generic operator input permitted Ctrl-C,
  Ctrl-D and other exit/suspend-capable controls for an editing objective.
  Vendored Codex implements repeated Ctrl-C/Ctrl-D quit behavior. Operator grants
  now default to preserving the agent; interruption or exit requires its own
  immutable lifecycle authority. Clearing never grants that authority.
- **A shell prompt could masquerade as successful clearing.** A fresh observation
  of the outer PTY could be accepted after the coding agent exited. Successful
  preserving operations now check that the native agent remains alive with the
  same PID. An explicitly authorized exit remains supported.
- **Interrupts could repeat across steps.** Managed-agent interruption now needs
  an observed active turn and permits one dispatched interrupt for that turn.
  Proven-unsent attempts may retry; unknown writes remain non-replayable.
- **Blocked goals were discarded.** A blocked finish consumed its target and
  removed the original request from unfinished work. Blocked targets now retain
  their objective, effect claims and budgets, allowing an authorized recovery
  to continue the original request without reconstructing delivered actions.
- **Exited agents could leave waits running.** An unresolved managed task now
  reports an unverified failure when its agent exits within the same PTY
  generation. Attributed turn endings take precedence over process exit.
- **Valid key names were case-sensitive.** A live model reproduced rejected
  `Ctrl-E`, `Ctrl-U` and `Backspace` arguments, then drifted into unrelated
  searches. Named controls are normalized before authorization and replay
  fingerprints. This does not expand the key vocabulary or bypass quit guards.

Private control diagnostics now preserve bounded allowlisted key names, edit
intent, lifecycle authority and process states. Prompt bodies, raw terminal input
and transcripts remain excluded.

## Verification limits

The configured Brain passed the repaired `safe-clear-input` scenario, using
non-exit editing keys to empty the fixture editor and report that Codex remained
open. The first live run reproduced the key-casing failure; the successful rerun
is recorded under `.tmp/orchestrator-conversation-live/1788821910947-54052/`.

Regressions cover clearing without quit shortcuts, post-edit agent death/PID
change, explicit exit, repeated interrupts, proven-unsent retry, blocked-goal
continuation, key casing/replay identity and stopped-task reporting. Broader
Orchestrator, build, terminal runtime and hidden Electron/preload/PTY checks are
also run. Live model clearing uses a disposable single-line editor adapter;
it does not establish custom keymap or multiline behavior in the user's installed
Codex. These repairs are source changes, not an installation or publication.
