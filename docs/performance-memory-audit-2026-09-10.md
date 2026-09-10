# Lina Terminal performance and memory audit — September 10, 2026

**Implementation follow-up:** [performance and Orchestrator repairs](performance-orchestrator-overhaul-2026-09-10.md)
records the subsequent source fixes, before/after measurements and remaining work.
The findings below describe the baseline; rerunning the diagnostic scripts now
measures the current source.
The [complete repair plan](orchestrator-repair-plan-2026-09-10.md) maps every
finding to its current fixed/partial/open status and implementation package.

The strongest findings are retained terminal buffers after pane closure, a terminal
observer that falls behind on small output chunks, and whole-workspace/history
copying on the live output path. These mechanisms can combine: slower consumption
retains more queued output, while closed panes fail to release their previous buffers.

This is an investigation and recommendation report. The accompanying diagnostic
scripts exercise production modules with synthetic data; they do not implement fixes.

## Scope and evidence

- Baseline: repository version **0.1.113**, starting commit **4dffab7**. Reviewed
  terminal rendering/replay, PTY and chat hosts, process-stop ownership, Orchestrator
  observation/publication, React retention, metadata/Git polling, and voice cleanup.
- The running application reported **0.1.113.0**. Seven installed ASAR files matched
  the reviewed workspace after normalizing CRLF: `ptyHost`, `terminalHistory`,
  `terminalObservation`, `observedStop`, `terminalRuntime`, `orchestratorIntegration`,
  and `main`. This comparison preceded unrelated concurrent close-safety edits in
  the workspace; those edits are outside this audit.
- Node probes used **24.14.1 on Windows**. A separate isolated **Electron 42.11.2 /
  Node 24.19.0** main-process fixture confirmed the slow observer. It used a hidden
  blank window and its own temporary profile.
- No user conversations, paid model turns, live terminal input, or installed-app
  restarts were needed. This is not a longitudinal heap profile of the user's running
  workload. The measurements establish mechanisms, not the exact contribution of
  each mechanism to a particular reported RAM increase.

| Priority | Finding | Evidence |
| --- | --- | --- |
| P1 | Closed PTYs retain decoded terminal history through the stop registry | Reproduced, with GC and a control |
| P1 | Screen observation serializes every chunk behind a separate async write | Reproduced in Node and Electron |
| P1 | Live output triggers inventory copies and full history publications | Reproduced with production directory/coordinator |
| P2 | Closed-pane metadata and some observation state have incomplete retirement | Runtime retention reproduced; cleanup paths traced |
| P2 | Fusion/Open Fusion live transcripts grow without a renderer retention limit | Source-confirmed |
| P2 | Unfinished escape strings bypass the terminal history bound | Reproduced |
| P2 | Multiple terminal representations increase the normal RAM baseline | Source-confirmed; bounded allocation, not inherently a leak |
| P2 | App shutdown can kill helpers before descendant cleanup completes | Source-confirmed race; orphaning not reproduced here |
| P2/P3 | Background polling and completed-build registries add ongoing work | Source-confirmed; workload-dependent impact |

## 1. Closed PTYs keep their terminal buffers — P1

Sources: [observedStop.cjs](../backend/observedStop.cjs), `createHostStopObserver`;
[ptyHost.cjs](../backend/ptyHost.cjs), `createSession` and kill/stop handlers;
[terminalHistory.cjs](../backend/terminalHistory.cjs), `dispose`.

`createHostStopObserver` keeps a strong `records` set containing each process
`resource`. A PTY resource's `onData` and `onExit` listeners close over its session,
which owns the headless xterm history. The PTY host does not retain/dispose the
subscriptions returned by these listeners. Removing the session from `sessions`
and calling `history.dispose()` consequently leaves this reachable chain:

```text
stopObserver.records → record.resource → PTY event listener → session.history
                    → headless xterm → terminal cell buffers
```

The registry only attempts eviction after exceeding 1,000 records. Naturally
exited roots without verified tree termination never satisfy its eviction rule.
Even confirmed stops can retain heavyweight objects until that threshold; retained
stop operations can also hold record references. A `WeakMap` alongside the strong
set does not make those resources collectible.

**Measurement:** eight synthetic 160-column panes filled their 5,000-row histories,
exited, and were removed using the production PTY host. After four GC cycles,
`sessions.size` was zero, all eight PTY weak references were still live, and retained
ArrayBuffer allocation increased by **77.73 MiB**. The control disabled only stop
tracking in the mock dependency: zero PTYs survived and the ArrayBuffer increase
was **0.0625 MiB**. A second probe retained **all 1,200 naturally exited handles**.

The mock uses node-pty's actual `EventEmitter2`; native OS processes are not spawned.
The resource graph and xterm allocations are real. RSS stayed elevated even in the
control, so the much larger RSS change must **not** be labeled entirely leaked
memory: allocator retention is distinct from live ArrayBuffers.

**Fix:** keep strong process handles only while needed for an active stop/exit
operation. On exit, detach subscriptions and release heavyweight references;
retain compact identity/exit/tree-verification facts for replay protection. Preserve
an explicit *unknown* tree result when appropriate. Do not discard safety evidence
or claim descendant termination merely to reduce memory.

## 2. The screen observer accumulates work faster than it can drain — P1

Sources: [terminalObservation.cjs](../backend/terminalObservation.cjs), `ingest`;
[orchestratorIntegration.cjs](../backend/orchestratorIntegration.cjs), `incoming`;
[terminalHistory.cjs](../backend/terminalHistory.cjs), `queue`/`drain`;
[TerminalPane.tsx](../frontend/components/TerminalPane.tsx), `syncOutput`;
[ptyHost.cjs](../backend/ptyHost.cjs), `emit` and `pendingEvents`.

The observer appends a promise for every output event, waits for that chunk's xterm
write callback, and then extracts the entire screen before submitting the next
chunk. In the installed xterm 5.5 implementation, a write into an empty queue
schedules a timer. Resolving the promise and only then submitting the next write
repeatedly incurs that scheduling delay.

| Synthetic redraw stream | Node observer | Electron main observer | Coalescing history decoder in Electron |
| --- | ---: | ---: | ---: |
| 500 chunks / 42,390 bytes | 7.71 s | 6.92 s | 19.68 ms |
| 2,000 chunks / 170,890 bytes | 30.86 s | 28.19 s | 21.43 ms |

The comparison uses the same bytes and real production decoders. The observer
retains intermediate display samples; the history decoder coalesces pending writes.
It is a demonstration of scheduling/batching cost, not an equivalent-feature patch
or an application-wide speedup estimate. Windows timer resolution and workload
affect the exact timings.

The observer's 1 MiB per-pane / 32 MiB global sample limits apply **after parsing**.
They do not bound the pending promise chain. Similarly, the PTY history operation
queue, queued events behind a snapshot, and outgoing stdout writes have no explicit
flow-control budget. The frontend writes into xterm without consumed-byte ACKs.
DEC-2026 coalescing has a useful hold limit, but it is not end-to-end flow control.
These are backlog risks even where already-decoded history is bounded.

**Fix:** batch adjacent data writes while preserving resize/snapshot/generation
ordering; sample screens at a bounded cadence and flush at explicit inspection or
completion barriers. Bound queued bytes and propagate high/low watermarks to PTY
pause/resume. Track renderer attachment separately so an unmounted pane never
blocks the producer waiting for a renderer ACK. Consider moving observation off
the Electron main thread or obtaining observations from the existing history owner.
Do not arbitrarily discard ANSI bytes or weaken evidence sequence checks.

The recommended write-callback/watermark design follows the
[official xterm flow-control guidance](https://xtermjs.org/docs/guides/flowcontrol/).
Node's writable backpressure contract also requires honoring a false `write()`
result and waiting for `drain`; unconditionally writing can accumulate buffered
data. See [Node stream documentation](https://nodejs.org/api/stream.html).

## 3. Live output still copies inventory and full conversation history — P1

Sources: [orchestratorIntegration.cjs](../backend/orchestratorIntegration.cjs),
`createSessionDirectory.list/get`, `incoming`, `publishSoon`;
[terminalRuntime.cjs](../backend/terminalRuntime.cjs), `listSnapshots`;
[orchestrator.cjs](../backend/orchestrator.cjs), `refresh`, `snapshot`, `emit`;
[orchestratorConversationStore.cjs](../backend/orchestratorConversationStore.cjs), `save`.

`directory.get(id)` implements a single-pane lookup as `list().find(...)`.
`list()` first clones all runtime snapshots and builds the full merged inventory.
For terminal events, `incoming()` performs two such lookups, another full runtime
list for generation checks, and another lookup after the observer drains. Additional
completion/delivery work can add more. This cost scales with all open panes even
when only one pane is printing.

**Measurement:** 2,000 single-pane lookups took **145 ms with 24 panes**, versus
**4.3 ms** for targeted runtime snapshots. The latter omits the UI merge, so it is
a cost reference, not a measured drop-in replacement.

Output also changes `lastOutputAt`/`lastActivityAt`. `publishSoon()` requests a
refresh roughly every 150 ms during sustained activity. Because those fields
change, the inventory equality gate no longer suppresses `emit()`. Emission
serializes/redacts the full state, projects the persisted conversation again, and
broadcasts the entire history to windows. Save deduplication avoids identical disk
writes, but occurs after projection and serialization.

**Measurement:** with 24 panes and a 3,259,179-byte / 1,500-message saved history,
20 unchanged refreshes emitted zero snapshots; 20 output-timestamp changes emitted
20 full snapshots containing **30,000 message entries**, taking about **199 ms**
before Electron IPC/rendering. The relay was not enabled in this fixture.

**Fix:** make per-ID directory projection direct, batch activity updates, and split
small runtime/activity publications from transcript publications and persistence.
Use a history revision/dirty flag so output timestamps cannot reprocess unchanged
conversation content. Restrict raw terminal IPC to actual terminal consumers;
currently it is broadcast to every BrowserWindow and filtered by pane listeners.

The 0.1.110–0.1.112 narrow-reader and unchanged-inventory fixes remain valid. This
finding concerns active output, which bypasses the unchanged-inventory optimization.

## 4. Pane retirement is inconsistent across owners — P2

Sources: [terminalRuntime.cjs](../backend/terminalRuntime.cjs), `stop`/`refresh`;
[App.tsx](../frontend/App.tsx), `receive`, `removeClosedSession`, `closeSession`;
[main.cjs](../backend/main.cjs), `stopSessionObserved` and `terminal:kill`;
[orchestratorIntegration.cjs](../backend/orchestratorIntegration.cjs), close/forget paths.

The runtime marks records closed but never deletes or compacts them. The probe
created and closed 1,200 identities: zero visible snapshots, **1,200 full records
still retained**. The periodic scheduler still enumerates those records before
skipping them. The renderer likewise retains `runtimeSnapshots`, acknowledgements,
and closed IDs when `removeClosedSession` removes a pane.

There is also a cleanup-path gap: UI close calls `stopSessionObserved`, whose
successful terminal path releases telemetry but does not call `forgetTerminal`.
The legacy `terminal:kill` route does call it, and the Orchestrator close adapter
separately forgets observations on verified success. Thus manual close can retain
the observation decoder and history; there is no general inventory-removal eviction
in `createTerminalObservation`. Its global sample cap limits text, not pane objects.

**Fix:** centralize generation-scoped retirement for manual close, project removal,
Orchestrator close, failed launch, restart, and host exit. Release renderer/runtime
payloads and display decoders independently of compact stale-message/stop evidence.
For unresolved process stops, preserve the evidence and active control owner without
retaining the full old UI transcript or terminal screen unnecessarily.

## 5. Chat panes retain and mount an ever-growing live transcript — P2

Sources: [FusionChatPane.tsx](../frontend/components/FusionChatPane.tsx), `append`,
`applyDeltaBatch`, `visibleMessages`;
[OpenFusionChatPane.tsx](../frontend/components/OpenFusionChatPane.tsx), corresponding
message paths; [fusionChatHost.cjs](../backend/fusionChatHost.cjs) and
[openFusionChatHost.cjs](../backend/openFusionChatHost.cjs), `emitSessionEvent`.

Both renderer panes append to `messages` without a live retention bound and mount
all visible rows with `.map()`. Text, tool inputs, outputs and row objects grow with
the session; full-array copies/scans grow too. Both hosts independently retain up
to 20,000 cloned events, but that is an event-count limit, not a byte budget. Large
tool results can therefore retain substantial memory within the count limit.
Front-splicing full event arrays also adds recurring work after the cap is reached.

There are existing improvements: streamed deltas are frame-batched and `OcChatRow`
and Markdown are memoized. It would be inaccurate to claim every historic Markdown
row reparses on every token. Nevertheless, all rows remain mounted, and the current
growing Markdown block is reparsed as its text changes.

**Fix:** virtualize/paginate transcript rows, keep a bounded live tail, load old
messages on demand, and cap retained event/tool-result bytes as well as counts.
Use a ring buffer or deque for host retention and indexes for tool-row updates.
Move large outputs to files with bounded previews while preserving access to them.

## 6. Unfinished terminal control strings are unbounded — P2

Source: [terminalHistory.cjs](../backend/terminalHistory.cjs), `trackPending`.

`pending += char` retains unfinished OSC/DCS/string sequences until a terminator,
independent of the 5,000-row cap. Snapshots append the complete suffix. A malformed
or very large unterminated control string can therefore cause continuing memory
growth and large snapshot/IPC payloads without creating any visible scrollback.

**Measurement:** four 256 KiB additions to an unfinished OSC title increased replay
size from 262,159 to **1,048,591 bytes**. Adding the terminator reduced it to 11 bytes.
This is a conditional defect; normal terminated output does not trigger it.

**Fix:** impose a byte limit on incomplete sequences, retain parser state without
an unlimited string, and discard unsupported oversized payload content until its
terminator. Preserve valid split-sequence behavior and clearly handle degraded
replay rather than treating a clipped suffix as complete terminal state.

## 7. Normal terminal RAM grows with both width and pane count — P2

Sources: [shared terminal display settings](../shared/terminalDisplay.json),
[terminalHistory.cjs](../backend/terminalHistory.cjs),
[TerminalPane.tsx](../frontend/components/TerminalPane.tsx),
[terminalObservation.cjs](../backend/terminalObservation.cjs).

Every PTY has a 5,000-row headless history; each mounted pane has another 5,000-row
xterm buffer. The Orchestrator maintains a third decoder with zero scrollback plus
bounded screen samples, regardless of whether relay mode is enabled. Hidden
workspaces keep their processes and backend histories; remounting serializes and
reparses the saved cells.

xterm 5.5 stores three 32-bit values per cell before object, Unicode and attribute
overhead. At 240 columns, a full 5,000-row buffer accounts for about **13.7 MiB**
of cell storage alone; backend plus mounted renderer is about **27.5 MiB per pane**.
This is expected bounded allocation, distinct from the closed-pane leak.

**Fix:** add memory telemetry and an explicit aggregate history budget. Consider
configurable retention and disk-backed inactive history while preserving the
recent scrollback repair's promise that redraw traffic cannot evict readable
history. Fix resource retirement before simply reducing the scrollback limit.

## 8. Shutdown can interrupt its own descendant cleanup — P2

Sources: [main.cjs](../backend/main.cjs), `window-all-closed`;
[ptyHost.cjs](../backend/ptyHost.cjs), `shutdown`;
[fusionChatHost.cjs](../backend/fusionChatHost.cjs) and
[openFusionChatHost.cjs](../backend/openFusionChatHost.cjs), `shutdown`/`killChild`.

Main writes a `shutdown` message and immediately calls `host.kill()`. PTY/chat
descendant cleanup is implemented inside those hosts, so killing the host first
can prevent that cleanup from running. On Windows this is particularly relevant
to planner/OpenCode child trees. The existing `before-quit` hook waits for
Orchestrator persistence, not these host shutdown acknowledgements.

This is a source-confirmed race, not evidence that any currently running user
process is orphaned. Intentional detached builds must also remain distinguishable
from processes the application owns and should stop.

**Fix:** enter one coordinated shutdown barrier, request helper cleanup, wait for
acknowledgement/exit, and apply bounded tree-termination fallback using retained
ownership evidence. A Windows Job Object is worth evaluating for app-owned trees.
Exercise ordinary exit and updater exit, not just individual pane closure.

## 9. Background work still has cumulative costs — P2/P3

- **Git polling:** [App.tsx](../frontend/App.tsx) polls all saved workspaces every
  7.5 seconds, even when hidden. [codeChanges.cjs](../backend/codeChanges.cjs)
  runs about five Git commands per normal repository and synchronously scans
  untracked files on main. It already limits that scan to 2,000 files / 16 MiB per
  workspace, but aggregate work still multiplies with workspace count. Each refresh
  replaces the UI summaries even when substantive results are unchanged.
- **Metadata polling:** [terminalRuntime.cjs](../backend/terminalRuntime.cjs)
  refreshes every eight seconds, with useful per-record in-flight protection and
  short caching. Successful refresh still calls `publish`, incrementing revision
  and updating React even when substantive state is unchanged. Exited, unclosed
  records are not explicitly excluded by process state from metadata refresh.
- **Completed build history:** [buildSupervisor.cjs](../backend/buildSupervisor.cjs)
  retains `registry` and `settledBuildIds` without a retention policy. The three-second
  poll scans the accumulated registry, and persistence synchronously rewrites it.
  This is a lower-priority long-session/repeated-build cost, not a measured large
  RAM contributor in this audit.

**Fix:** cache unchanged Git results, limit concurrent scans, back off inactive
workspaces, and move bounded file scanning off main. Publish metadata changes only
when meaningful fields change. Archive/prune settled build metadata while retaining
active ownership and log access. Electron's
[performance guidance](https://www.electronjs.org/docs/latest/tutorial/performance)
supports keeping blocking filesystem work off the main/UI path.

## What already has appropriate cleanup or limits

`TerminalPane` disconnects its ResizeObserver, removes DOM/IPC listeners, cancels
the tracked fit frame, resets its synchronized-output timer and disposes xterm on
unmount. The preload subscription helper returns a matching `removeListener`.
These are not a generic repeated-mount listener leak on the inspected normal path.

Voice capture closes its AudioContext/worklet port and stops media tracks;
playback disconnects sources. Voice inference limits queued audio to 32,000 samples,
limits completion audio, and kills its two inference helpers on stop/dispose.
Several interaction/deduplication sets are capped at 512. Loaded speech models
and their native heaps can explain a substantial stable baseline; this audit did
not establish a voice resource leak. GPU/native memory and other agent processes
must be measured separately from the renderer JS heap.

## Recommended implementation and verification order

1. Release exited PTY references and subscriptions; centralize pane retirement.
   Verify repeated fill/close/restart cycles return live ArrayBuffers, process
   objects and listeners near baseline after GC while stop proofs remain truthful.
2. Batch observation and implement bounded transport flow control. Flood several
   panes, including hidden panes; check input latency, bounded queue bytes, timely
   inspection and correct resize/replay/generation ordering.
3. Replace full-inventory getters on per-event paths and separate transcript,
   activity and persistence revisions. Under continuous output, unchanged history
   should not be recopied or republished.
4. Bound live chat retention and incomplete terminal sequences; then address
   polling and shutdown. Test long transcripts, large tool outputs, valid split
   ANSI sequences, and descendant cleanup in a disposable profile.

Add per-process `heapUsed`, `external`, `arrayBuffers`, private memory/RSS, live
decoder/process/listener counts, queued-byte counts and oldest-output age to
diagnostics. Sample before load, during load, after idle/GC, and after repeated
close cycles. Heap snapshots should identify retaining paths; RSS alone cannot
distinguish a leak from allocator, model or GPU memory.

## Reproduction and validation

```powershell
node scripts/diag/performance-memory-audit.cjs
node scripts/diag/performance-memory-audit-electron.cjs
```

The first runs isolated Node cases, including the stop-registry control. The second
launches its own hidden Electron fixture. Both save reports beneath
`.tmp/performance-memory-audit/`; the slow observer cases can take around 40 seconds.
These are diagnostic measurements, not timing-based CI assertions.

Retained evidence from this audit:

- `.tmp/performance-memory-audit/1789051486118-46512/report.json` — Node retention,
  control-string, observer, lookup and runtime-record probes.
- `.tmp/performance-memory-audit/1789051486118-46512/output-history-publications.json`
  — active-output history publication probe.
- `.tmp/performance-memory-audit/electron-1789051679287-47908/report.json` — Electron
  main-process observer comparison.
- `.tmp/performance-memory-audit-tests.log` — **58 passing tests**, zero failures
  or skips, covering scrollback/replay, terminal observation, observed stop
  host/main behavior and existing Orchestrator performance invariants.

Passing those functional tests does not invalidate these findings: they do not
currently assert post-close buffer collection, bounded observer throughput/queues,
or unchanged-history publication during continuous terminal output.
