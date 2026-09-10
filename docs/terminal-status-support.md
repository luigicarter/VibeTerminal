# Terminal status support

All integrated panes participate in status reporting. Native tools supply different
levels of evidence; an open process, quiet output, a model's prose, and an Enter
key are not proof of a running or completed agent turn.

| Pane | Activity source | Child/background work | Completion boundary |
| --- | --- | --- | --- |
| Terminal | PTY lifecycle | Arbitrary shell jobs have no agent lifecycle contract | Shows terminal open/exited; never invents task completion |
| Codex | Invocation-scoped native prompt/tool/permission hooks and completion notify | Native SubagentStart/Stop plus child-scoped tools and approvals | Completion notify needs verified root and native turn identity; child work remains separate |
| Claude Code (including custom provider profiles) | Invocation-scoped prompt/tool/permission/error hooks | Native child hooks, completed Agent results and bounded root background-task snapshots; an async launch does not end its child | Stop is response available, because other hooks can request continuation |
| Cursor | Project hooks and native stop status | No native detached-child contract in this adapter | Aborted is a provisional response, never a fabricated question; errors remain failures |
| Gemini | Invocation-scoped defaults overlay with agent/model/tool/permission hooks | Explicit child transcript identity is kept separate from the root | AfterAgent is provisional; retry keeps the turn's elapsed time |
| OpenCode | Plugin session status, permissions, and errors | Known parent/session identities scope child busy, idle, and approval events | Idle is a provisional response; metadata/message replay does not start a turn |
| Kimi | Stock-compatible prompt/tool/stop hooks | Agent tool fallback plus compatible native task metadata polling | Stop is provisional; detached task settlement cannot complete the root |
| Kimi + CC | Shared-compatible hooks and bundled task metadata | Reads native agent/process task IDs and statuses under the verified session | Same root/child separation as Kimi |
| Qwen | Prompt/tool/permission/error hooks | Native subagent hooks retain available IDs or coarse activity | Stop is provisional; tool failures close the tool observation |
| Grok Build | Dedicated passive session/prompt/tool/question/permission/failure/cancellation hooks | Native child IDs with provisional stop/continuation observations | Stop gates are response available; see [Grok integration](grok-build.md) |
| Fusion | Chat host turn/tool/permission/result events | Detached task IDs and background activity survive the root result | Failed results, restoration and interruption retain host semantics |
| Open Fusion | Chat host turn/tool/permission/result events | Detached task IDs and background activity survive the root result | Interruption cannot become success from a trailing result |

## Shared behavior

- Pane, sidebar and Orchestrator displays use the same status precedence. The
  raw root turn state remains separate for request attribution and completion
  verification.
- Child approvals/questions are visible without changing the parent's turn
  state. Unrelated tool callbacks cannot dismiss an identified child wait.
- Native child lifetime is distinct from tool duration. A child tool returning
  does not remove the child while it thinks or continues other work. Anonymous
  hooks indicate child activity without claiming an exact count.
- A new prompt after a provisional response resets elapsed time. Hook-directed
  continuation keeps the same start time. Duplicate responses do not keep moving
  the recorded end time; stale generations and older identified turns are fenced.
- A foreground response with children still working is not displayed as done.
  Resolving an approval clears the wait; subsequent activity supplies evidence
  that execution resumed.
- Provisional child stops retain unresolved lifetime evidence and show activity
  unverified when no independently observed work remains. Matching authoritative
  completion or explicit session-end evidence settles the child; a delayed old
  stop cannot erase newer activity. Anonymous native stops remain unverified
  without a definitive identity. Kimi tool fallback brackets never own the
  issuing child agent's lifetime.
- Task result verification and workspace occupancy are separate. Root failure
  rejects dependencies while known surviving children keep the workspace held.
  Successful task completion waits for observed child settlement. Structured
  permission resolution alone does not make an active turn ready for new work.

## Claude child settlement

Claude's native SubagentStop is provisional because another hook may make the
child continue. Later completed Agent/Task result metadata settles that child;
an async launch receipt only establishes its background identity. Root Stop's
native task registry keeps background work visible and settles background tasks
that ended. A provisional child of unknown launch mode clears when a later root
snapshot reports no background work. Active foreground children and descendants
of remaining background work retain their observations.

Only valid, complete snapshots of at most 256 identified running/pending tasks
and 16 KiB of metadata are used. Missing/unsupported schemas and child-scoped stops cannot clear the
parent. Stale generations and timestamps are fenced. No prompts, commands or
result bodies are forwarded in the added metadata. This repairs stale **activity
unverified** labels without turning a root response into verified completion.
Older Claude versions lacking the task registry retain their hook evidence until
a completed Agent result or another supported settlement signal arrives.
See the [Claude status investigation](claude-terminal-status-investigation.md).

## Passive Kimi task observation

The existing metadata refresh polls the root-confirmed session about every eight
seconds. The optional task observer reads only
`agents/<agentId>/tasks/<taskId>.json` under the provider store. It does not read
task outputs, chat history, prompts, configuration or credentials. It bounds scan
size, validates identifiers and statuses, and rejects path escapes and junctions.

Compatible records contain native task kind, identity, status and timestamps.
Only an explicit terminal task status clears an observed task. Missing records,
partial writes, unsupported layouts, read failures and exceeded scan bounds do
not imply completion. Retained background-only evidence becomes **activity
unverified** when observation is unavailable; independently observed foreground
or child work remains visible.

Stock Kimi versions without the compatible task registry retain their hook
fallback. New hook enums are not injected into the shared Kimi home solely
because the bundled fork supports them. This preserves concurrent stock use.

## Verification and limits

`npm run test:terminal-status` exercises provider-wide lifecycle traces, generated
hook transports, OpenCode plugin events, Kimi metadata fixtures, chat host status
projection and renderer helpers. `npm run test:orchestrator` covers the downstream
scheduling and attribution behavior. `npm run build` checks renderer integration.

These are source and fixture checks, not certification of every installed CLI
version or live paid turn. Native hooks must be supported and enabled; normal
provider hook trust/disable settings still apply. Stops that other hooks can
block remain provisional. Background polling has its stated cadence, and
unsupported native fields stay unknown. A model-written reporting skill is not
used as authoritative lifecycle evidence.

Lina's six app-owned Codex lifecycle commands receive exact-hash trust through
launch configuration by default. Global Codex configuration is not rewritten;
explicit disables and unrelated hook trust remain in effect. The generated
observer is checked against the app's expected contents before granting trust.
`npm run smoke:codex:hook-trust -- --codex-bin <native-codex-executable>` verifies
native discovery in an isolated Codex home without starting a model turn. See the
[activity and hook trust plan](codex-activity-and-hook-trust-plan.md) for scope,
acceptance evidence and the separate planned activity-display fix.

## Codex "awaiting activity" investigation (September 9, 2026)

The label can hide observed work. A reproduction using the actual runtime and
renderer helpers starts a verified Codex turn, records Escape followed by Enter,
then delivers fresh tool activity for the same native turn. The snapshot retains
`turnState: running` and one active tool, but `pendingInput: submit` takes
precedence: the label is **awaiting activity** and the projected session status
is **idle**. Ordinary Enter during an observed running turn preserves **working**.

`recordInput` in `backend/terminalRuntime.cjs` treats Escape/Ctrl+C as provisional
interrupt intent. Enter after that records a possible new submission and retains
the prior turn ID. Same-turn tool/running/completion callbacks cannot acknowledge
that submission, because they might belong to work preceding the interrupt.
`frontend/terminalRuntime.ts` and `backend/orchestratorIntegration.cjs` then display
the pending input before root activity. A fresh identified turn start clears it.
Terminal output alone never clears pending intent, so missing lifecycle events
can also leave the label visible throughout real work.

The stale-event fences are deliberate; the existing runtime smoke test protects
them. A correction should distinguish observed ongoing work from confirmation
of the latest input, preserving turn identity and completion checks. Simply
clearing pending input on arbitrary output, a timeout, or an old-turn callback
would falsely acknowledge submissions.

Installed checks found Lina **0.1.104** and Codex CLI **0.153.4**. The installed
runtime and telemetry code matched source after newline normalization. All six
observed Codex TUI processes carried Lina's six lifecycle hook overrides; the
saved hook trust hashes matched the current installed commands, with none of
those hooks disabled. These are configuration checks, not a recording of hook
delivery during the reported episode.

Independent parent checks passed 57 lifecycle/projection tests, both backend and
frontend runtime smoke checks, and the reproduction above. Isolated hook delivery
using the installed executable passed through direct Node mode, encoded
PowerShell, and `cmd` plus encoded PowerShell (about 50, 617, and 1,039 ms).
Each emitted one identified turn-start event, exited successfully, and produced
no stdout/stderr. No deterministic Windows transport failure was reproduced.

The exact reported episode was not captured, so Escape/Enter is a confirmed
mechanism, not an established account of the user's keystrokes. No production
behavior, hook trust settings, or running sessions were changed by this
investigation.
