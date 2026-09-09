# Current conversation error audit

September 9, 2026, covering the Toronto 12:43–12:48 conversation. The inspected
installed application and checkout were both 0.1.105. The relevant installed
Orchestrator, intent, budget, submission, readiness and completion modules matched
source after newline normalization. Evidence came from the private saved
conversation, action receipts and rotating diagnostic log; no private transcript
or credentials were added to this repository.

## Findings and repairs

- Three short requests stopped during interpretation, before the model call,
  at 49,081, 49,396 and 48,505 serialized bytes against Lina's 48,000-byte input
  ceiling. Saved work-item candidates were included but absent from the context
  compactor. Historical work items now shrink before the recent exchange, while
  exact current instructions, explicit reply context and selected work identity
  remain protected. Selected work items use the existing bounded summary.
- The voice fallback mapped those local refusals to the generic request-failed
  recording. A verified offline `context-limit` clip now names the local cause
  and says that the model call was not sent. It does not claim earlier terminal
  actions were absent. The text error also distinguishes Lina's ceiling from the
  model's advertised context capacity.
- The feature request was misinterpreted as a question about whether the
  Orchestrator could change app settings. Intent guidance now preserves an
  explicit coding-terminal request when the user supplies the desired behavior
  or prompt wording in a clarification. Hypothetical discussion alone still
  grants no effects.
- The Codex task first received a startup timeout, then two stale-screen
  rejections, and finally a written receipt. Production startup allows 60 seconds;
  supported initial operator prompts recover up to twice from explicitly unsent
  stale observations using fresh transport IDs correlated to the original task.
  All original input, process and conversation checks remain enforced. Unknown
  writes are never replayed. The exact live startup screen/delay was not retained.
- After the written receipt, the model responded without the required post-send
  read or finish. The request failed despite later activity reporting. Lina now
  supplies the routed handoff observation. The model gets one opportunity to
  review that screen for a necessary clarification, then the existing verified
  finish machinery can settle delivery without another model-authored read or
  finish. Agent-result monitoring and dependencies remain separate from handoff
  completion. Changed identities, pending input and unresolved questions cannot
  receive a fabricated success.

## Verification

- All 1,889 backend tests passed, including new context/history, omitted-read,
  startup retry, original-action deduplication and local-audio regressions.
- Existing clarification/result lifecycle and failed-sibling tests remain active.
- Build/type checking passed. Vite retains the existing bundle-size advisory.
- The real PTY/decoder startup fixture observed no input at shell, loading or
  disabled-composer stages, then exactly one complete prompt after readiness.
- Three configured-model acceptance cases passed with twenty synthetic historical
  work items: a new listening-cue task, clarification-based feature submission,
  and a new Claude full-screen task. Each used five model calls, created one
  worker and submitted one prompt; all serialized model inputs stayed within
  48,000 bytes. Combined reported cost was $0.00491182. These tests use synthetic
  projects, terminal adapters and history, not the user's repositories or panes.

Local evidence: `.tmp/orchestrator-current-conversation-tests.log`,
`.tmp/orchestrator-current-conversation-build.log`,
`.tmp/orchestrator-startup-prompt-smoke/1788973483843-26668/`, and the three
`.tmp/orchestrator-recovery-live/` reports under `1788973443231-14756`,
`1788973480218-35420` and `1788973482606-33332`.

These are source repairs. The user's installed application and saved task
history were not replaced or rewritten; applying a new build is a separate step.
The audio-feedback UI changes concurrently present in the workspace belong to
the separate delegated feature task and are preserved.
