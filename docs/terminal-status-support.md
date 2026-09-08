# Terminal status support

All integrated panes participate in status reporting. Native tools supply different
levels of evidence; an open process, quiet output, a model's prose, and an Enter
key are not proof of a running or completed agent turn.

| Pane | Activity source | Child/background work | Completion boundary |
| --- | --- | --- | --- |
| Terminal | PTY lifecycle | Arbitrary shell jobs have no agent lifecycle contract | Shows terminal open/exited; never invents task completion |
| Codex | Invocation-scoped native prompt/tool/permission hooks and completion notify | Native SubagentStart/Stop plus child-scoped tools and approvals | Completion notify needs verified root and native turn identity; child work remains separate |
| Claude Code (including custom provider profiles) | Invocation-scoped prompt/tool/permission/error hooks | Native SubagentStart/Stop tracks agent IDs; Task/Agent tool return does not end a detached child | Stop is response available, because other hooks can request continuation |
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
