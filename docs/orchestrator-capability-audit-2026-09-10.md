# Orchestrator capability and reliability audit — September 10, 2026

The [repair and cleanup plan](orchestrator-repair-plan-2026-09-10.md) assigns these
findings and the performance audit to implementation packages with acceptance
criteria. It also records the subsequent stale-schema readiness repair.

**More issues are possible.** The performance repairs improved observation and
resource use, but do not certify interpretation, factual answers, provider status
or complete coverage of every app control. This audit reproduced additional gaps,
fixed three classes of source defects and tested the configured model directly.

Scope: the current 0.1.113 checkout, including the preserved close-safety and
performance work. Reviewed planning schemas, semantic reviews, scoped execution,
live reads, workspace/configuration discovery, request controls, input authority,
native child status and the existing acceptance contracts. No installation,
release, user-conversation replay or work in the user's open terminals occurred.

## Findings and user impact

| Priority | Finding | Evidence and status |
| --- | --- | --- |
| P1 | Ordinary answers can invent features or error causes | Reproduced with the configured Mercury 2.5, including after clearer instructions. **Unresolved.** |
| P1 | A delayed read could return a previous pane/conversation as successful | Five failing regressions before repair; all pass now. **Fixed in source.** |
| P1 | A Claude child approval without a tool ID can disappear after an unrelated tool return | Reproduced again with the production runtime and native-shaped events. **Unresolved.** |
| P2 | Workspace counts could omit background work and count obsolete root activity | Reproduced and fixed; pending questions now match the current generation. **Fixed in source.** |
| P2 | The model could not read its own configured model/settings through workspace discovery | Added allowlisted configuration and explicit capability limits. **Fixed in source.** |
| P2 | Natural conversation does not expose every request/UI control | No planning/execution tools for request cancellation/retry or Orchestrator settings mutation. **Capability gap.** |
| P2 | Inactive-only cleanup cannot currently establish eligibility for ordinary structured chats | Production predicate rejects an idle, ready Fusion-shaped session lacking native process evidence. **Restricted coverage.** |
| P2 | Semantic lifecycle protection is uneven | Conditional-close review covers close grants; it is not a universal interpretation proof for restart, interruption or project removal. **Architectural limit.** |

### 1. Factual answers remain unreliable

Two synthetic prompts were tested twice with the configured
`inception/mercury-2.5` through the production interpretation/execution path:

- A question about listening after every reply. Initially the answer recommended
  adjusting an “Always-listen-after-reply” setting, which does not exist. After
  explicit absence wording, it still suggested platform settings/support instead
  of clearly stating that this behavior is unimplemented.
- A question about a prior generic interpretation error. Initially the answer
  invented a conflict with voice settings and a security/privacy rationale. After
  the prompt change it still guessed a voice-state/wake-word cause and suggested
  different phrasing/settings. The supplied generic error established none of
  those causes.

All runs dispatched zero close/create/send effects. The existing fixture marked
them passed because its assertions covered valid planning and absence of effects,
not factual accuracy. The fixture now labels these cases
`acceptanceScope: planning-and-effect-safety-only` and
`factualCorrectness: requires-review`, including in its console output.

This is a reproduced answer-quality problem, not proof of a microphone defect.
It also demonstrates why passing thousands of scripted tests cannot establish
that the model will understand every natural request or tell the truth about the
product. Four small, deliberately related probes are not a production error-rate
estimate or a comparison against other models.

**Next repair:** application-rendered answers for supported capability/configuration
facts and recorded error categories, with an explicit unknown-cause fallback.
The model should select facts/answer types within a narrow contract; unavailable
features and unknown causes should not become unrestricted explanatory prose.
Private diagnostic logs should remain private. A stronger model or another prompt
alone is not a verified fix.

### 2. Live-read ownership now gets checked after the wait

`orchestratorWorkspaceExecutor.cjs` previously captured a target, awaited its
adapter read, then returned success and potentially issued an observation token
without revalidating the current owner. A generation change, native `/new`-style
conversation change, pane removal, wrong adapter ID or wrong adapter generation
could therefore leave stale content labeled successful.

The executor now captures the pane/launch/native identity before the read and
checks it against the current session afterward. Stale reads return
`stale-generation` or `conversation-changed`, without the stale text or a usable
observation token. Production uses a direct per-ID directory getter, preserving
the prior performance repair instead of adding another whole-UI inventory round.
Ordinary metadata/title changes and first native identity discovery remain valid.

The existing input/grant checks already blocked many later effects using changed
identities. This repair also protects the read result and its attribution; it
does not claim that the old behavior necessarily dispatched input to a replacement.

### 3. Workspace discovery is more truthful and useful

`read_workspace` now counts current display status, which includes child/background
work, instead of relying solely on root `turnState`. Closed/failed/paused panes
with old running states are excluded. Current pending interactions are counted by
pane and generation, so an old question cannot make a replacement look blocked.

The result also exposes a small allowlist of Orchestrator configuration:
configured model, enabled/ready state, monitoring setting, spending limit, speech
model IDs and hands-free setting. It omits credentials, microphone device IDs and
arbitrary settings/UI fields. Capability metadata explicitly describes:

- Settings can be read and their UI opened; mutation through a model tool is absent.
- Request cancellation/retry is exposed through UI controls, not planner tools.
- File content can be read; file search searches names, and code edits are delegated.
- General external-app UI control is absent; revealing folders is supported.
- There is no always-listen-after-reply setting.

Providing these facts improves the available evidence. The live tests above show
that the free-form answer can still disregard them.

### 4. Approval and conditional-cleanup coverage still needs work

The native-shaped child approval reproduction sends a waiting Bash approval with
no `toolId`, then a running companion for an unrelated Read tool return. The
production runtime changes `beforeUnrelatedReturn: true` to
`afterUnrelatedReturn: false` for the retained approval. The current child-running
branch treats missing approval identity as permission to clear attention.

This was also documented in the earlier
[Claude status investigation](claude-terminal-status-investigation.md). A proper
repair needs trustworthy child/tool correlation and tests for concurrent requests,
out-of-order hooks and missing IDs. Guessing by tool name alone or simply keeping
all approvals forever would trade this failure for a different incorrect status.
This audit does not loosen those evidence requirements or claim that gap is fixed.

Inactive-only close currently requires native process-state evidence that ordinary
Fusion/Open Fusion directory entries do not provide. Structured chat draft state
also is not covered by the native input decoder. Consequently legitimate cleanup
can be refused. Explicit unconditional closure remains a different supported
operation; it should not be offered as an automatic substitute for a constrained
request. Generalizing the inactivity contract requires generation-bound structured
draft/readiness evidence, not removal of its safety checks.

The separate close review is useful but operation-specific. Selection/authorization
for other lifecycle operations still depends on their current planner/grant
contracts. This is a source-level coverage limit, not a newly observed destructive
production action in this audit.

## What users can still encounter

- Unsupported settings advice or a confident explanation of an error whose cause
  is actually unknown.
- A request that needs clarification or fails interpretation despite understandable
  wording; bounded schema/semantic retries do not cover every model response.
- Pending child work/approval whose status is unknown or displayed incorrectly.
- A natural request to manage the Orchestrator queue that is only supported by
  a UI control. Cancelling tracking and stopping a running agent are distinct.
- A refused conditional cleanup, or native interaction blocked by busy input,
  an existing draft, an unrecognized CLI screen or stale evidence.
- Confusion between prompt delivery, a finished agent turn and independently
  verified implementation. The app tracks these separately; an agent turn ending
  does not prove tests passed or the requested code is correct.

Those risks coexist with real improvements: exact-generation and input ownership,
uncertain-write replay prevention, fresh reads, preserved task ownership and
conditional-close guards prevent many failures from turning into effects. Native
ConPTY foreground-consumption limits, CLI-version differences and model judgment
remain. There is no evidence here for an issue-free reliability claim.

## Verification and evidence

- The initial seven capability regressions all failed before their repairs.
- `npm run check:orchestrator` passed **2,004 backend tests**, the performance
  regressions, build, frontend/voice/telemetry and isolated Electron checks.
- The final capability file passed **nine tests**, including two additional checks
  that metadata updates/first identity discovery remain usable. No production
  change followed the full acceptance run.
- Four live executions across two cases cost **$0.00193033** total, within the
  announced $0.03-per-case combined limit. They used synthetic inventory/history
  and adapters, with no user-terminal effects or microphone input.
- The existing Vite large-bundle advisory remains. This run did not repeat the
  hidden-compositor animation test or install/package the candidate.

Artifacts:

- `.tmp/orchestrator-capability-gaps-before.log` — seven initial failures.
- `.tmp/orchestrator-capability-gaps-final.log` — nine final regression passes.
- `.tmp/orchestrator-capability-acceptance.log` — complete acceptance gate.
- `.tmp/orchestrator-recovery-live/1789057381100-22840/report.json` — initial voice-behavior probe.
- `.tmp/orchestrator-recovery-live/1789057381261-56168/report.json` — initial error-explanation probe.
- `.tmp/orchestrator-recovery-live/1789057697390-1868/report.json` — repeated voice-behavior probe.
- `.tmp/orchestrator-recovery-live/1789057697788-47944/report.json` — repeated error-explanation probe.
- `.tmp/orchestrator-capability-audit/1789057943867-8/report.json` — child-approval and capability coverage evidence.

Run `node scripts/diag/orchestrator-capability-audit.cjs` to reproduce the offline
coverage evidence. Its negative results describe remaining gaps; they are not
passing acceptance assertions. The source repairs do not affect the installed
0.1.113 process until a new build is installed and running.
