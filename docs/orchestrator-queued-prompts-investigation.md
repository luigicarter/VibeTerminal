# Prompts remain queued instead of being delivered

Investigated September 8, 2026 against the installed Windows application
`0.1.103`, current source, recent conversation records, and private operational
logs. The findings below describe that installed behavior. The subsequent source
fixes are summarized here; they have not been applied to the running installation.

## Source fixes

- Requests for a free terminal carry an `idle` availability constraint. The app
  chooses among the user's frozen candidate group, rechecks after scheduler
  admission, and fences native and structured writes. Busy terminals, human
  drafts and pending interactions cannot silently receive or queue these prompts.
  Before any effect, another still-free member of the original group can be
  selected. Once an effect occurs, the selected identity stays fixed.
- Queued operator prompts can move to a freshly observed busy Codex composer.
  This retains the original request, prompt, generation and conversation binding,
  plus FIFO and concurrency limits. Fresh internal attempt IDs avoid cached
  proven-unsent failures; receipts remain associated with the original action.
  Rejected or uncertain promotion is not automatically replayed. Other providers
  and legacy sends retain their existing readiness rules.
- Scheduler waits identify the actual blocking request, terminal and workspace,
  distinguishing current activity from an unverified result. Status questions
  recognize queued requests even before a delivery wait exists. Reentrant status
  publication cannot lose an admission wakeup.
- A continuation can atomically replace a completely unstarted queued operator
  request. The original queue owner is cancelled before successor execution, and
  full targets, constraints, access, prerequisites and deferred work are retained.
  If the original starts while interpretation runs, or recovery interpretation
  fails, no second delivery grant survives. Delivery queues and uncertain writes
  are not transferable by this mechanism.

Real conflicting work in the same project still serializes. An idle-looking pane
does not prove the preceding task completed or release an uncertain write.

Parent verification: **1,630 Orchestrator/voice tests passed**, including the
queue-promotion, unavailable-target, admission-race and recovery regressions. The
production build also passed. These checks use scripted model/native adapters;
this fix pass did not submit prompts to the user's live terminals or update the
installed application.

## Findings

There are two separate queues. The recent incidents reached different ones.

| Incident (Toronto time, September 8) | Recorded behavior | Finding |
| --- | --- | --- |
| New-terminal task at 21:06:22 (`7b1a75e4-7bca-46c9-9d44-e256d7acb341`) | A live terminal was created at 21:06:27. Routing completed, but no execution stage or prompt receipt followed. The request remained `queued`. | It stopped at scheduler admission, before attempting terminal input. Earlier work in the same project was still `waiting-results`. Workspace serialization is the strongly supported explanation, rather than a lost paste during startup. |
| Explicit follow-up at 21:07:56 (`041f7506-9479-479c-899f-6a197a78b99e`) | Input was written to that same terminal at 21:08:01 and its task started. The original request remained queued. | Explicit terminal operations can pass an automatic request waiting for its project. They do not automatically retire the original unsent request. |
| Request for an available Codex terminal at 21:10:40 (`e159b6b1-068f-4a23-a168-c93fec2cf930`) | The Orchestrator selected the same terminal used for another task at 21:09:02. Its new send returned `queued` at 21:10:47, followed by an acknowledgement that nothing had been sent yet. | This reached the delivery queue: the selected terminal did not satisfy immediate input eligibility. The user's free-terminal preference was not fulfilled. The historical logs do not retain enough native state to identify the exact failed input guard. |

## Why these queues persist

1. **An idle terminal can still be blocked by its project.** Automatic tasks
   acquire a workspace lane in addition to a terminal lane. An older delivered
   request keeps the workspace occupied until its result is attributed and any
   observed background work ends. A newer empty terminal does not bypass that
   gate. If completion cannot be attributed, an older result wait can retain
   occupancy indefinitely, even with a completed-looking terminal. This last
   condition was reproduced; it is not established as the older task's actual
   state in the recorded incident.

2. **Queued Codex prompts use a stricter route than newly sent prompts.** Direct
   operator input supports an observed busy Codex composer under specific input
   ownership and identity checks. A proven-unsent rejection can instead enter
   the ordinary delivery queue. That queue waits for idle/completed readiness;
   it does not re-observe and use the busy-composer route once that becomes
   eligible. A prompt queued while a preceding submission starts can therefore
   wait through the entire subsequent turn.

3. **The two-minute deadline is not a maximum wait for active work.** Observed
   running work or child activity continually renews the queue deadline. A stale
   `pendingInput` flag alone does not: it expires with a blocked, not-dispatched
   result after two minutes. The queue is pumped by runtime events and the
   enabled four-second inventory refresh. No missing-pump defect was established.

4. **Retrying can leave two independently authorized requests.** A targeted
   follow-up can submit the task while the earlier automatic request is still
   waiting. When the older workspace blocker clears, the original request can
   become executable. This admission sequence was reproduced in both installed
   and source schedulers. It establishes a duplicate-execution risk, not evidence
   that a duplicate actually occurred in this incident.

The admission message currently says it is waiting for the destination terminal
to become available, even when the blocker is another request in the same
workspace. This hides the reason an apparently empty terminal receives nothing.

## Relevant implementation

- [Task scheduler](../backend/orchestratorTasks.cjs): `hasWorkspaceOccupancy`,
  `occupiedLanes`, `conflict`, and `ready` retain project ownership separately
  from terminal readiness.
- [Orchestrator](../backend/orchestrator.cjs): workspace lane construction,
  `tasks.ready`, and `trackManagedTaskOwnership` explain admission and the
  independent follow-up behavior.
- [Busy input](../backend/orchestratorBusyInput.cjs) and
  [integration](../backend/orchestratorIntegration.cjs): guarded native input and
  the proven-unsent `canQueueBusyPrompt` fallback.
- [Delivery queue](../backend/orchestratorDelivery.cjs): `classify`, `enqueue`,
  `deliver`, and `pump` implement readiness, expiry renewal, and eventual writes.
- [Intent validation](../backend/orchestratorIntent.cjs): group selection freezes
  model-provided eligible IDs; it does not independently preserve an explicit
  idle-only selection constraint through a later readiness change.

The delivery module matches the installed version. Busy-input and terminal-input
modules match after newline normalization, and the relevant installed scheduler
gates match source. Updating the installation alone will not resolve these
specific behaviors.

## Verification and limits

The parent personally ran 153 relevant scheduler, routing, delivery, concurrency,
busy-input, and terminal-input tests: all passed. Existing tests therefore do not
establish that the requested send-immediately behavior is implemented.

Two local reproduction artifacts use fake sessions, clocks, and transport:

```powershell
node .tmp/queue-investigation-20260908/scheduler-repro.cjs
node .tmp/queue-investigation-20260908/delivery-repro.cjs
```

Both passed their assertions. The scheduler artifact exercises source and the
installed archive. It reproduces blocked new-work admission, an explicit
follow-up passing that queue, later admission of the original, and retained
occupancy after unattributable completion. The delivery artifact confirms a
startup-queued prompt remains unsent after 300 seconds of observed busy work,
drains exactly once on completion, and expires stale pending input after 120
seconds without writing.

No real terminal was sent input and no pending user request was changed. Saved
history and diagnostics establish the incident timeline, but not the exact
historical composer state or whether the earlier workspace owner had finished.

## Recommended correction

- Preserve an explicit idle-only target requirement through interpretation,
  selection, and pre-dispatch validation. Re-resolve another eligible terminal
  within the user's authorized group instead of silently accepting a busy one.
- Show the actual blocking request and project, distinguishing active work from
  an unresolved result. Keep completion uncertainty separate from the user-facing
  explanation of why input has not been sent.
- Let an explicit recovery transfer the verified-unsent original request's
  delivery ownership, so later admission cannot repeat a task already sent by
  that recovery.
- If busy Codex delivery is desired for an already queued prompt, re-observe it
  through the guarded native-input route with the original target, request owner,
  and fresh input revision. Do not send idle-assumed input to a busy terminal or
  automatically retry an uncertain write.
