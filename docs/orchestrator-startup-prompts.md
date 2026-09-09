# Orchestrator initial prompt delivery

## Cause

The renderer's creation acknowledgment establishes a pane. PTY `launch-ready`
establishes that the launcher command was written. The agent wrapper announces
its process before resolving/spawning the native CLI. None establishes that a
native prompt composer is ready.

Routing intentionally accepts a running process so the operator can inspect and
handle startup menus. Previously the native input adapter also accepted task text
at this stage. A reproduction combining the real launch and input helpers wrote
the first prompt with `turnState: unknown`, sequence zero and an empty screen.

## Behavior

New Orchestrator-created launches are tracked separately from existing sessions.
Initial task submission or staging for recognized providers waits within the
original action's deduplication and pane lock. Read-only polling observes the
current decoder, with an independent 20-second deadline and cancellation. It
does not send test characters, start another model request, or recreate the pane.

`orchestratorPromptReadiness.cjs` recognizes loaded Codex input, the standard
Claude/Claude-custom composer, and a standard PowerShell prompt. It requires the
current visible cursor at an empty input position and rejects loading, onboarding,
pending user input and clipped current screens. Truncated retained history is
independent of current-screen clipping. `terminalObservation.cjs` tracks cursor
visibility through xterm's public ANSI parser handlers, including split mode
sequences and resets, without consuming xterm's normal processing.
PowerShell prompt recognition joins only decoder-proven soft-wrapped rows, using
cell-aware cursor text so long and wide-Unicode project paths remain usable.

The launch token, generation, recipient PID, known conversation identity and input
revision are retained through the wait. Output may advance; human input cannot be
overwritten. The final transport still checks recipient and screen/input evidence.
Cancellation, timeout or changed identity before writing is explicitly unsent;
uncertain writes remain uncertain and are never automatically replayed.

Ordinary startup controls remain available. Explicitly authorized edits or
submission of an existing draft use the existing ownership checks. Existing
sessions and busy follow-ups are not classified as newly starting merely because
turn telemetry is absent. Structured Fusion/Open Fusion hosts retain their
engine-ready protocol.

## Verification boundary

The real-PTY fixture in `scripts/qa/orchestrator-startup-prompt-smoke.cjs` advances
a local simulated CLI through shell, loading, disabled and ready frames. No prompt
bytes may arrive in the first three phases; the ready phase receives exactly one
complete prompt. It uses no credentials, live model or user terminal.

Backend regressions cover actual directory/decoder/transport integration,
cancellation, hung reads, manual input, replacement launches, uncertain delivery,
deduplication and preserved existing-session controls. The existing cohesion
integration test supplies an actual Codex-shaped ready screen when creating its
worker.

Codex recognition is grounded in existing native captures; Claude's layout is
grounded in bundled source and decoder fixtures, not an authenticated live run.
Other native provider kinds retain the prior semantic operator path. Customized
shell prompts can remain unrecognized. A screen observation cannot guarantee
that a future onboarding overlay will never appear. This is a local source change,
not a packaged or installed release update.

September 8 parent verification passed the renderer build, all 1,629 tests in
`npm run test:orchestrator`, and the focused real-PTY fixture at
`.tmp/orchestrator-startup-prompt-smoke/1788917719454-33236/` (owned child exit
verified). Hidden Electron/background-launch acceptance passed at
`.tmp/orchestrator-background-launch-smoke/1788918108759-6092/`, including a
created PowerShell terminal's first command in a long project path. Its creation
assertions use the structured process/location receipt rather than older reply
wording. The first run exposed the wrapped-prompt gap; decoder regressions and
the final Electron run verified the correction.
