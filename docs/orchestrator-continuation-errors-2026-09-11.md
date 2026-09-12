# Existing-agent continuation errors

September 11, 2026. Investigation of the two latest saved requests, around
14:17–14:19 Toronto time. The user asked the existing agent working on the project
chat section to continue. Source repairs below have not been released or installed.

## Retained evidence

The application profile contains 326 messages, 217 receipts and 122 task records.
The two latest requests, their receipts, rotating diagnostics and saved agent/work
identities were inspected. The installed archive is version 0.1.116. Its coordinator,
task-affinity reviewer, route planner, agent directory and agent queries matched
the corresponding source modules before this repair. Private transcript contents,
credentials and identifiers are not reproduced here.

| Time (Toronto) | Finding |
| --- | --- |
| 14:17:09 | The first interpretation combined task-status metadata with an effect/continuation. Validation rejected it and the contract retry recovered. This was a recovered model schema error, not the final failure. |
| 14:17:33 | Routing chose reuse, but the selected agent could not resolve to a unique live owner in the project. No effects were recorded. The original chosen reference was not retained, so an incorrect reference, ambiguous owner or changed availability cannot be distinguished retrospectively. |
| 14:18:27–30 | On the second request the routing model again chose reuse. The application then reserved **create**, with its explicit no-verified-same-task fallback reason, and opened a new Codex pane. This establishes that application code replaced the proposed owner. |
| 14:18:54 | One prompt write and an interaction-complete receipt were recorded for the new pane. The response correctly said task startup and its result remained unconfirmed. |
| 14:18:58 | The task monitor could no longer match the pane/generation and reported terminal changed. The user subsequently confirmed closing the unwanted new terminal because it was the wrong recipient. The diagnostic is the consequence of that closure, not a separate unexplained crash. |

The saved agent directory contains an agent titled “Add project chat section.”
That identifies a relevant conversation; the saved record alone cannot establish
its live run state at either failed selection.

## Confirmed code issues and repair

- `plan_continue_task` previously decoded to ordinary automatic assignment. The
  requirement to continue an existing agent was lost. It now produces
  `assignmentMode:existing`, which forbids replacement creation both at routing
  and at the application-only creation claim.
- The application converted both independent and uncertain affinity reviews
  into new agents, and could also convert routing clarification into creation.
  Existing-agent requests now preserve clarification and stop before input when
  ownership cannot be verified. Automatic assignment also preserves uncertain
  affinity instead of treating it as independent work. Verified independent work
  retains automatic creation.
- Invalid agent-reference choices used to fail after leaving the discovery loop.
  Live owner/project validation now runs inside the bounded loop so the model can
  read fresh agent IDs and correct its choice. Pane IDs and native conversation
  IDs still cannot stand in for agent IDs. Ambiguous owners remain refused.
- Routing now receives the original user instruction alongside the shorter worker
  prompt, preserving how the user described the recipient. Diagnostics record
  reference-validation categories and affinity decisions without transcripts.
- A live follow-up probe exposed missing evidence even after selecting the right
  agent: `find_agents -> read_agent -> choose_existing_agent` left the ownership
  reviewer with empty task text. The application now obtains the candidate's
  native output before review when the router has only read metadata. It checks
  the run/conversation binding again and refuses stale or unavailable evidence.
  The current conversation title supplies context; approval still requires a
  quotation from observed task text, not a title alone.

## Verification and limits

The focused planning/routing/assignment suite passed 55 tests. The complete
`npm run test:orchestrator` passed 2,082 backend tests plus its 29 performance
checks. A subsequently added full-pipeline regression also passed in the final
17-test agent integration suite: actual planning tools select an existing-owner
continuation, a mistaken pane ID is rejected inside discovery, the correct agent
is found and read, and exactly one prompt reaches that agent with no creation.

Other regressions cover uncertain and mismatched ownership, preserved
clarifications, attempted creation, a directly started task without a work-item
record, busy recorded owners and independent work. Follow-up regressions also
verify metadata-only routing obtains native evidence, changed/unavailable native
reads stop before review/input, and titles cannot replace observed task quotes.
The final focused integration/affinity run passed 20 tests.
The complete follow-up `npm run test:orchestrator` passed 2,086 backend tests
and 29 performance checks. Routing fixture self-tests, the frontend routing
smoke and `git diff --check` also passed.

`node scripts/qa/orchestrator-routing-live.cjs --existing-owner` exercises the
actual planning, routing, affinity review and handoff with the configured
`google/gemini-3.8-flash` and four disposable existing agents. The first run
reproduced the empty-review-evidence clarification (five calls, $0.0094725).
After the evidence repair, it passed: five calls, $0.01059525, one prompt sent to
the existing chat-section owner, zero creations and no unrelated input. The
fixture has no Orchestrator work-item record for that directly started task.
The agent output describes remaining composer work without repeating the title.
Reports are under `apps/desktop/.tmp/orchestrator-routing-live/`, in runs
`1789151841936-16220` (reproduction) and `1789151921854-39224` (pass).

This is live-model evidence with disposable adapters, not a guarantee of every
future interpretation or installed native-terminal behavior. The terminal
identity guard remains unchanged. No input was sent to the user's terminals,
and no installed files or saved conversations were changed.

Local test log:
`apps/desktop/.tmp/orchestrator-continuation-2026-09-11/backend-tests.log`.
Follow-up log: `backend-tests-followup.log` in the same directory.
