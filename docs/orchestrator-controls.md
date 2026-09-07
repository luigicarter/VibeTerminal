# Semantic Orchestrator and terminal controls

See [conversations and queued tasks](orchestrator-tasks.md) for request ownership,
parallel execution, dynamic project context, persisted history and voice clarifications.

The Orchestrator is a user-directed workspace operator. Users can ask it to send
work to one or several terminals, choose a terminal on their behalf, navigate the
workspace, inspect terminal output, and submit the answers they provide. They do
not need a particular command verb or colon-delimited syntax.

## Interpretation and execution

The selected Brain first returns an `interpret_workspace` command plan. An invalid
tool envelope, JSON or plan gets one repair attempt using the original authorized
context and a fixed schema reminder. Both attempts pass the same strict validator;
malformed output never supplies authority. Repeated failure gives a short retry
message and preserves the detailed reason in private diagnostics. This
request contains the current user instruction, bounded recent user/assistant context,
application-owned unfinished work, and typed project/session/question metadata.
Verified prerequisite results may enter preparation of an explicitly dependent task.
Assistant replies and prerequisite results provide reference data, not instructions
or permission. Private diagnostic logs never enter model context.

`orchestratorIntent.cjs` normalizes that plan into immutable grants with app-minted
IDs, frozen terminal generations, bound prompts or literal user answer sources,
and operation-specific arguments. A `selection: one` grant chooses one eligible
target once; `selection: all` creates one submission slot per target. The main
workspace tool loop can then read output and execute those grants. It cannot
change their target set, task payload, answer values or permission scope.
Project creation binds an omitted parent to the application's Documents folder
before minting its grant; the executor cannot substitute another parent.

The interpreter can compose a useful prompt from a user's goal, including a
review request and its constraints. Answers are stricter: their source text must
appear in the current user instruction or the identified unfinished user command.
The executor maps that source to the currently observed options. This separates
natural-language understanding from deterministic identity and dispatch checks;
the quality of language interpretation still depends on the selected model.

Up to 24 grants and 12 workspace rounds of six tool calls are permitted in one
turn. Existing model-input and spending limits still apply. Interpretation uses
one extra Brain request; it does not run another semantic check for every key or
terminal operation. Small-context models can reject locally before any effect if
protected instructions and grants cannot fit.

## Follow-ups and unfinished work

The original request remains available through clarification replies. For example,
counting the six project terminals, asking one to review the last changes, then
saying `pick a random one` yields one bound review submission. The complete task
and qualifiers survive, without asking the user to repeat them.

Partial work retains only unfinished grants/target slots. Focusing a pane does not
discard its unsent review; completing the first of two reviews retains the second.
Further clarification can identify the same original source explicitly. Unrelated
requests retain separately owned unfinished work. Explicit cancellation clears unsent
work for the selected request. A restarted terminal cannot inherit an old dispatch slot.

Grants are claimed at the dispatch boundary, including uncertain outcomes. Repeated
equivalent tool calls may return the recorded receipt but cannot resend the action.
The newest action receipt and a short older receipt history enter later executor
context so the model can explain a failure accurately. These receipts are evidence,
not authorization to retry. The private diagnostic log remains separate.

## Terminal operations

| Operation | Fusion / Open Fusion | Standalone agents and shells |
|---|---|---|
| Discover, focus, navigate workspace | Workspace APIs | Workspace APIs |
| Read current activity/questions | Native chat events and structured requests | Decoded current screen |
| Send a requested prompt | Structured input/steering | Existing readiness-checked PTY delivery |
| Submit a user's answer | Current request/revision/options validated by `answer_question` or `permission` | Fresh screen plus `terminal_interact` |
| Navigate menus or type literal input | Use structured controls | Named keys and bound user text |

Structured multiple-choice answers accept labels, option numbers and multiple
labels such as `Unit and Smoke`. Allowed custom answers do not require saying
`custom answer`. A semantic permission answer of `yes` applies only once to that
specific current request; it cannot become an always-allow decision. The existing
literal voice answer path remains fast, while unmatched natural wording reaches
the semantic Orchestrator with the current question identity.

`terminal_interact` covers Codex, Claude, Cursor, Gemini, Kimi/custom Kimi, Qwen,
OpenCode and plain shells through their native PTY. It requires a fresh
`read_session` screen sequence, matching runtime generation/revision, and a live
root PID. An observed silent terminal starts at sequence zero, which is valid.
Waiting menus do not use the idle-only new-prompt route. A human draft blocks
automated input. Assistant text staged through this route also blocks an
unrelated background prompt until submitted.

Native input is bounded to 4096 UTF-8 bytes of literal single-line text and named
keys: arrows, Tab, Shift-Tab, Enter, Escape, Home, End, Backspace and Space. A grant
permits at most 16 key/input steps per target. Navigation-only grants cannot
submit; the user must supply an answer or explicit input instruction. Enter is
final and may occur once; combining Enter and `submit` is rejected. The model reads
the screen again after navigation or submission.

PTY receipts mean transport acceptance. Windows ConPTY does not provide atomic
foreground-recipient proof, and a successful write does not prove that an agent
consumed the answer or completed its task. Unknown results are not automatically
retried. Structured host acknowledgments preserve their native meaning.

Saved-history resumption still has its separate exact title/ID selection and
revalidation contract. External applications, clipboard operations and global
keyboard injection are outside these terminal controls.

## Files and verification

- `backend/orchestratorIntent.cjs`: semantic schema, normalization, frozen grants,
  pending-source inheritance, literal answers and dispatch claims.
- `backend/orchestrator.cjs`: interpretation/execution loop, unfinished work,
  structured answer mapping, action receipts and diagnostics.
- `backend/orchestratorTerminalInput.cjs`, `backend/ptyHost.cjs`: guarded native
  input, terminal modes, draft protection, sequence validation and acknowledgments.
- `backend/orchestratorIntegration.cjs`: structured/native adapters and shell PID
  retention; `voiceController.cjs` routes natural voice follow-ups.

`npm run test:orchestrator` runs the default compiler/executor regression scenarios,
grant validation, native helper/PTY tests, provider bridge matrix, voice lifecycle,
history and diagnostic tests. Existing protocol fixtures use a test-only semantic
interpreter stand-in; `orchestrator-semantic.test.cjs` separately exercises the
default HTTP interpretation and execution path using scripted Brain responses.

`node scripts/qa/orchestrator-command-smoke.cjs --hidden` runs the isolated real
Electron/preload/PTY command checks without displaying a test window. It verifies
delivery, output, refusal, cancellation, saved-history resumption and pane binding.
That mode explicitly skips screenshots, foreground/clipboard checks and
microphone/overlay activation; the normal visual smoke retains those checks.

The original conversation, all-six submission, supplied/custom/multiple answers,
multiple clarifications, partial completion, error readback and replay protection
are covered by these tests. Live configured-model interpretation and physical CLI
menu behavior remain separate acceptance boundaries. No live terminal tasks are
sent by the isolated fixtures.
