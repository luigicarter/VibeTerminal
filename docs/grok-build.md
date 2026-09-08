# Grok Build

Grok Build is a standalone terminal provider (`grok`). It appears in workspace
and Multi launchers, saved workspace setups, conversation history, and the
Orchestrator's launcher catalog. New panes run `grok`; deliberate resumes run
`grok --resume <native UUID>`. Authentication, model choice, permissions and
sandbox configuration remain owned by the native CLI. See the
[official CLI reference](https://docs.x.ai/build/cli/reference).

## Installation and launch

The app detects `grok` on PATH and in `GROK_BIN_DIR` or `~/.grok/bin`. The latter
is the Windows installer's default, so a recently installed CLI remains
discoverable when Electron inherited an older PATH. A per-pane wrapper resolves
the executable and publishes generation-scoped process start/exit events.
Presence on disk does not establish authentication or task progress.

The integration was checked against the installed Windows CLI **1.0.13
(5e9a58528b76)**. This version rejects the newer `--plugin-dir` flag, so the
observer uses its supported personal hook directory. No CLI upgrade is needed.

## Status observation

`backend/grokTelemetry.cjs` creates a dedicated
`$GROK_HOME/hooks/vibeterminal-<owner hash>.json` (default home `~/.grok`). It
preserves existing files. The generated observer requires this app instance's
Grok invocation marker and authenticated launch nonce; it does nothing for
ordinary Grok launches. Parallel panes share the observer code, while separate
app instances own separate hook files. Cleanup removes only the unchanged file
owned by that instance. Content-versioned scripts stay in the app's shim store.

The observer handles session start/end, prompt submission, tool start/result/
failure, real permission notifications, questions, response/failure/cancellation,
and subagent events. Only IDs, tool names, scope and lifecycle metadata reach the
local callback. Prompts, answers, tool arguments and response bodies do not.
Hook stdout is empty and permissions are never decided by the observer.

Grok's Stop hooks can request continuation. They therefore produce **response
available**, not verified task completion. Child stop gates likewise describe a
provisional response; a subsequent native child prompt/tool restores observed
activity. A live resumable child session alone does not keep the pane marked
working indefinitely. Child questions/approvals remain separate from the root
turn. Native cancellation reports interrupted, and failures report failed.
See the [native hook documentation](https://docs.x.ai/build/features/hooks).

Unknown root IDs are confirmed against native metadata before the runtime uses
their lifecycle events. Child credentials cannot claim the parent conversation,
and multiple panes in one folder require distinct verified native identities.
Restarted generations reject callbacks from the previous launch. Question tool
IDs also prevent parallel or delayed callbacks from clearing/reopening a wait.

## Native history

`backend/grokThreads.cjs` reads validated `summary.json` records under
`$GROK_HOME/sessions/<workspace>/<UUID>/`. Both URL-encoded workspace paths and
hashed paths with `.cwd` markers are supported. It verifies native-required
summary fields, folder/UUID ownership, safe paths and visibility. Hidden
subagents are excluded; explicitly identified user forks remain resumable.
Manual titles outrank generated titles and opening-prompt previews.

History reads `updates.jsonl`, applying native event deduplication, message chunk
assembly, prompt boundaries and rewind markers. The shared history reader
supplies paging/search and invalidates cursors when the underlying log changes.
Only a genuinely absent updates log permits `chat_history.jsonl` fallback,
explicitly labeled current context only. Invalid, changing, unsupported or
oversized logs return unavailable. Current bounds are 8 MiB/100,000 records for
a transcript; discovery and resume remain available independently.

The implementation follows public native source revision
[`72a61251`](https://github.com/xai-org/grok-build/tree/72a61251fcffb464bcc687aeb5a998e5a98ec0c9)
and was additionally checked against installed 1.0.13's hook discovery and session
summary parser. [Native sessions documentation](https://docs.x.ai/build/features/sessions)
describes the CLI's save/resume behavior.

## Checks and limits

- `npm run test:grok`: launch/persistence, discovery/history, hooks, questions,
  multi-pane identity, stale generations, setup recipes and routing.
- `npm run smoke:grok:native`: isolated installed-CLI session parser check;
  accepts a binary path after `--` when the executable is elsewhere.
- `npm run test:terminal-status`, `npm run test:orchestrator`, `npm run build`:
  shared integration regressions and renderer build.

Native smoke checks use temporary profiles/workspaces and invoke only inspection,
version and session listing. No authenticated model turn was run. Hook delivery
depends on the native CLI's enabled configuration; provisional Stop events
cannot certify completion, and unsupported/malformed native formats stay
unverified. The integration does not install or update Grok itself.
