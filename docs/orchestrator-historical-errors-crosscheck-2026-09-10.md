# Cross-check of retained historical Orchestrator errors

September 10, 2026. This is a read-only reconciliation of the user's retained
conversation/error evidence with current source and the installed package.
Earlier work reviewed the documented incident investigations and tested their
repair mechanisms; it did not individually certify every historical error.

## Evidence actually inspected

- Saved conversation: **321 messages**, **214 receipts**, **120 task records**,
  covering September 6 at 23:45 through September 10 at 10:54 Toronto time.
- **24 task records contain an error**. Many are restored/paused historical
  records; this does not mean 24 tasks are currently failing. The stored task
  statuses include two failed requests, 25 paused, 73 finished, 19 cancelled and
  one needing an answer.
- Three rotating diagnostic files: **14,395 records**, including **nine error
  records across four requests**, from September 10 at 09:07 to approximately
  13:06. Older detailed diagnostics have rotated out. The nine records are not
  nine independent user failures: retries and final errors share request IDs.
- The process path points to the installed Lina Terminal directory. Its
  `app.asar` reports **0.1.113**. Eleven inspected Orchestrator modules match
  release HEAD `4dffab7` after newline normalization. The newer
  `orchestratorCloseSafety.cjs` is absent, and current coordinator/interpreter/
  planning-tool files differ from that installed release.

No user task was replayed, no native input was sent, no model call was purchased,
and no installed file or saved history was changed. Raw private prompts, pane IDs
and conversations are not copied into this document.

## What the remaining detailed logs establish

| September 10, Toronto time | Observed outcome | Fix assessment |
| --- | --- | --- |
| 10:34, performance investigation request | An initial send lacked its required read, followed by a reused step ID with different input. Both were rejected. A later send was written once, the interaction finished, and the agent produced the audit. Stored request status is finished. | **Recovered in the installed app.** These guards worked; their logged rejections are not evidence that this task failed. They must not be removed to hide errors. Model protocol mistakes can still recur. |
| 10:36, ordinary voice-behavior question | No valid interpretation initially; retry requested task status without known terminal targets; final generic interpretation failure. No action receipts. | **Conversation planning repair is in current source, not installed.** Synthetic equivalents pass planning, but subsequent factual answer quality remains unresolved. |
| 10:37, question about that error | Invalid task-status/effect combination, then missing/distinct target-ID validation failure; final generic interpretation failure. No action receipts. | Same source-only planning repair. **No evidence that speech clarity or microphone failure caused this incident.** Live answer probes still guessed unsupported causes. |
| 10:38, count correction | Duplicate request metadata was rejected; retry produced a clarification. Stored status is needs-answer, with no effect receipts for that request. | **Schema recovery occurred.** The clarification/count reasoning was not evidence of a verified inactive subset. |
| 10:38–10:39, subsequent inactive-close exchange | The earlier incident investigation and retained close receipts establish real removal of three panes, but do not establish that all satisfied the user's inactivity condition. | **Conditional-close review and runtime/input guards are in source, not installed.** This behavioral failure would be missed by looking only for failed task statuses. See the inactive-close investigation. |

The currently installed planning tools do not include the new conversation-only
planning path. The installed archive also lacks the new conditional-close safety
module. Therefore these recent repairs cannot protect the unchanged installed
process yet.

## Older errors: covered mechanisms versus unverified causes

| Retained incidents | Current assessment |
| --- | --- |
| September 9, 12:45–12:47: local context refusals at 49,081, 49,396 and 48,505 bytes against 48,000 | **Known mechanism repaired and included in installed 0.1.113.** Work-item context compaction and accurate local-context feedback are documented and regression-tested. Protected oversized requests can still legitimately fail locally. |
| September 9, 12:45: startup timeout, stale-observation rejections, then written input but unfinished operation | **Known startup/handoff repair included in 0.1.113.** Fresh unsent retries and application-managed handoff completion are covered. The exact native screen/delay was not retained, so no claim of replaying that exact startup. |
| September 9, 14:14: existing discussion conversation selected for independent code work, followed by unfinished operation | **Task-ownership/selection gate included in 0.1.113.** The historical wrong-recipient mechanism is documented. Semantic selection is still model-dependent within the guarded contract. |
| September 9, 18:25–18:26: schema error followed by selection veto exhausts shared retry | **Separate contract/semantic repair budgets included in 0.1.113.** Combined-failure regressions cover the sequence; repeated model failure can still stop safely. |
| September 8, around 21:50 and 21:53: OpenRouter timeouts | **Known forced-tool-choice compatibility mechanism repaired in 0.1.113.** The earlier investigation retained matching detailed timing and controlled comparisons. Provider/network congestion and unrelated timeouts remain possible. |
| September 7, 18:45–18:46: repeated stale-screen refusals while addressing busy Codex | **Related busy-input and freshness mechanisms improved and tested.** The old final explanation about a timer is model-written, not a retained native screen trace. I cannot certify that every historical refusal had that cause or that every current CLI composer is supported. |
| September 7, 16:13: duplicate Enter/submit, invalid step ID, stale observation, plus HTTP 400 | **Control validation/freshness fixes and protocol fallbacks exist.** The raw HTTP-400 provider explanation is absent, so its precise cause and exact repair cannot be certified. Invalid or reused explicit steps must still be refused. |
| September 7, 18:30: unsent input, stale read and invalid finish fields | **Mixed model errors and intended protection.** An occupied input buffer is not a bug to bypass. Modern operator schemas/field derivation help, but the exact old model payload is unavailable. |
| September 7, 19:05: proposed workspace arguments changed the authorized command | **Correct scope check, exact triggering payload unknown.** Current normalization/identity tests cover the guard. There is insufficient evidence to label the particular old composition defect fixed. |
| September 7, 21:50: unknown tools and expired conversation reference | **Recovery/discovery mechanisms covered; exact old failure not certified.** Fresh opaque references are required and guessed/expired references must remain invalid. |
| September 7, 21:56: input written but new agent work not observed | **Submission/attribution handling improved.** Transport acceptance still cannot prove foreground consumption. Without the original native screen/events, this particular case cannot be declared fixed. |
| September 8, 21:18: watch target is no longer the original observed turn | **Identity guard must remain.** A different turn cannot satisfy the original watch. Whether a completion callback was missed in that old episode is unverifiable from the retained material. |
| September 9, 08:02–08:03: discovery limit and prerequisite without a verified result | **Related routing/recovery classes are tested, exact episode unverified.** A missing result must not become an invented dependency success; the old full routing trace is unavailable. |
| September 7, 16:16, 16:17, 21:38: generic interpretation failures; September 7, 21:55: generic timeout | **Unknown specific causes.** The saved final strings alone cannot establish which schema, model/provider or context failure occurred. Do not assign a convenient diagnosis retrospectively. |

Source references and previous acceptance evidence:

- [Current conversation failures](orchestrator-conversation-errors-2026-09-09.md)
- [Task ownership](orchestrator-task-ownership-review.md)
- [Retry composition and architecture](orchestrator-architecture-review.md)
- [OpenRouter compatibility](orchestrator-openrouter-compatibility.md)
- [Inactive-terminal closure](orchestrator-inactive-close-investigation-2026-09-10.md)
- [Latest capability audit](orchestrator-capability-audit-2026-09-10.md)
- [Repair/cleanup roadmap](orchestrator-repair-plan-2026-09-10.md)

## Conclusions and verification boundary

Several specific historical mechanisms were fixed in earlier releases and are
already present in the installed 0.1.113 package. The recent conversation-planning,
conditional-close, read ownership, performance and readiness cleanup changes
remain source-only. The current checkout's full acceptance previously passed
2,010 backend tests plus build/frontend/Electron checks; this read-only comparison
does not turn those tests into a replay of every private historical request.

Some errors are deliberate safety refusals. Others remain unresolved or cannot
be diagnosed from retained evidence. In particular, live model probes demonstrated
incorrect capability/error explanations even after valid planning. There is no
basis to claim that all past errors are fixed or that none can recur.

The log-retention gap also matters: high-volume timing events share the rotating
error files. Preserve low-volume, request-linked safe failure facts independently
of performance samples so future investigations can identify the failed stage
without exposing private transcripts or attributing unknown causes to the user.

Ignored local evidence: `.tmp/historical-error-audit.json` contains sanitized
metadata/error groups, and `.tmp/installed-orchestrator-error-fixes.json` records
the selected installed/source comparisons. Original private files remain solely
in the existing application profile.
