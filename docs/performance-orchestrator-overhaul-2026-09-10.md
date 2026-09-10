# Performance and Orchestrator repairs — September 10, 2026

This source update fixes the largest reproduced costs from the
[memory audit](performance-memory-audit-2026-09-10.md): retained closed-terminal
buffers, slow screen decoding, whole-inventory lookups, and conversation-history
publication driven by terminal activity. It also tightens retirement, transport
pressure, metadata polling and the factual context for ordinary product questions.

The starting release was **0.1.113 / 4dffab7**. Existing uncommitted conditional-close
and conversation-planning changes were preserved. No version bump, release,
installation, saved-user-history change or installed-app restart was performed.

## Review coverage

The review followed the recent 0.1.110–0.1.113 changes through history ownership,
Claude child status, Orchestrator planning/execution, input and close guards, and
Windows fixture repairs. It inspected PTY transport/replay, native observation,
process-stop ownership, runtime metadata, the directory, coordinator publication,
preload and React state consumers. The broad acceptance suite exercises routing,
task ownership, budgets, voice, provider status, recovery and lifecycle boundaries.

The broader pass also checked the previously identified chat transcript retention,
Git polling, build-registry retention, voice inference limits and application
shutdown paths. Those remaining architectural costs are listed below; this is not
a claim that every file or every workload in the repository is now optimized.

## Measured results

These are isolated synthetic workloads using production modules, on Windows with
Node **24.14.1**. They are not measurements of the user's active workload or an
application-wide speedup. Before/after runs used the same output bytes and pane
counts. The updated lookup fixture exposes the real runtime's targeted getter;
the publication fixture subscribes to the activity channel used in production.

| Workload | Before | After |
| --- | ---: | ---: |
| Eight filled 160-column PTYs, closed and garbage-collected: retained PTY objects | 8 | 0 |
| Same close cycle: live ArrayBuffer increase | 77.73 MiB | 64 KiB |
| Observe 500 redraw chunks / 42,390 bytes | 7,720 ms | 18.46 ms |
| Observe 2,000 redraw chunks / 170,890 bytes | 30,931 ms | 34.19 ms |
| 2,000 single-pane directory reads with 24 panes | 152.84 ms; 2,000 full inventory copies | 7.06 ms; zero full inventory copies |
| 20 output updates with a 1,500-message / 3.26 MB conversation | 20 full history publications; 30,000 message entries | 20 activity updates; zero history publications |
| Same 20 coordinator refreshes, excluding Electron IPC/rendering | 232.92 ms | 6.29 ms |
| 1,200 closed runtime identities | 1,200 complete records | zero complete records; 1,200 compact launch fences |
| Unfinished OSC payload grows from 256 KiB to 1 MiB | Replay grows from 262,159 to 1,048,591 bytes | Replay stays at 17 bytes for this blank-screen fixture |

An isolated hidden **Electron 42.11.2 / Node 24.19.0** fixture also drained 500
chunks in **4.60 ms** and 2,000 chunks in **39.39 ms**. It uses real decoders and
synthetic output, with no native agent or renderer terminal. Screen observation
now samples completed batches instead of every intermediate redraw; the lower
sample count is intentional. All bytes still reach the parser in order.

RSS remained higher after closing panes because native allocation and allocator
retention differ from live reachable buffers. The table does not label all RSS
growth as a leak or claim that the entire app will use 77 MiB less RAM.

## Implemented behavior

- **Resource retirement:** the stop registry releases exited process handles and
  subscriptions immediately while preserving compact exit and tree-verification
  facts. An unverified descendant tree still returns `unknown`; exited PIDs are
  never killed again. PTY retirement detaches the data/exit listeners that owned
  session history. Natural exit keeps readable history until the pane is closed.
- **Runtime and UI cleanup:** closed runtime records leave the scheduler's active
  map. Compact identities still reject stale launch tokens, and outstanding launch
  preparation is retained until it settles. Successful manual observed-stop calls
  now forget Orchestrator decoders and completion state. Closed renderer panes
  release runtime snapshots and attention acknowledgements. Late creation/output
  events cannot rebuild an observation after runtime retirement; exact pending
  transport receipts can still settle.
- **Screen decoding:** adjacent output shares parser batches and completion
  promises. Batches seal at 64 Ki UTF-16 units and at read/resize/event boundaries.
  A single incoming chunk can exceed the batching threshold. Reads run before the
  following parse job, stale sequences are rejected before enqueue, and generation
  replacement/disposal settles outstanding waits. Integration coalesces the
  completion-capture callbacks attached to the same batch.
- **Producer pressure:** history decoding pauses the native PTY at 1 MiB queued
  UTF-8 data and resumes at or below 256 KiB. The host also respects stdout's
  `write() === false` / `drain` contract. History and transport pressure are
  independent: draining one cannot resume output while the other remains blocked.
  Output ordering and explicit action receipts are preserved. This does not wait
  for a mounted renderer and therefore also works for hidden workspace panes.
- **Control-string replay:** incomplete OSC/DCS-style payloads are retained up to
  16,384 UTF-16 units. An oversized unfinished string gets a compact unsupported
  control-string replay state through its original terminator, including split
  ESC/ST. Snapshot metadata marks `incompleteSequenceTruncated`; the omitted
  control payload is not presented as normal terminal text. Valid ordinary split
  sequences and cell-based scrollback retain their previous behavior.
- **Directory cost:** per-ID reads project one runtime snapshot with the same
  title, alias, status, activity and UI/launch rules as list reads. A set replaces
  repeated inventory scans when adding paused UI panes.
- **Activity publication:** production uses `orchestrator:activity` for inventory
  changes without changed work history. These redacted messages contain sessions,
  active targets and a publication revision, without serializing/saving/broadcasting
  conversation history. Full state still publishes for conversation/task changes;
  `getState()` remains complete, and callers without an activity callback retain
  the previous full-state behavior. React merges activity by revision while keeping
  transcript/receipt/task array references and handling initial IPC races.
- **Metadata:** unchanged metadata results no longer invent new runtime revisions.
  Exited/failed root processes leave periodic metadata lookup.
- **Orchestrator product answers:** passive plans receive shared voice capability
  facts before their first model response, without another tool round. The prompt
  directs error explanations to application errors/receipts. A regression caught
  excess context from the first wording; the shorter version passes the existing
  small-model budget test without relaxing the budget or changing user text.

The existing conditional-close review, fresh runtime/input eligibility checks,
frozen target identities and task ownership protections remain in place. See the
[close investigation](orchestrator-inactive-close-investigation-2026-09-10.md).

## Verification

`npm run check:orchestrator` passed the production build, backend/provider/voice
suite, frontend and telemetry checks, and isolated Electron navigation, task UI
and session-resume checks. `npm run test:performance` is now part of that gate.
The final run passed **1,997 backend tests** and **29 performance regressions**
before the remaining frontend/build/Electron checks. The standalone terminal
scroll fixture passed **26 checks**.
The existing Vite advisory about a bundle larger than 500 kB remains.

`node scripts/qa/orchestrator-navigation-smoke.cjs --performance` also passed
against the actual preload, main process, renderer and disposable PowerShell PTY.
Forty unchanged refreshes sent zero full-state events. New native output sent two
activity publications, zero full-state publications, and retained all 1,500 saved
messages. Navigation, terminal identity, project removal and file preservation
passed in the same fixture.

The additional hidden dashboard animation smoke **did not pass**: its compositor
supplied four frames in four seconds, below the unchanged 30-frame requirement.
Mounted-pane/layout/generation checks preceding motion passed. This matches the
[previously recorded hidden-compositor limitation](orchestrator-cohesion-review.md);
foreground animation timing remains unverified. No motion assertion was weakened.

New regressions cover exit-handle/listener release, truthful unknown stop evidence,
pending launch retirement, stale terminal resurrection, per-ID projection parity,
metadata deduplication, independent transport/history pressure, batched byte and
sequence preservation, read/resize barriers, oversized control replay, activity
redaction/history isolation, initial-state races and first-response capability
context. These fixtures do not certify the accuracy of free-form model answers.

Retained evidence:

- `.tmp/performance-memory-audit/1789054543303-7732/report.json` — baseline.
- `.tmp/performance-memory-audit/1789055583227-17876/report.json` — final Node measurements.
- `.tmp/performance-memory-audit/electron-1789055584781-48800/report.json` — Electron measurements.
- `.tmp/performance-overhaul-acceptance-final.log` — full acceptance run.
- `.tmp/performance-retirement-final.log` — added late-event retirement checks.
- `.tmp/performance-overhaul-native-activity.log` — real shell/preload activity and retained-history acceptance.
- `.tmp/performance-overhaul-scroll.log` — 26 terminal scroll checks.
- `.tmp/performance-overhaul-dashboard.log` — unsuccessful hidden compositor motion check.

Rerun measurements with `node scripts/diag/performance-memory-audit.cjs` and
`node scripts/diag/performance-memory-audit-electron.cjs`. Timing results are
diagnostics rather than fragile wall-clock CI assertions.

## Remaining work and boundaries

1. **End-to-end output budgets:** PTY/history and stdout now propagate pressure,
   but the main-process observer and renderer do not acknowledge consumed bytes
   back to the producer. Repeated explicit snapshot requests and already-buffered
   messages can still accumulate. This is not a hard aggregate memory bound.
2. **Long Fusion/Open Fusion chats:** live React transcripts remain unbounded and
   fully mounted. Hosts cap event counts but not retained bytes. Pagination and
   durable access to older content should precede any eviction policy; this change
   does not silently discard conversation content.
3. **Aggregate scrollback:** active history remains 5,000 rows per pane, with
   backend and mounted-renderer copies. No aggregate memory budget or disk-backed
   inactive history was introduced. General oversized CSI/ESC suffixes are outside
   the control-string repair above.
4. **Git/build background work:** all-workspace Git polling and synchronous bounded
   untracked-file scans remain. Settled build records still need an archive/retention
   policy that preserves log access and live build ownership.
5. **Shutdown:** main still requests host shutdown and immediately kills the helper.
   A coordinated shutdown acknowledgement with descendant-cleanup fallback remains
   a separate lifecycle repair; no orphaned user process was demonstrated here.
6. **Model/native acceptance:** no paid model turns, real provider conversations,
   physical microphone measurements or installed-build soak test were run. Shared
   capability facts improve available context, not a guarantee of truthful model
   answers. Existing child-approval matching limits remain documented separately.

The source fixes and offline evidence are reviewable now. Release/package and
installed-workload verification remain distinct from this source acceptance.
