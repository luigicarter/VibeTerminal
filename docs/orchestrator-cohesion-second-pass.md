# Orchestrator cohesion: second pass

Historical pass-specific archive. All three audits and their current fixes are
folded into the [consolidated cohesion review](orchestrator-cohesion-review.md).
The findings and counts below describe the September 7 second-pass run.

September 7, 2026. This follows the [first cohesion review](orchestrator-cohesion-review.md)
on the same uncommitted source based on v0.1.101 (`08f467f`). The second pass
concentrates on cancellation boundaries, native conversation changes, concurrent
work and real producer/consumer metadata. Previous fixes and user changes were
preserved.

## Findings and repairs

| Gap | Resulting behavior and verification |
|---|---|
| Task completion used pane/generation identity without checking the native conversation. An unrelated `/new` result could complete an earlier task. | Submission and watch waits retain native identity. A known replacement fails the old wait; missing identity remains uncertain; a new worker can latch its first native ID. Dependency and historical-status regressions prevent a replacement conversation from inheriting completion. |
| Explicitly targeted queued prompts lacked the conversation binding already used by automatic routing. | Every managed send supplies its original binding as adapter metadata after claiming the action. Real IPC/delivery regressions verify no write to a replacement conversation, one write to the original, and preservation of stronger bindings. Shell behavior is unchanged. |
| Cancelling during asynchronous workspace resolution could restore a stale target and change a cancelled task to failed. | Cancellation is checked immediately after resolution, before committing lanes or continuity. Global cancellation, request cancellation and disabling all preserve the cancelled state and an independent next request. |
| Detached startup acknowledgments could mutate history after disposal had finished flushing. | Disposed-only fences stop late publication and binding. A still-live cancelled request can retain a real acknowledgment. This is reproduced lifecycle hardening; normal production startup cancellation already limits the timing window. |
| A typed answer or removed task question left voice mode waiting for an obsolete answer, discarding the next spoken command. | Task-state updates and PTT start retire stale question context. Audio captured for the old question is cancelled rather than reinterpreted as a new command. Native questions and conversational followups remain independent. |
| Actual History metadata included incidental planner information that differed from live session metadata, blocking valid recovery even for Codex. | Read-source comparison uses planner family only for Fusion. A matrix passes actual directory and History output through recovery for eleven launcher kinds and both Fusion planner families; true native ID/home/profile/family changes remain rejected. |
| Fusion/Open Fusion host `session` events did not immediately update directory identity; stale UI inventory could conceal a new native conversation. | Current-generation host IDs take precedence immediately. A known switch clears current turn/action evidence while preserving historical result cache and transcript content. Initial/resume identity events remain idempotent. |
| Automatic dependent requests created workers before their prerequisite result was available. | A dependency-only gate waits and validates the exact result before routing or creation, while releasing the serialized routing lane. Pending, failed, cancelled and missing-result prerequisites produce no premature creation. Unrelated routing remains responsive. |
| Handing a clarification to a new request marked the original request finished while its delivered task still ran. | Clarification retirement preserves result waits and failures. A three-request regression verifies that answering A does not release dependent B; B starts once after A's actual result, with no duplicate submission. |
| Two independent automatic tasks bundled in one request could bypass workspace serialization and mutate the same checkout simultaneously. | Submission admission serializes incompatible work items within a request. While waiting, the request retains workspace ownership and releases terminal controls. It then reacquires admission and revalidates the original observation before sending. Cancellation, stale observations, queued/uncertain delivery, compatible continuations, read-only work and separate workspaces are covered. |

## The scheduling contract

Creation is an effect and must respect result prerequisites. Submission is a
second boundary: independent work items in the same workspace must not bypass
serialization because they happen to share a request ID.

Waiting for sibling work releases control lanes so an answer, interrupt or
compatible continuation can reach the running agent. It retains the outstanding
workspace lease. Before the next submission, the request reacquires admission
against other active control loops and runs normal identity, authority and
observation checks. Waiting does not refresh an observation token or grant new
authority.

Conversation identity is carried through both queued transport and result
attribution. A stable pane generation alone does not prove that its native
conversation stayed the same. Completed historical evidence remains descriptive
history; it is not relabelled as the replacement conversation's result.

## Verification

Parent acceptance: `npm run check:orchestrator` passed with **1,189 backend,
voice and launcher tests**, no failures or skipped tests. Production typecheck
and build, six renderer smokes, voice capture/hold checks, and both hidden
Electron workflows passed. `git diff --check` passed. The build retains its
bundle-size advisory.

All added regression files are included by the existing backend/voice test
globs. Existing busy-result fixtures now retain the provider kind present in
their original baseline, matching real directory snapshots; their behavioral
assertions remain intact. Separate negative regressions cover missing identity.

Evidence:

- `.tmp/harness-second-pass-20260907/combined-check.log`: full parent check.
- `.tmp/harness-second-pass-20260907/source-hashes.json`: base revision and
  final working-tree hashes.
- `.tmp/orchestrator-smoke/1788838731475-56356/results.json`: hidden Electron,
  native history helper and real PowerShell transport.
- `.tmp/orchestrator-task-ui-smoke/1788838732717-39632/results.json`: wide/narrow
  task UI and reply association through IPC.

The tests use deterministic model/provider responses and real application
adapters where stated. Hidden Electron checks exercise preload/IPC and actual
PowerShell transport. No live paid model call, physical microphone test, audible
playback check or release installation is claimed. These changes remain in
source and the local build.

Related contracts: [tasks](orchestrator-tasks.md),
[routing](orchestrator-routing-deep-dive.md),
[controls](orchestrator-controls.md), and
[voice](orchestrator-voice-deep-dive.md).
