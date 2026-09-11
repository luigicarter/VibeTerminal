# Resume the latest chat after clearing a terminal

Status: implemented September 11, 2026. Verified in source and a local Windows
package; the installed application has not been replaced or a release published.

## Implemented behavior and verification

Claude, provider-isolated Claude, Codex, and Open Codex now use the owning CLI's
native `SessionStart` signal to propose a selected conversation. The Node and
PowerShell observers carry invocation identity and capture event time before
reading input or sending callbacks. Open Codex claims its invocation before
spawning the native binary so an early session hook cannot outrun ownership.

The runtime verifies the exact candidate in the correct provider home, publishes
pending/confirmed selection state, and retires the previous root from automatic
resume. It fences delayed hooks and metadata by selection revision, preserves
background-child ownership, and rejects unordered competing selections. A later
prompt delivered before its earlier SessionStart callback is replayed for the
verified root. Old queued input cannot become valid again after A -> B -> A.

App-level persistence captures selections while panes are hidden, including an
ID still awaiting transcript confirmation. Restore verifies that ID and never
substitutes the older `resumeRef`. Native panes' Resume last action now prefers
the current conversation; failed or superseded stops cannot replace it.

Acceptance completed:

- The focused `npm run test:chat-resume` suite, session persistence checks, and
  terminal runtime smoke pass. New cases cover generated observers through the
  authenticated callback, successive clears, delayed events, partial metadata,
  duplicate ownership, real child settlement, selection uncertainty, stale input,
  and stopped/superseded resume actions.
- A broader 1,637-test regression run passed. After subsequent refinements, the
  affected 92-test lifecycle/routing/input/Open Codex group and focused selection
  tests passed. Logs are in `apps/desktop/.tmp/chat-selection-regressions.log` and
  `chat-selection-final-regressions.log`.
- Actual Windows PTYs ran Claude 2.1.268, global Codex 0.154.0, and bundled Open
  Codex 0.144.0 against a loopback model fixture, with isolated homes and workspace
  directories. Each created A/B/C, exited, restored C's distinctive transcript,
  and completed a resumed turn whose native ID was C. Provider-isolated Claude
  also passed. There were no live provider-account/model calls.
- Native evidence: `apps/desktop/.tmp/native-chat-selection/1789143149713-44228`
  (Claude/Codex), `1789143574197-32012` (Open Codex), and
  `1789143875246-21408` (provider-isolated Claude).
- The Electron resume fixture tests 28 panes across two actual app processes,
  including hidden A -> B -> C transitions and a pending C saved before exit.
  It verifies exact CLI resume commands after reopening. The same fixture can
  load the packaged app using `LINA_RESUME_TEST_PACKAGE`.
- Type checking, Vite production build, and an isolated Windows directory package
  passed. Package location: `apps/desktop/.tmp/chat-selection-package/win-unpacked`.
  The final package passed the 28-pane/two-process fixture in
  `apps/desktop/.tmp/session-resume-smoke/1789144333132-47080`; all 18 checked
  backend/renderer files matched the final source/build byte for byte. The last
  lifecycle/selection refinement also passed its 32-test affected suite, recorded
  in `apps/desktop/.tmp/chat-selection-final-lifecycle.log`.

Provider boundaries:

- Claude emits `clear`/`resume`; the tested Codex versions emit `startup` on `/new`
  and `resume` on restoration. Only supported native signals with the owning
  invocation are eligible; compaction and background forks do not select roots.
  Claude's signal semantics are documented in the
  [official hooks reference](https://code.claude.com/docs/en/hooks#sessionstart).
- Codex defers the observed session-start hook until a prompt. The native
  acceptance sequence includes an actual turn in each chat. An empty `/new`
  before any prompt has no observed replacement selection and is not certified
  by this fix. A received but not yet persisted candidate is handled separately
  and cannot fall back to the old chat.
- Global Codex 0.154.0 displayed a native seven-hook review on resume in its
  isolated fixture. The fixture accepted only its own generated commands. Exact
  default hook trust separately passed native `hooks/list` checks for 0.154.0 and
  0.144.0; this does not claim that every native resume suppresses that review.
- Disabled/unsupported hooks and already stale saved records cannot be repaired
  by guessing from folder recency. Existing running terminals need the updated
  build's instrumentation. Tests do not certify other CLI versions or live model
  behavior.

## Required behavior

When one terminal runs chat A, the user clears it and works in chat B, then clears
again and works in chat C, closing and resuming must restore C. Switching projects,
hiding the pane, completing a turn, and reopening the application must preserve
that selected conversation. Earlier chats remain available in saved history.

Initial scope: standalone Claude and Codex terminals. Exercise provider-isolated
Claude and Open Codex through their existing adapters. Fusion/Open Fusion settings
fallbacks are separate defects and are outside this fix.

## Evidence

An isolated reproduction executed the generated Claude/Codex observers and runtime
code from the installed 0.1.113 package and the current workspace. After events
for A, B, and C, both retained A with binding `found`, classified B/C as children,
and issued metadata confirmations only for A. The installed renderer restores the
saved current reference. This establishes the code failure; it was not a live
clear/reopen test against the user's accounts.

Relevant implementation:

- `apps/desktop/backend/terminalRuntime.cjs`: `bind` refuses replacement IDs;
  `isChild` treats any different ID as a child; identity confirmation runs only
  while unbound; metadata refresh confirms the old ID once bound.
- `apps/desktop/backend/agentTelemetry.cjs` and `providerHookMetadata.cjs`:
  ordinary Claude/Codex hooks report a session ID without selected-root proof.
  Claude settings currently omit `SessionStart`; Codex's configured lifecycle
  event list also omits it.
- `apps/desktop/frontend/App.tsx`, `sessionPersistence.ts`, and
  `terminalLaunchCoordinator.ts`: save and restore the runtime's current reference.
- `docs/orchestrator-cohesion-review.md`: existing ambiguity handling deliberately
  avoids selecting an arbitrary different root. Preserve that protection.

## Original implementation sequence

### 1. Establish the native selection signal

Use isolated PTY fixtures with the actual supported Claude/Codex binaries to
capture the event sequence for startup, clear/new, resume, compact, and subagents.
Record versions and content-free fields: session ID, event kind/source, native
parent identity, invocation identity, transcript location, and ordering evidence.
Confirm whether the signal occurs at clear time or only on the next prompt.

The vendored Codex source defines `SessionStart` sources `startup`, `resume`,
`clear`, and `compact`, and separates internal subagent starts. This is a useful
candidate, not proof that the globally installed CLI has the same behavior.

Use a verified native session-selection event where supported. A different ID,
recent file modification, shared cwd, terminal title, or root metadata alone is
insufficient. Do not choose the newest conversation in the folder.

Gate unsupported CLI versions explicitly. If a version has no trustworthy
selection signal, establish a provider-specific alternative before claiming
support; retain visible uncertainty instead of silently selecting an older chat.

### 2. Carry selection and invocation evidence through telemetry

Extend the generated Node and PowerShell observers, shared metadata parsing, and
authenticated callback validation with the verified event/source fields.

Connect hook callbacks to the owning CLI invocation, not merely the terminal's
launch nonce. Reuse the wrapper's existing invocation/process identity, propagate
it to its hooks, and distinguish nested CLI invocations. Native in-process
subagents still require explicit parent/source verification; inherited environment
values alone do not prove that a hook belongs to the selected root.

Add the supported selection hooks to invocation-local configuration. Include new
Codex observer commands in the existing exact-command trust/hash mechanism.
Keep hooks passive, bounded, and free of prompt/response content.

### 3. Add an explicit selected-conversation transition

Introduce a focused runtime transition reducer, separate from ordinary child and
turn observation. Its logical states are confirmed, pending verification, and
unavailable. Keep the PTY generation and process alive during a native chat switch.

A replacement requires current pane/generation and invocation ownership,
selection evidence, correct provider/home, verified root metadata, and no ownership
conflict with another pane. Verify the exact candidate ID, with bounded retries
when its transcript has not yet been written. An unreadable-store `found` response
with `rootVerified: false` cannot confirm a replacement.

Once a credible replacement is pending, the previous ID becomes historical and
must cease to be an automatic-resume target. On confirmation, atomically publish
the replacement ID/title and a new conversation revision. Ordinary child events,
compact events retaining the same ID, and duplicate selection events do not
replace the root.

Fence asynchronous verification and metadata results by generation, invocation,
candidate, and conversation revision. Delayed old-root activity cannot revert the
selection. Receipt time alone cannot order competing native selection events;
use the ordering evidence established in step 1 or report uncertainty. Deliberate
resume of a previously visited ID must still work with new selection evidence.

Retire the prior conversation's foreground turn, attention, pending input, and
completion eligibility. Preserve surviving old-conversation background work with
its original ownership; do not relabel it as C's work or silently mark it finished.
Validate that queued Orchestrator actions for A cannot be delivered to C and that
new actions can use C after confirmation.

### 4. Persist the selected conversation and handle closure

Update runtime types, renderer consumption, serialization, restoration, and launch
confirmation together. Persist selection status and the exact pending/confirmed
candidate when available. Keep the previous chat reference distinct from the
current selection. A pending/unavailable selection must never serialize A as a
confirmed current chat.

For app close/reopen and CLI exit/restart, resolve the saved candidate by exact ID.
If it is positively missing, start fresh with a clear explanation; if verification
is unavailable, preserve the pending state rather than falling back to A. Closing
while verification is in flight must retain the candidate/status already observed.
Keep persistence driven at App/runtime level so hidden panes receive updates.

Retain existing pane-close semantics: removing a tile does not delete provider
history. Test reopening a removed conversation through the saved-history route
separately from restoring a retained pane or reopening the application.

Maintain compatibility for legacy saved records. Existing stale IDs cannot be
repaired retrospectively from folder recency; replace them only when new trusted
selection evidence arrives. Already-running panes need refreshed instrumentation
before they can provide newly added hook fields.

### 5. Verify the full behavior

Add failing regressions first, then implement the transition and persistence fixes.
Cover the actual generated producers, authenticated callback, runtime, and renderer
persistence together, rather than testing only a fabricated `rootVerified` event.

Acceptance cases:

- A -> clear/new -> B -> clear/new -> C, with real prompts; CLI exit/restart and
  app reopen both restore C by exact ID.
- The same sequence while the pane is hidden or another project is selected.
- Close immediately after the new selection event, with delayed transcript writes
  and metadata responses. An empty new chat never silently resurrects A; document
  and test whether the provider persists empty chats at all.
- Delayed A/B hooks and metadata, duplicate hooks, rapid consecutive clears,
  deliberate resume back to A, and clear/compact commands that retain the same ID.
- Real subagents, nested CLI launches, two panes in one folder, home isolation,
  duplicate ownership, stale generations, and unavailable metadata.
- Surviving background work and queued/checked Orchestrator input during the switch.

Extend the terminal runtime, generated telemetry, native-root ambiguity, session
persistence, launch coordinator, and two-process Electron resume suites. Preserve
ambiguity tests for unproven replacement roots; update the tests that currently
classify every unidentified different ID as a child to distinguish pending roots
from proven children. Run the affected suites, build/type checks, and isolated
Windows PTY/Electron acceptance with the supported native CLI versions.

## Completion criteria

The exact clear/new/work/close/resume sequence passes for supported Claude/Codex
versions, including in a packaged build. Saved state, launched resume command, and
the provider's restored conversation all agree on C. Subagent/ownership protections
and old-conversation input fences continue to pass. Record source, packaged, and
installed verification separately; publication or installation is a later action.

Update `docs/terminal-runtime.md` and the native-identity boundary in
`docs/orchestrator-cohesion-review.md` when implementation and acceptance are complete.
