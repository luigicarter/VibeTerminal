# Claude Code terminal status investigation — September 10, 2026

The initial investigation found three reproducible gaps in Claude's status display: native background work
can be omitted, finished subagents can remain unresolved, and a child approval
can disappear when an unrelated tool returns. These are adapter/runtime gaps;
both generated Node and Windows PowerShell observers reproduce them through
the authenticated callback server and the actual renderer status helpers.

The user subsequently identified **activity unverified** as the observed label.
The child settlement repair below is implemented in source. The installed app,
hook settings and running conversations have not been changed. The exact episode
was not captured, so the original investigation establishes mechanisms rather
than a live trace of that episode.

## Child settlement repair

`backend/claudeTaskTelemetry.cjs` extracts bounded native task metadata for the
Node and Windows PowerShell observers. A completed foreground Agent/Task result
settles its matching child after the stop gate. An `async_launched` result marks
background ownership and cannot settle or resume an already stopped child.

Root Stop snapshots now retain active background tasks, including shell tasks,
and settle previously observed background tasks that have ended. A stopped child
whose launch mode was not observed is settled when a later root Stop reports no
background work. Foreground descendants are absent from Claude's background
registry, so unclassified provisional children remain retained while background
parents may still be executing. An ordinary active foreground child is preserved.

Snapshots are validated as a whole, capped at 256 tasks and 16 KiB, and reduced to native
IDs, types and running/pending statuses. Missing, malformed, oversized or unknown
schemas are unavailable evidence, not empty registries. Root identity, generation
and timestamp checks fence obsolete data. SubagentStop snapshots cannot clear
the parent; completion metadata from other providers is ignored.

Child settlement preserves pending submissions and the original root response
time. Root Stop remains provisional and never becomes verified task completion
merely because the children ended. The separate child-approval finding below
remains outside this repair.

`scripts/backend/claude-task-telemetry.test.cjs` adds 14 regressions to the terminal
status and Orchestrator suites, including actual generated Windows hooks, payload
privacy, delayed events, nested children and missing metadata. Before the repair,
the seven applicable settlement/background tests failed; the three original
retention/provider-isolation checks passed. The expanded suite now passes.

Follow-up validation passed `npm run test:terminal-status` (98 tests and five
smoke checks), `npm run test:orchestrator` (1,980 tests), and `npm run build`.
The build retains the existing bundle-size advisory. These are source/fixture
checks, including generated Windows hook delivery, rather than a paid model
turn or certification of the installed application. The new observer takes
effect with an updated app build and newly launched Claude panes.

## Installed evidence

- Installed Lina: **0.1.109**; repository: **0.1.112**. The installed
  `providerHookMetadata.cjs`, `agentTelemetry.cjs`, and `terminalRuntime.cjs`
  match the repository after newline normalization.
- The two Claude processes launched by Lina carry its generated `--settings`
  file. It contains prompt, tool, permission, failure, SubagentStart,
  SubagentStop, and Stop observers. The inspected global, custom-home and
  workspace settings do not disable hooks. A third Claude process belongs to
  Chrome's process tree and is outside this pane investigation.
- The native executable reports **Claude Code 2.1.267**. The running session
  metadata records versions **2.1.266** and **2.1.267**, respectively.
- One current Lina conversation has **13 subagent transcripts**, **11 recorded
  async agent launches**, and **77 scheduled task firings**. Only structural
  metadata was summarized; prompts and results were not copied into this report.
- Its **137 main Stop hook summaries** report no hook errors. Observer durations
  range from **359 to 1,760 ms**, averaging **458 ms**. A successful observer exit
  does not prove HTTP delivery: the generated observer deliberately suppresses
  transport errors. No live callback trace was available for this investigation.

## Reproductions before the repair

Each fixture uses a separate generation and bound root conversation. Native-shaped
payloads go through the generated observer, callback authentication,
`terminalRuntime`, renderer projection, and Orchestrator session directory.
The same results occur with Node and Windows PowerShell.

| Native evidence / event sequence | Observed Lina result | Problem |
| --- | --- | --- |
| UserPromptSubmit; Stop with `background_tasks: [{ id, type: "shell", status: "running" }]` | `response available`; sidebar idle; no child activity | Running detached work is discarded |
| SubagentStart; SubagentStop; Agent PostToolUse with completed child result; root Stop with an empty background registry | `activity unverified`; child remains provisional | No settlement path consumes the later evidence |
| Child PermissionRequest without `tool_use_id`; unrelated child Read PostToolUse | `needs input` changes to `working` | Unrelated activity dismisses the outstanding approval |

### 1. Native background task snapshots are discarded

Current Claude includes `background_tasks` in Stop and SubagentStop input.
The list describes in-flight shell, subagent and other native tasks. It is
parent-session scoped, including when delivered to SubagentStop.
[Native contract](https://code.claude.com/docs/en/hooks#stop-input).

The installed 2.1.267 executable's hook construction confirms that it reads the
task registry and supplies this field. `backend/providerHookMetadata.cjs`
extracts individual identity/tool fields but ignores the registry. The callback
metadata whitelist in `backend/agentTelemetry.cjs` also has no corresponding
field. The runtime supports background observations, but Claude never supplies
one through this path.

An observed SubagentStart already keeps a known running child visible across a
root response. The missing registry matters for detached shell/other tasks and
for recovering a child whose start callback was missed. The fixture proves the
shell case without assuming a lost callback.

### 2. Claude child stops have no subsequent settlement path

`hookMetadata` marks SubagentStop provisional. This is appropriate because
another stop hook may make the child continue.
[SubagentStop contract](https://code.claude.com/docs/en/hooks#subagentstop).

`provisionalChildResponse` in `backend/terminalRuntime.cjs` retains the child.
`authoritativeChildEnd` requires authoritative completion capability and a
distinct native child thread/turn; Claude has coarse completion capability.
An explicit child session end can also settle it, but the generated Claude
settings do not subscribe to SessionEnd, and an ordinary subagent response is
not necessarily a native session end anyway.

The adapter also ignores completed Agent result metadata and later background
registries. Consequently, an ordinary finished child can remain unresolved for
the pane's generation. New root turns do not remove it. Once independently
observed work ends, the renderer and Orchestrator both show activity unverified;
the sidebar projects idle. Retained child evidence also affects workspace
occupancy, so this is more than a badge label.

### 3. Child approval matching assumes a missing native field

Claude 2.1.267 constructs PermissionRequest input with `tool_name`, `tool_input`,
and permission suggestions, but without `tool_use_id`. Its PreToolUse and
PostToolUse inputs do carry `tool_use_id`. This agrees with the documented
[PermissionRequest input](https://code.claude.com/docs/en/hooks#permissionrequest-input).

The runtime stores that approval with no tool ID. In the child `agent-running`
handler, `!entry.attention?.toolId` permits any subsequent child tool callback
to clear it. PostToolUse generates such a running callback, so an unrelated
Read return can hide a still-pending Bash approval. Existing child approval
tests supply a tool ID and therefore miss this native payload shape.

## Repair requirements identified by the investigation

1. Carry a bounded Claude task snapshot containing only native IDs, kinds and
   statuses through the observer and callback. Preserve parent scope, root
   ownership, generation and observation ordering. Unsupported or missing
   snapshots must remain unknown. Reconcile detached task activity without
   treating it as proof of root task completion.
2. Add child settlement from verified native outcomes, including a completed
   foreground Agent result. Distinguish `async_launched` from completion. Keep
   SubagentStop provisional until later evidence resolves it; merely expiring
   a timer or dropping every child at root Stop would lose legitimate work.
3. Preserve approval identity when PermissionRequest omits a tool ID. Correlate
   with prior child tool observations only when unambiguous, and do not let an
   unrelated tool return dismiss an unidentified approval.

The native session registry also exposes status and update timestamps. A
separate bounded, process- and root-verified reconciliation reader is a useful
recovery path to evaluate for missed callbacks and scheduled work. Its status
semantics need validation before making it authoritative.

## Initial investigation verification

- `npm run test:terminal-status`: **84 tests passed**, followed by all five
  runtime/telemetry/frontend smoke checks. These protect existing behavior but
  omit the three native-shaped sequences above.
- Local audit harness: `node .tmp/claude-status-investigation.cjs`.
  **26 authenticated callback events**, three failure mechanisms reproduced
  in each transport; all observers exited zero with empty stdout/stderr.
- Local fixture output: `.tmp/claude-status-evidence.json`. These ignored audit
  artifacts contain synthetic identities and status results, not user prompts.

No paid model turn was started. The ignored audit harness records the original
failing behavior; the maintained regression suite above now verifies the repair.
No installation or release has been performed.
