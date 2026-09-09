# Orchestrator recovery implementation review

September 9, 2026. **Source and local packaged-build acceptance: PASS. Installed application replacement: pending user approval.** This review records the implementation following the [accepted recovery plan](orchestrator-recovery-fix-plan-2026-09-09.md). The local candidate retains version `0.1.104`; no public release has been published.

## Complete close scope and observed termination

The application resolves a close scope against the complete pane inventory. Project membership, global-board membership, all-workspace scope, and explicit pane IDs are separate selectors. Dormant panes count; runtime-only orphan records do not silently expand a visible-pane request. Scope freezes pane ID, launch token, and available runtime generation. A replacement or newly created pane cannot become an unintended target of an older close.

[orchestratorCloseScope.cjs](../backend/orchestratorCloseScope.cjs) supplies scope compilation and remaining-scope accounting. [closeSessionOperation.ts](../frontend/closeSessionOperation.ts) coordinates pane removal and observed stopping, with integration through [orchestratorIntegration.cjs](../backend/orchestratorIntegration.cjs), [preload](../preload/preload.cjs), and [main](../backend/main.cjs). A committed UI removal is evidence about the pane, not proof that its processes exited.

[observedStop.cjs](../backend/observedStop.cjs) retains original resource identity independently of live session maps. Native PTY, Fusion, and Open Fusion hosts participate in correlated stop observation. The pending-launch fence must settle before absence can qualify. Fusion's executor adapter and its supervised children have a separate observed-stop boundary; [agentTelemetry.cjs](../backend/agentTelemetry.cjs) captures the original adapter URL and authenticated launch nonce. A later query cannot switch to the replacement session's adapter.

On Windows, verified stopping requires process-tree termination acknowledgment and observation of the original root's exit. A boolean stop response, synthetic `closed`/`exited` notification, or root disappearing from the session directory is insufficient. A root that already exited naturally without process-tree proof remains unknown. On other platforms, signaling the root does not supply equivalent process-tree proof; the stronger closure claim remains unavailable. Arbitrary detached processes outside the terminal's supervised ownership are outside this claim.

Late evidence uses the same operation ID. [orchestratorCloseReconciliation.cjs](../backend/orchestratorCloseReconciliation.cjs) performs bounded observation-only reconciliation: it cannot rerun close, create a fresh stop operation, or launch a terminal. Cancellation and timeout do not turn missing evidence into success. Original process evidence remains separate from request control cancellation, and later observation must retain the original identity.

## Truthful results in text, voice, and history

[orchestratorCloseOutcome.cjs](../backend/orchestratorCloseOutcome.cjs), [orchestratorFinalResponse.cjs](../backend/orchestratorFinalResponse.cjs), and [orchestratorCommandCompletion.cjs](../backend/orchestratorCommandCompletion.cjs) derive close publication from application evidence. Full success requires committed pane removal or observed absence, verified stop or positive process absence, and settled launch preparation.

Partial removal, unknown process state, failed stops, and superseded targets produce factual explanations. The denominator is the original frozen scope. Newly opened panes remain visible in the explanation; they are not retroactively added to the close operation. A model's success prose cannot override unresolved evidence. Text, speech, request outcome, and the short completion cue must agree; a successful snapshot close with new panes remaining still needs its explanatory text.

[orchestratorConversationStore.cjs](../backend/orchestratorConversationStore.cjs) stores bounded historical close identity, outcome enums, observation time, and counts. It excludes executable scope grants and arbitrary nested fields. Older receipts acquire no invented verification evidence. On restoration, a historical `finished` or `completed` task with a nonempty error becomes `paused`; its error, instruction, summary, and conversation remain intact, and no retry authority is reconstructed. Normal error-free finished history keeps its status. This conservative projection does not rewrite the saved transcript on read. Operational diagnostics remain bounded, sanitized metadata rather than transcripts.

## Continuation ownership and result dependencies

[orchestratorContinuation.cjs](../backend/orchestratorContinuation.cjs) separates control transfer from native results. Preparation validates without changing the predecessor. A synchronous commit rechecks ownership and revision, installs successor recovery authority, records bidirectional lineage, and retires only transferred control. [orchestratorTasks.cjs](../backend/orchestratorTasks.cjs) batches notifications so consumers do not observe half a transfer.

A failed undispatched predecessor remains `failed`, retaining its error and transferred disposition. An answered clarification with no native result becomes `continued`, not fictitiously successful. Native waits and workspace occupancy remain on the submission's producer. Continued records are terminal for control scheduling and do not consume the active queue allowance. History retention follows live continuation lineage, including recovery with an existing unbound creation.

Failures before commit leave the original owner intact. Failures after commit leave recovery on the successor. Concurrent retries cannot both consume the same pending revision. Partial multi-target work transfers only remaining eligible slots; uncertain delivery remains blocked against replay. Queued admission transfer preserves original constraints and differs from an already admitted operation or a terminal delivery queue.

Whole-request dependencies retain their original result scope. If required unsubmitted work transfers, completion of the submitted subset cannot satisfy the predecessor's whole result. The dependent pauses rather than silently following descendants or aggregating invented success. A complete original producer whose ancillary control transfers can still qualify, subject to exact native result attribution. Restored history and empty waits never supply live verified results.

Staggered assignment failures preserve earlier creations instead of abandoning or duplicating them. A created-but-unbound worker retains its receipt/reservation identity for exact recovery. A later grant's discovery failure does not erase earlier effects or replay successful siblings. Main integration remains in [orchestrator.cjs](../backend/orchestrator.cjs), alongside the existing queued-recovery, routing, and consumed-operation guards.

## Assignment and operator reliability

A fully specified new worker uses an application-owned create decision, bypassing conversation-discovery model calls. It still passes common launcher, project, reservation, creation-receipt, identity, readiness, and submission validation. This is a per-grant decision; mixed or multiple requested workers retain independent objectives and identities.

[orchestratorRoutePlanner.cjs](../backend/orchestratorRoutePlanner.cjs) measures semantic discovery progress. Repeated unchanged reads, timestamp-only changes, and invalid operations do not constitute new usable evidence. Advancing pagination and changed observations remain useful. Exhaustion reports actual assignment/effect state without claiming that already-created workers never existed.

Two later refinements address avoidable model omissions while retaining application authority:

- [orchestratorOperator.cjs](../backend/orchestratorOperator.cjs) can supply omitted observation metadata only from a valid unused read in an earlier executor model round. Routing reads, same-round reads, stale/used tokens, failed or superseded reads, and changed input authority cannot seed this fallback. Explicit model-supplied metadata is not silently replaced.
- [orchestratorFastPath.cjs](../backend/orchestratorFastPath.cjs) and main orchestration can finish the delegated submission's control step from application-owned verified submission evidence. This does not finish the native task. Its native work remains tracked as pending; the short `done` cue acknowledges the completed submission command, with task results reported separately.

New creation proposals containing text receive a targeted purpose check before any effect. Creation text is an unsent draft, so requested execution must compile to an executable task instead. Ambiguous terminal types or draft intent produce an application-owned question. This check only vetoes an inappropriate proposal; it does not mint authority or silently rewrite actions. Unsupported or catalog-missing launchers likewise clarify before any sibling creation, and malformed JSON still uses the bounded interpretation-repair path. The purpose check itself uses the configured model and is subject to the interpretation boundary below.

## Final verification

The parent personally ran the checks below after integrating the fixes and repairing the failures found by independent review. The working tree is based on `aac91eb2cf02ebe4bd58bcfa748a5817a5bdd569`; this is an uncommitted local candidate, not a tagged release.

| Check | Result | Evidence and boundary |
| --- | --- | --- |
| `npm run check:orchestrator` | PASS: 1,870 backend tests, plus frontend, voice, build, runtime, Electron and session-resume checks | [Full check log](../.tmp/orchestrator-recovery-20260909/check-complete.log) |
| Configured Mercury model probes | PASS: all seven scenarios | [Sanitized live report](../.tmp/orchestrator-recovery-live/1788964800935-39648/report.json); synthetic terminal adapters |
| Project close | Eight original panes closed in one model call | Includes four active and four paused fixture panes |
| Explicit close subset | Exactly two panes closed; other six preserved | One model call |
| New Codex worker | One creation, one verified submission, zero discovery-model calls | Five total model calls; native work remains pending |
| Natural retry after routing failure | One creation and one submission; failed source never becomes fictitiously finished | Initial validated intent/failure is scripted; retry interpretation/routing/execution use the actual configured model |
| Draft-purpose safeguards | Execution repaired into one submitted task; ambiguous type asks a focused question with no effects | Initial wrong draft proposals are scripted to exercise the real configured-model purpose check |
| Source Electron acceptance | Eight panes removed; four root processes and four spawned children stopped; newcomer preserved | [Source fixture report](../.tmp/orchestrator-close-smoke/1788960404998-25512/results.json) |
| Packaged Electron acceptance | Same eight-pane/process checks PASS; zero dormant late starts observed | [Packaged fixture report](../.tmp/orchestrator-close-smoke/1788965015788-11780/results.json) |
| Package/source comparison | All 116 application payload files match tested source; zero integrity failures | [Comparison record](../.tmp/orchestrator-recovery-20260909/package-source-verification.json) |

Local packaged candidate: `.tmp/orchestrator-recovery-20260909/package/win-unpacked`. ASAR SHA-256: `2d3c9532112afaeafd4ee2fa6262bd5e1a00c284945c3e0e1e628e9acff5ad09`. The comparison also checked individual archived/unpacked application-file integrity, rather than relying only on the outer archive hash or version number. The required embedded Codex binary was prepared from the existing isolated `0.144.0` release cache, matching the vendored schema; the user's global CLI was not changed.

Independent review reproduced and drove fixes for missing frozen scope during continuation, false success embedded in questions, optional grant-ID attribution, creation recovery through multiple clarifications and staggered startups, partial-result dependencies, canceled/late closure reporting, mixed constraints, and implicit read invalidation after temporary inventory disappearance. Regression tests cover these behaviors, not just source text.

Relevant families live under [scripts/backend](../scripts/backend) and [scripts/frontend](../scripts/frontend), with [real Electron closure QA](../scripts/qa/orchestrator-close-smoke.cjs) and [configured-model QA](../scripts/qa/orchestrator-recovery-live.cjs). The configured-model runs cost approximately $0.0062 for the final seven-case run. No user conversation, terminal output, reasoning, or credentials are included in that report.

## Verification limits and application handoff

The packaged fixture uses actual renderer/preload/main/native PTY processes and explicit frozen per-pane dispatch. Group intent and model behavior were tested separately with synthetic adapters; the package/source comparison ties that implementation to the tested executable. Hidden compositor screenshots were unavailable, so pane removal was checked through current application inventory and DOM state rather than visual screenshots. This work did not repeat a physical microphone/STT recording or a live Codex task against a real repository. Those provider-specific and microphone boundaries are not represented as passed.

Natural-language interpretation remains a model boundary: successful phrases do not certify every wording or transcription. Windows process-tree proof, naturally exited roots, separately supervised children and non-Windows behavior retain the conservative limits above. No crash-safe replay journal was introduced. Historical lineage and receipts do not restore executable authority; a crash between an effect and asynchronous persistence is never permission to replay it automatically.

The installed Lina process was still running from its original installation when this record was completed. Applying the candidate requires a restart that would terminate its active terminals, including this Codex session; approval was requested for that final disruptive step. Source/package acceptance does not claim installed-build acceptance. Public release/version/feed publication remains separate and follows [windows-release.md](windows-release.md).
