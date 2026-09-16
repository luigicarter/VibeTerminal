# Codex's idle sparkle, and the one input-surface fence that replaced the byte counter

September 13, 2026. Three Orchestrator requests at an idle Codex pane failed in a
row on the installed 0.1.123: one `input-buffer-occupied` ("may contain unsent
user input" while the composer was visibly empty), seven `stale-observation`
("changed while I was about to type"), then the generic "I couldn't do that in
that pane". Nothing was ever typed.

Neither refusal was about the pane. Both were about how the application decided
the pane had changed.

## What Codex 0.154 does while it sits idle

Codex CLI 0.154 added `tui/src/bottom_pane/chat_composer/sparkle.rs`: an ambient
twinkle around the **empty** composer. Upstream gates it on TrueColor, the
`whimsy` and `animations` settings, no open popup, and a model name matching
`astra` — and the user's default is `gpt-6-astra`, so it is on.

Measured here, with node-pty on the bundled ConPTY, against the installed 0.154:

| | idle 0.144 | idle 0.154, sparkle on | idle 0.154, `-c tui.whimsy=false` |
| --- | --- | --- | --- |
| PTY chunks in a 2 s idle window | 0 | **40** | **0** |
| distinct decoded input surfaces over 50 reads | – | **1 settled (45/50)** | **1 (50/50)** |
| bytes over 50 s | 0 | ~322 KB | 0 |

Each frame is a synchronized update (`CSI ?2026h … ?2026l`, ~1 KB) that recolours
about thirty braille cells on the composer rows and ends with the per-frame
cursor-style repair (`CSI 0 SP q`) that produced the "floating insertion cursor"
in `docs/codex-cursor-flicker-2026-09-11.md`. Same frame loop; second symptom.

Two details only a real recording shows:

- **The sparkle owns the separator cell.** In 35 of the 92 frames of a recorded
  14-second idle stream, a dot landed in the one cell between the `›` pointer and
  the caret, so the composer prefix read `›⠁` instead of `› `. Any check that
  compares that cell flaps several times a second.
- **The caret is parked while a frame paints.** Codex moves the caret out onto
  the composer's wrapped decoration row to draw, and restores it a chunk later.
  Five of fifty live reads caught it there — on a real terminal, not a replay.

The sparkle's alphabet is exactly eight single-dot glyphs (`⠁⠂⠄⠈⠐⠠⡀⢀`). Codex's
startup spinner uses different ones (`⠙⠹⠸⠼⠴⠦⠧⠇`) and never occupies a composer
cell, so the eight are normalised to a space before any composer or surface
comparison and nothing else in the braille block is touched.

`docs/codex-cursor-flicker-2026-09-11.md` said an idle 0.154 composer emits no
bytes. That was true of the build measured then and is wrong for 0.154; it has
been corrected. For the launch-time switch that turns the animation off, see
`docs/codex-idle-sparkle-whimsy-override-2026-09-13.md` — the fence below never
consults it, because other providers animate too and users run whatever build
they have.

## Why the old fence could not survive it

`session.sequence` counts **PTY output chunks**. It was the freshness fence in
two places — `orchestratorTerminalInput.cjs` compared it to the number the model
echoed back, and `ptyHost.cjs` compared the same number to its own counter — so a
pane that repaints itself was permanently stale for every non-busy send. The busy
turn had an exemption; the idle case had none; the only retry was startup-scoped.

On top of that, the model was asked to copy two numbers (`observationSequence`,
`inputRevision`) out of a read and back into its next action. That is a contract
the model can only get wrong, and one of the two numbers was wrong within
milliseconds of being handed over.

## The consolidation

One contract, one enforcement, one predicate, one helper each.

| Was | Is |
| --- | --- |
| `observation.sequence !== action.observationSequence` in the main process | **deleted** |
| `evidence.sequence !== session.sequence` in the PTY host | **deleted**; `sequence` survives only as the `sequenceAtWrite` diagnostic |
| `observationSequence` + `inputRevision` on the model-facing tool, and the "copy exactly" prose | **deleted** from the schema, the intent validator and the operator system prompt |
| the operator token's echo check | the token's **captured input surface** |
| a sequence exemption for busy prompts | none: a working pane's composer row is the surface like any other |
| 6 readiness predicates (`sessionReady`, `processReady`, `nativeReady`, delivery `classify`, busy `healthy`, `isIdleTarget`, `idlePaneCandidate`) | 1 (`backend/orchestratorPaneReadiness.cjs`) |
| 3 inline pane-ownership checks in `orchestrator.cjs` | 1 helper pair in `orchestratorResolver.cjs` |
| 1 startup-only retry loop | 1 helper for every operator input action |
| 3 bookkeeping containers (`queuedInputAttempts`, `routedInputBindings`, `idleInputActions`) | 1 attempt registry |

Counts: readiness predicates 6 → 1; sequence-equality fences 2 → 0; model-echoed
fields 2 → 0; ownership checks 3 → 1; retry loops 1 startup-only → 1 general;
bookkeeping containers 3 → 1.

Lines across the send path (`orchestratorTerminalInput`, `orchestratorDelivery`,
`orchestratorBusyInput`, `orchestratorOperator`, `orchestratorLaunchers`,
`orchestratorTargetAvailability`, `orchestratorToolSchema`, `orchestratorResolver`,
`orchestratorPromptReadiness`, `orchestratorInputAuthority`,
`orchestratorQueuedInputAttempts`, `terminalObservation`, `ptyHost`,
`orchestratorIntegration`, plus the two new modules): **3185 → 3357 code lines,
+172**. The deletions above are real and per-file, but the total went up rather
than down. Where it went: the two new single-source modules (98 code lines), and
the placeholder-aware composer recognizer (+60 in `orchestratorPromptReadiness`),
which is what lets a keystroke latch be overruled without admitting a draft. That
target was not met and is recorded here rather than explained away.

## The input surface

`backend/orchestratorInputSurface.cjs` projects what the user could be typing
into, and nothing else:

```
{ id, generation, cursor:{x,y}, cursorVisible, cols, rows, alternateScreen,
  inputRevision, manualInputPending, interactionInputPending, ownerRequestId,
  line: { startRow, beforeCursor },   // text UP TO the caret, decoration normalised out
  composer: { form, empty } }
```

Deliberately absent, and not to be added: `sequence`, `outputAt`, the screen
text, anything to the **right** of the caret, and the raw neighbouring rows —
that is exactly where ambient animation lives. The per-form recognizer verdict is
the structure check for the surrounding rows.

It is captured once, by the application, at its own read of the pane:

- an operator step carries the surface its `read_session` token captured, which
  also proves the model acted on the screen it was shown;
- a startup send has no composer yet, so the startup wait captures one the moment
  the pane paints it, and carries it into any retry;
- a busy promotion, a trust answer and a user command that answers a pending
  question have no model read, so the application takes one at dispatch.

There is no legacy branch: `inputSurface` is required for every input action, and
tests build it through one shared fixture (`scripts/backend/orchestrator-input-fixture.cjs`).

**Division of labour.** The host proves what only it knows — no input since the
observation (`inputRevision`, now mandatory), same geometry, same live recipient,
same generation, this request's ownership. Main proves what only the decoder can
see — the same input surface. Neither can do the other's half.

**One supersede rule.** A read can land part-way through a redraw. A *prompt
submission* into a composer that is recognizably empty now, at the same geometry,
screen and input revision, is still the same act, so it goes through. Keys and
mouse never supersede: menu navigation means whatever the screen under it means.

**One retry.** A repaint between the read and the write is a screen race, not a
decision for the model. `submitOperatorPrompt` retries the identical prompt under
a fresh transport identity, three attempts, immediately (the next read awaits the
decoder's next batch; elapsed time is never evidence), never after a byte may
have been written and never when the input revision moved. The final refusal
carries `attempts`, and the sentence says so: *"Codex kept changing each of the 3
times I was about to type, so I held off. Nothing was sent."*

## Empty composer, and the keystroke latch

`recognizeEmptyComposer(form, observation)` is the structural half of the startup
assessment without its banner gates — a session header scrolls away, an empty
input cell does not. It returns two verdicts, because two questions are asked:

- `atComposerCell` — the composer is painted and the caret is in its first input
  cell. This is **launch** readiness, and it must tolerate whatever hint copy a
  provider rotates in.
- `empty` — that, **and** everything right of the caret, once the sparkle is
  normalised away and the frame border and blanks are trimmed, is either nothing
  or that form's recorded placeholder (`Ask Codex to do anything`,
  `Try "…"`, `Type your message or @path/to/file`, `Ask anything... "…"`; Kimi and
  Grok print none). This is **input** readiness: it overrules the keystroke latch
  and it is what the fence compares.

Text right of the caret that is not the placeholder is a draft the user walked
the caret back through, so the composer is not empty, the latch holds, and the
prompt is refused as occupied. Codex rotates its hint copy between releases
(0.144 printed `Run /review on my current changes`), so an unrecognized hint
reads as a draft — which refuses a send rather than typing over one.

The latch itself (`ptyHost.cjs`) is unchanged in how it is set: any key that is
not Enter or Ctrl-C marks the pane occupied, and output never clears it. What
changed is that it is now a **hint**: the host clears it only when the write
carries a fresh input revision and main's signed statement that the composer is
empty. Selection stays conservative — a latched pane is not offered as an idle
target and not reused, because passing over one pane costs nothing.

`terminalObservation.read` gained `cursorContext`: the unclipped rows y-2..y+6
around the caret, taken before the model's 4000-character budget clips the screen
text, because a clipped read drops leading rows and silently moves every row a
composer check indexes. The executor strips it from the model-facing observation.

## Where the predicates disagreed, and what was chosen

`backend/orchestratorPaneReadiness.cjs` reports four orthogonal facts —
`process`, `composerVerified`, `named`, `idle` — plus the first reason one is
false. The six predicates it replaced did not agree, so each disagreement was
decided rather than averaged:

- **A live recipient is not a named conversation.** Delivery only ever needed a
  running agent process; launch readiness and pane reuse also need a conversation
  they can name. Those are now two facts (`composerVerified`, `named`), not one.
- **A provisional pane that has never taken a turn is verified.** Requiring a
  confirmed identity made every never-prompted pane permanently unusable.
- **An unrecognized turn state is neither idle nor busy.** It reports
  `unknown-turn`, which callers treat as unverified — what delivery always did.
- **The keystroke latch makes a pane un-idle but does not decide writes.**
  Choosing a pane is conservative; writing into one is decided by the decoder.
- **A pane waiting on a child approval is not "ready".** The old launch label
  read only the root's turn state and called it ready.
- **Structured chat panes have no terminal composer**, so their
  `composerVerified` is their process readiness; their turn facts are still read,
  because delivery queues behind a running chat turn.

## Verified

- `npm run test:orchestrator` — 29 + 2458 passing, 0 failing.
- `npm run smoke:provider-startup` — codex, claude, grok, kimi, kimi-custom,
  qwen, opencode all `ready` + accepted; gemini/cursor/open-codex/codex-web
  skipped as before. Kimi 0.42 now opens on a "Trust this folder?" dialog whose
  first option reads `❯ Trust this folder`; the affirmative-default pattern was
  widened to the three recorded shapes (`❯ 1. Yes`, `● 1. Trust folder (name)`,
  `❯ Trust this folder`) and the screen recorded as `kimi-folder-trust`.
- `scripts/qa/orchestrator-native-submission.cjs` against the vendored 0.154 with
  the sparkle **active** (TrueColor, no `NO_COLOR`, model `gpt-6-astra`): the
  output counter advanced 40 while 45 of 50 surface samples were the same settled
  surface with `composer.empty` true and `beforeCursor` `› `; all four
  submissions were written on the first attempt with deliberately stale sequence
  evidence; an arrow-key latch then took a prompt, and a typed draft was refused
  `input-buffer-occupied`. Re-run with `-c tui.whimsy=false`: 0 chunks, 1 surface
  over 50 samples, same six results.
- The new fence cases fail on the old code: restoring `orchestratorTerminalInput.cjs`
  and `ptyHost.cjs` to HEAD fails 12 of them while the 38 pre-existing cases in
  that file still pass.

## Not verified

- No packaged build and no installed-app run. Everything above is source plus the
  local PTY probes.
- The manual dev-build walkthrough (arrow key then "say hi"; type without Enter;
  resize mid-request) has not been done.
- The placeholder list is evidence, not a specification: only the strings these
  captures recorded are accepted. A Codex release that rotates in new hint copy
  will read as a draft and refuse, until its screen is recorded here.
- Five of fifty live reads still catch the caret parked on a decoration row. The
  supersede rule covers that on the baseline side and the retry covers it on the
  fresh side, and both were exercised live, but the decoder does not yet hold a
  read back to a frame boundary. Codex restores the caret *after* closing its
  synchronized update, so the `?2026` markers alone do not fix it.
- Gemini's trust wording (`● 1. Trust folder (name)`) is transcribed, not
  captured: the CLI is not installed on this machine.
