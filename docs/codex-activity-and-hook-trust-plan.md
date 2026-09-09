# Codex activity and default hook trust

September 9, 2026. Baseline: Lina 0.1.104, source commit
`aac91eb2cf02ebe4bd58bcfa748a5817a5bdd569`.

This plan covers the misleading **Awaiting activity** state and repeated trust
reviews for Lina's Codex hooks. The user requested a status-fix plan and automatic
trust for Lina's hooks. All three steps are implemented in the 0.1.105 release
candidate. The follow-up release audit adds generation-scoped pending-turn
display evidence, aligned pane/sidebar/directory/dashboard status, pending-input
details, and explicit unconfirmed lifecycle observation. The installed application
is updated only through the user's normal Update/Restart action.

## Evidence

The [investigation](terminal-status-support.md#codex-awaiting-activity-investigation-september-9-2026)
reproduced Escape followed by Enter, then fresh activity for the existing native
turn. Lina retains a running turn and active tool but displays **Awaiting
activity** and projects the session as idle. Ordinary Enter during proven work
already preserves **Working**.

Six installed Codex lifecycle hooks were configured and their saved trust hashes
matched the installed commands. Direct and Windows shell callback transports
passed. This does not establish which events occurred during the original report.

Lina versions its observer filename by content and includes the executable path
in each hook command. Codex persists trust under positional session-hook keys
and compares the complete command's normalized hash. Updated observer contents,
different installation paths, or alternating development and installed builds
can therefore require another review. An unchanged command should retain trust.

## 1. Trust Lina's exact observer commands at launch

Implemented in `backend/agentTelemetry.cjs`:

- Derive native-compatible SHA-256 trust hashes from the exact six generated
  command definitions, including event, command, timeout and asynchronous mode.
  Verify the cached observer contains the app's expected code before granting
  that trust.
- Supply a trust-only `hooks.state` table through invocation configuration. Use
  Codex's session-flags source identities for Windows and POSIX. Do not persist
  these grants in the user's global configuration.
- Prepend the trust table before user arguments, while retaining the existing
  placement of lifecycle definitions. Explicit command-line state overrides
  remain authoritative. Do not set `enabled=true`; an explicitly disabled hook
  stays disabled.
- Only grant the exact six Lina command hashes. User/project hooks retain their
  own trust decisions. A different command does not inherit trust merely because
  it occupies the same event index.
- Use the same hash/command builder for both Windows and POSIX launch paths.
  Updated app-owned hook commands receive their matching launch-scoped grant.

Acceptance: native `hooks/list` in an isolated Codex home reports Lina's hooks as
trusted, including after an observer-path change. Unrelated hooks remain
untrusted; persisted and command-line disable settings survive. Windows wrapper
tests verify argument ordering and real encoded-command delivery. No model turn
or global Codex configuration write is needed for these checks.

Parent verification passed:

- `npm run test:terminal-status`: 79 tests plus backend runtime, generation,
  telemetry, frontend runtime and App projection smoke checks.
- `npm run build`: passed; Vite retains its existing large-chunk advisory.
- `npm run smoke:codex:hook-trust -- --codex-bin <native-codex-executable>`:
  all seven isolated scenarios passed against installed Windows Codex 0.153.4.
- Generated observer transport through the installed Lina executable, encoded
  PowerShell, and `cmd` plus PowerShell: each produced one identified turn-start
  event, no stdout/stderr and a successful exit.

The native check is in `scripts/qa/codex-hook-trust-smoke.cjs`; it requires an
explicit native executable through `--codex-bin` or `VIBE_TEST_CODEX_BIN`.
POSIX hashes are fixture-tested; a native POSIX launch was not run. Packaged
acceptance of the changed application remains outstanding.

## 2. Display ongoing work separately from unconfirmed input

Retain `pendingInput`, its timestamp and prior native turn ID for input receipt,
request ownership and completion validation. The display needs separate evidence
that the previously observed turn continued after the pending input.

Implemented in `backend/terminalRuntime.cjs` and `frontend/terminalRuntime.ts`:

- Retain generation-scoped evidence of activity after the current input intent.
  Accept only validated root/child lifecycle observations with matching identity
  and event ordering; old or duplicate tool callbacks must not qualify.
- A fresh tool start or running observation for the still-current root can show
  ongoing work without clearing pending submission. A tool returning does not
  prove the turn ended; retain observed running activity through thinking time.
- A matching root end clears this separate work indication without acknowledging
  the later input or attributing the old result to the new request. A matching
  approval/question observation shows the actual wait. Existing child lifetime
  and child-attention rules remain independent.
- Clear the additional display evidence when a new input intent, new native
  turn, process exit, pane restart, or root-identity conflict supersedes it.
- Do not infer work, completion, successful interruption, or accepted input from
  elapsed time, ordinary terminal output, or the Enter key.

Display contract:

| Evidence | Primary status | Secondary detail |
| --- | --- | --- |
| Pending input; no subsequent activity evidence | Awaiting activity | Latest input has not been confirmed |
| Pending input; verified ongoing root or child work | Working | Latest input has not been confirmed |
| Observed unresolved approval/question | Needs input | Preserve the actual wait and any unconfirmed submission |
| Fresh native turn start acknowledging submission | Working | Clear the pending-input detail |
| Old turn ends while a later submission is unconfirmed | Awaiting activity | Do not announce the later request as completed |

Update `backend/orchestratorIntegration.cjs`, `frontend/components/TerminalActivity.tsx`,
the sidebar projection in `frontend/App.tsx`, and dashboard metadata together.
Keep existing status categories; show the pending-input explanation in activity
details/tooltips instead of introducing an ambiguous new scheduling status.
Any elapsed timer shown during pending input must identify the already-observed
turn and retain its original start time.

Scheduling and result acceptance continue using raw turn, identity, child and
pending-input evidence. Review `orchestratorDelivery.cjs`, `orchestratorTasks.cjs`
and `orchestratorResultReports.cjs` to ensure the display change cannot admit a
second prompt, release occupied work, or validate the old result for a new task.

## 3. Make missing activity evidence understandable

In activity details, distinguish a live process from a lifecycle observer that
has actually delivered a valid event. A successful launch/shim callback alone
does not establish that prompt/tool hooks are reporting. Until the first valid
lifecycle event, describe that observation as unconfirmed; silence is not proof
of a broken hook. Explicit failures or disabled hooks can explain unavailable
observation without suggesting that Codex itself stopped.

If operational diagnostics are added, retain only bounded event type, generation,
turn identity, accepted/ignored reason and timing. Do not record prompt text,
tool input, terminal contents, credentials or callback tokens. These diagnostics
should make a future incident attributable without guessing from a screenshot.

## Verification and rollout

1. Add runtime traces for Escape/Enter with fresh same-turn activity; delayed old
   start/stop/completion; tool return followed by thinking; approval replies;
   continuing children; new-turn acknowledgment; restart and root conflict.
2. Assert pane/sidebar/directory/dashboard status parity while raw input and result
   guards remain unchanged. Include child-only work and absent lifecycle signals.
3. Run `npm run test:terminal-status`, relevant Orchestrator tests and
   `npm run build`; run the isolated native hook-trust check against the installed
   Codex CLI. Certify additional CLI versions only when those checks actually run.
4. Verify the packaged app with a fresh isolated profile, repeated launches and
   an updated observer path. Record which version was checked and which parts
   remain source/fixture-only evidence.

Source changes do not update existing installations or already-running Codex
processes. A rebuilt/updated Lina applies the launch overrides to newly started
panes; active work should not be interrupted to apply this change.
