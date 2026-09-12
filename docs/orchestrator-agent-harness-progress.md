# Agent harness implementation review

September 10, 2026. Source implementation; no release or installation performed.
The [deep dive and original plan](orchestrator-agent-harness-overhaul-plan.md)
remain available as background. The user's later instruction to avoid
overbuilding narrows the delivery to the scope below.

## Scope and behavior

- Project-only tasks choose an available configured worker without asking the
  user to name a terminal. Independent work gets a separate conversation.
- Continuations use recorded task ownership and a current conversation/run
  binding. Same project, provider, title or idle status cannot prove continuity.
  A separate task-affinity review checks proposed reuse. The September 11
  [continuation repair](orchestrator-continuation-errors-2026-09-11.md) preserves
  the existing-owner requirement and clarification when ownership is uncertain;
  it no longer creates a replacement for an unresolved continuation.
- The request captures its submitted project. Switching views cannot retarget
  admitted work, and removing that project causes an explicit refusal.
  An explicit terminal selection uses its own run and does not require its
  working directory to be an open project.
- Agent IDs are read references over the existing session directory. Effects
  still use existing grants, run/conversation checks, observations and receipts.
- `find_agents`, sectioned `read_agent`, `read_work_item`, and exact
  `read_agent_history` provide selected evidence. Native transcripts stay with
  their existing readers. `record_agent_note` saves short, explicitly inferred
  findings for an agent read in the current request.
- Ordinary assigned tasks use application-driven read/send/read/finish through
  the existing executor. Proven-unsent refusals may use the existing operator
  for recovery. An uncertain attempted write is never automatically replayed.
- Submission, observed activity, an attributed response, and independent outcome
  verification remain distinct. A submitted coding task is reported as pending.
- The reproduced Claude child-approval bug is repaired: an unrelated tool return
  cannot clear a missing-ID approval, and independent approvals remain separate.
  This repair is scoped to Claude; other providers retain their native semantics.

No extra Agents screen, event journal, scheduler, worker framework, draft/close
broker, new request-control operations or restart redesign is included. The
terminal/chat UI, scheduler, provider adapters, native history and delivery
pipeline remain the implementation owners. The command selector says
**Auto-assign** and resets explicit selection when the project changes.

## Persistence and rollout

`orchestrator-agents-v1.json` is an additive versioned sidecar under userData,
with atomic writes and a backup. Only identity references and bounded inferred
notes persist; no grants, input authority, approvals or pending writes restore
from it. Unsupported schema versions are read-only. Existing conversation and
work-item formats remain compatible; restored requests retain their paused
revalidation boundary.

Limits: 2 KiB per note, 128 KiB notes per agent, 8 MiB store, 2,000 identity
records; directory pages contain at most 20 entries/8 KiB. Initial relevant agent
metadata is capped at eight entries/6 KiB. Existing model read budgets apply to
section/history reads. Limits refuse excess writes instead of silently evicting
unresolved evidence. **Clear history** clears notes and archived identities,
preserving present agent identities and active work ownership.

The scoped agent harness (`agents-v1`) is the only coordinator generation as of
September 11, 2026. The legacy path, the `shadow` diagnostic mode, the
`agentHarness` constructor option and the per-request `harnessVersion` were
removed by the de-serialization work (see
[orchestrator-deserialization-plan-2026-09-11.md](orchestrator-deserialization-plan-2026-09-11.md),
package 4). `LINA_ORCHESTRATOR_HARNESS` is ignored rather than rejected, and saved
records that still carry `harnessVersion: legacy` load and resume on this harness.

## Verification

Baseline HEAD `810a866`, package `0.1.115`. The baseline full check passed 2,010
backend tests plus performance, build, frontend, voice and isolated Electron
checks. Baseline and implementation logs are in `.tmp/agent-harness-baseline/`.
Unrelated Git UI, branding and provider work was present or changed concurrently;
these changes were preserved.

New tests exercise identity binding and ambiguity, metadata-only projection,
persistence/replay/recovery, complete paging, selective context, Claude native
approval events and generated Node/PowerShell hooks, project switching, task
isolation, busy continuation, uncertain delivery and proven-unsent recovery.
The 200-session full-request fixture verifies unchanged unrelated agents and zero
execution-model calls for ordinary assigned handoff. Existing frontend tests
exercise project capture and stale explicit-target removal.

The configured `inception/mercury-2.5` passed the real interpretation/routing path
for project-only creation, busy same-task continuation and a different-project
task in `.tmp/orchestrator-routing-live/1789076981052-58360/report.json`: three
cases, seven calls, recorded cost $0.00155588. An earlier three-case run also
passed (`1789076182473-61172`, eight calls, $0.00207899). Terminal adapters were disposable
in-memory fixtures. These are successful live-model cases, not a native CLI or
installed-app reliability guarantee. Earlier failing iterations are retained
under `.tmp/orchestrator-routing-live/` and motivated simpler named tools,
explicit reply-work binding and application-driven handoff.

A local 100-iteration metadata probe measured mean reconciliation of 0.070 ms,
0.493 ms and 4.334 ms at 1/20/200 agents. The project-only agent bootstrap was
249/250/251 serialized bytes, with no initial agent entries or transcript reads.
These figures describe agent metadata, not the entire model prompt or total app
RAM. Contract tests enforce bounded selected context and directory coverage.

The final full `npm run check:orchestrator` passed (exit 0): **2,072 backend
tests**, 29 performance checks, the remaining runtime/metadata/telemetry checks,
TypeScript/build, frontend/voice checks, and isolated Electron acceptance.
The resume fixture passed across two clean Electron processes and 28 panes.
Evidence: `.tmp/agent-harness-baseline/check-orchestrator-accepted-final.log`
and its `.exit.txt` companion. `git diff --check` also passed.

Initial acceptance runs found and repaired an unnecessary legacy-context field,
an over-broad approval change, and navigation-guide compatibility for concurrently
added providers. Existing metadata/navigation/resume fixtures were extended for
that provider work without weakening their identity or preservation assertions.
The standalone-terminal edge case has a full-request regression and renderer
submission coverage. All of these corrections are included in the final gate.

## Boundaries

Provider completion evidence still varies; a coarse response does not prove all
requested work succeeded. Notes are inferences, not source facts or authority.
Ambiguous roots, unavailable history, input conflicts, missing launcher setup
and existing same-worktree reservations can still block a handoff. The narrower
scope does not claim new lifecycle/draft protections or generalized autonomous
request management. No real user worker was started, interrupted or repurposed
by the live-model fixtures, and no installed build was changed.
