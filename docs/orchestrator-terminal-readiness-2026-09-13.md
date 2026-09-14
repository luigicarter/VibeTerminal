# Orchestrator terminal readiness, 13 September 2026

On the installed 0.1.121 build the Orchestrator could not reliably get a first
prompt into a terminal. Four separate defects produced the same experience: a
pane opens, nothing is typed into it, and about a minute later Lina says the pane
did not become ready. This is what each one was, what the evidence showed, what
changed, and what is still unproven.

Everything here is source work in `apps/desktop`. Nothing is released or
installed; the installed build still behaves as described under "what broke".

---

## 1. Claude panes never became ready

`backend/orchestratorPromptReadiness.cjs` required the string `? for shortcuts`
on screen before it would accept Claude's composer. Claude Code stopped printing
that hint in 2.1.269. Every send to a Claude pane therefore waited the whole
startup budget and failed with a launch timeout, having typed nothing.

The reason it was not caught is that the test fixture was written by hand, from
reading Claude's bundled input component, rather than recorded from the CLI. A
handwritten fixture cannot go stale; the product can.

**Evidence.** Claude Code 2.1.270 was recorded headlessly at two geometries. The
footer is `⏵⏵ auto mode on (shift+tab to cycle) · ← for agents` at 120x36 and
`⏸ manual mode on · ← for agents` at 100x20. Neither carries a shortcut hint. The
composer itself is unchanged: `❯`, a non-breaking space, a dim placeholder, the
cursor in the third cell, a horizontal rule above and below.

**Change.** The footer is now optional evidence — `? for shortcuts`, either mode
line, or nothing at all. What is still required is the product name on screen,
the two rules, the pointer (`❯` or the ASCII `>`) followed by a space or NBSP,
and the cursor at exactly `indent + 2`. A placeholder after the cursor is fine; a
draft would move the cursor past it.

The handwritten fixtures are gone. `scripts/backend/orchestrator-prompt-readiness.test.cjs`
now replays real PTY recordings through `backend/terminalObservation.cjs`, and
`scripts/backend/orchestrator-startup-input.test.cjs` and
`scripts/qa/native-chat-selection-smoke.cjs` use the same recordings instead of a
hard-coded footer string.

---

## 2. Only four kinds waited for a composer at all

`supportsNativePromptReadiness` covered `codex`, `claude`, `claude-custom` and
`terminal`. Every other kind — Grok, Kimi, Kimi custom, Qwen, OpenCode, Cursor,
Open Codex, Gemini, Codex Web — skipped the wait entirely and typed as soon as
the process had a PID, into whatever the TUI happened to be painting: a folder
trust prompt, a login screen, an update dialog. The startup-screen report and the
folder-trust answer never ran for any of them, and the `unsupported` branch was
unreachable in production.

**Change.** Every kind whose pane is a real PTY now waits. Recognizers were added
for Grok, Kimi (and Kimi custom), Qwen, Gemini and OpenCode, each grounded in a
recorded screen, and Open Codex and Codex Web reuse the Codex recognizer because
both run the Codex TUI. Kimi hides the terminal cursor while its composer is
focused, so for that form alone the composer box and the cursor column are the
evidence and a hidden cursor is accepted.

A kind with no verified recognizer — Cursor Agent, whose composer has never been
captured here — reports `unsupported`, and `waitForNativePromptReady` now treats
that as "type as before" rather than as a failure: once the process is running
and the screen is neither blank, nor a startup screen, nor a pending decision,
the prompt goes in and the receipt carries `unverifiedComposer`. So those panes
keep exactly the behaviour they had, and gain the startup-screen guard.

Four startup screens were added to the catalogue, three of them found by the new
probe walking into them:

| screen | seen on | what the pane now says |
| --- | --- | --- |
| `Finish signing in via your browser` / `Sign in with Device Code` | Open Codex | it is asking to sign in |
| `Press any key to log in...` | Cursor Agent | it is asking to sign in |
| `Select Auth Method` / `How would you like to authenticate` / `Select login method` | Gemini CLI, Claude Code | it is asking to sign in |
| `Allow external CLAUDE.md file imports?` | Claude Code 2.1.270 | it is asking whether to allow imports from outside this folder |
| a numbered `Update all` / `Skip this version` / `Remind me later` menu | Qwen Code 0.21.12 | it is offering to update itself |
| `Hooks need review` | Claude Code | it is asking to review its startup hooks |

The update-offer rule matches only a numbered menu option. The plain "update
available" banner Grok and Qwen print beside a ready composer is not a screen
anyone has to answer, and a test fixes that distinction.

---

## 3. A never-prompted pane could never be reused

`backend/terminalRuntime.cjs` parks any hook event that carries a provider thread
id it cannot yet prove belongs to the root conversation. That is correct: a nonce
proves pane ownership, not thread ownership. But the parked event also left
`turnState` at `unknown`, and `idlePaneCandidate` required `observation ===
'observed'` plus an idle turn state. For Claude the proof is a transcript file
that only exists after the first prompt, so a freshly opened Claude pane could
never satisfy either condition. The resolver concluded there was no idle pane,
answered "No idle Claude pane is free" and opened another one — beside an empty
one. The warm spare keeper was affected the same way, so its spare was never
reusable either.

**Change.** When a pane's own session-start hook arrives for the root with no
child, no turn and no conversation id, the turn state is recorded as `idle` while
the identity stays provisional. Nothing else about the parked event changes.
`idlePaneCandidate` then accepts a provisional pane only while it has never had a
turn — no turn id, no start, no end — and only when its agent process is running
and its binding is not contested. A pane that has taken any turn still needs
confirmed observation, because reusing it means joining a conversation we must be
able to name. `sessionReady` and the creation wait's `processReady` accept the
same fresh-pane case, so a newly created pane finishes its launch instead of
timing out.

---

## 4. A cancelled task kept its pane forever

The resolver built its owner map from every work item that had a binding,
regardless of status. An item whose prompt was cancelled or failed — so never
delivered — went on reserving its pane against work that would never arrive. The
spare keeper's owner set had the same flaw.

**Change.** For the idle-reuse rule, items with status `cancelled` or `failed` no
longer own their pane, in the resolver, in the spare keeper, and at the three
places in `backend/orchestrator.cjs` that answer the same question. `finished`
items keep their pane everywhere: that is the conversation their result lives in.
A released item is still an owner for the title rule, so "go back to the agent
working on X" still finds it, and live owners are preferred when both bind the
same pane.

---

## 5. "Yes. And also…" lost the whole request

`backend/orchestratorIntent.cjs` refused any reply that both continued a
read-only pending command and added new terminal work, because one request-level
access field could not describe both. The user hit it on 13 September. Lina had
asked:

> Claude Code in vibeTerminal is running and waiting at the prompt. Would you
> like me to send the prompt to investigate the performance and voice detection
> cutoff issues now?

and the reply was:

> Yes. And also make a new cloud code terminal to look at the conversations I
> have with the orchestrator and basically just get one of the cloud code
> terminals to work on that while the other works on the other things.

Both halves were lost, and the only thing the user saw was "I could not interpret
that request. Please try again." The validator's actual sentence went to the
diagnostics file.

**Change.** Access is recorded per grant. The grants that continue the pending
command keep its read-only scope (and their own inspection scope); the new work
carries the request's own scope; the request itself is the wider of the two, and
each pane's workspace lane takes the access of the grants that actually own that
pane. One thing is still refused: new mutating work *inside the pane the reply is
only reading*, which would widen the lane the pending command is holding. The
existing continuation-constraint tests all still pass, and the exact utterance
above now compiles to the answer plus a `delegate_task`.

Separately, the specific reason now reaches the user. The conversation message
already carried it; the task row did not. Both are now rendered from one
catalogue entry in `backend/orchestratorFailureText.cjs`, so the row a user reads
later says what could not be represented rather than only the stable generic
line. The request result keeps that generic line.

---

## Per-provider readiness

Measured by `npm run smoke:provider-startup` on Windows 11, 13 September 2026.
Each row opened a real pane through the app's own shim directory and ConPTY host,
in a scratch git repo under `apps/desktop/.tmp/provider-startup-probe`.

| Kind | Composer recognizer | Grounded in | Probe result |
| --- | --- | --- | --- |
| `codex` | Codex header + `›` composer | recorded, Codex 0.154.0 | ready 5.9 s, prompt accepted |
| `claude` / `claude-custom` | name + rules + `❯`/`>` + cursor | recorded, Claude Code 2.1.270 | ready 4.3 s, prompt accepted |
| `grok` | `Grok` + box composer | recorded, Grok Build 1.0.25 | ready 3.5 s on 1.0.30, prompt accepted |
| `kimi` / `kimi-custom` | box composer, hidden cursor accepted | recorded, Kimi Code 0.42.0 and bundled 0.42.0, re-recorded 2026-09-13 at cursor (5,16) / (5,17) | ready 4.3 s on 0.42.0; prompt accepted on the 0.27.0 / 0.29.0 run |
| `qwen` | rules + `>` + cursor | recorded, Qwen Code 0.21.12 | ready 5.8 s on 0.23.3, prompt accepted |
| `opencode` | `┃` rail + `╹▀` close + cursor | recorded, OpenCode 1.18.25 | ready 6.1 s on 1.18.30, prompt accepted |
| `gemini` | **unverified** — reuses the Qwen form | Qwen Code is a Gemini CLI fork; the CLI is not installed here | skipped, not installed |
| `open-codex` | reuses the Codex form | verified live: `npm run smoke:chat-resume:native` reaches a ready composer through the app's own launch path | skipped by the probe, not signed in on the real account |
| `codex-web` | **unverified** — reuses the Codex form | `scripts/qa/codex-web-tui-smoke.cjs` drives the Codex header and `/model` picker | skipped, needs a signed-in session |
| `cursor` | **none** | only its login screen exists here | skipped, not signed in |
| `terminal` | standard PowerShell prompt | unchanged | not probed (plain shell) |

A `codex` pane runs the bare `codex` command from the user's PATH through the
shim, which is what the probe launches. The bundled `vendor/codex-bin` is not
what a pane runs: it backs Fusion, the model catalog and Codex Web.

### Probe output

```
KIND         CLI VERSION                          VERDICT                                                                                           SECS  TYPED  ACCEPTED       NOTES
-----------  -----------------------------------  ------------------------------------------------------------------------------------------------  ----  -----  -------------  ------------------------------------------------------------------------
codex        codex-cli 0.154.0                    ready                                                                                             5.9   yes    screen-change  bare `codex` from PATH; vendor/codex-bin backs Fusion and Codex Web only
claude       2.1.270 (Claude Code)                ready                                                                                             4.3   yes    screen-change
grok         grok 1.0.30 (04b7ffed98c6) [stable]  ready                                                                                             3.5   yes    screen-change
kimi         0.27.0                               ready                                                                                             5.7   yes    screen-change
kimi-custom  0.29.0                               ready                                                                                             5.6   yes    screen-change  bundled Kimi Code
qwen         0.23.3                               ready                                                                                             5.8   yes    screen-change
opencode     1.18.30                              ready                                                                                             6.1   yes    screen-change
gemini       unknown                              skipped:Gemini CLI is not installed on this machine                                               -     no     no
cursor       2026.06.26-7079533                   skipped:not signed in here (it is asking to sign in)                                              4.0   no     no             startup screens: sign-in
open-codex   -                                    skipped:not signed in here (its captured startup screen is "Finish signing in via your browser")  -     no     no
codex-web    -                                    skipped:needs a signed-in ChatGPT Codex session; its pane runs the bundled Codex TUI              -     no     no
```

That run is kept verbatim, so its `kimi` / `kimi-custom` rows still read 0.27.0
and 0.29.0. Later the same day the vendored fork bundle moved to 0.42.0 (upstream
0.42.0 plus the two harness commits) and stock `~/.kimi-code/bin/kimi.exe` was
already 0.42.0, so both were re-probed and both fixtures re-recorded. 0.42 needed
no recognizer change — the welcome box and ruled composer keep their shape, the
banner is three rows shorter, so only the recorded cursor rows moved, (5,21) →
(5,16) and (5,22) → (5,17). The re-probe was run with `--no-type`, which is why
it spends no model turn and reports no acceptance:

```
KIND         CLI VERSION  VERDICT  SECS  TYPED  ACCEPTED  NOTES
-----------  -----------  -------  ----  -----  --------  -----------------
kimi         0.42.0       ready    4.3   no     no
kimi-custom  0.42.0       ready    4.3   no     no        bundled Kimi Code
```

Three of those CLIs had upgraded themselves since their fixtures were recorded —
Grok 1.0.25 → 1.0.30, Qwen 0.21.12 → 0.23.3, OpenCode 1.18.25 → 1.18.30 — and
every recognizer still matched. That is the only evidence so far that these
recognizers survive a version bump.

`scripts/qa/native-chat-selection-smoke.cjs` now waits on the same detector
instead of a hard-coded footer string, and records whether it saw a ready
composer. On 2026-09-13 it reported `composerVerified: true` for `codex` and
`open-codex`, and `false` for `claude` and `claude-custom` — that fixture launches
Claude with `--dangerously-skip-permissions`, whose warning screen is what the
pane is showing at that moment, which is exactly what a composer recognizer
should refuse.

The probe found three defects the recorded fixtures could not have: the bundled
Kimi bin directory was missing from its PATH, Claude's folder-trust screen rests
its pointer on "No, exit" rather than on the affirmative option, and Qwen was
holding a provider-update modal in front of its composer. The first was a bug in
the probe; the other two are now startup screens the app recognizes.

---

## What is not verified

- **Gemini CLI.** Not installed on this machine. Its recognizer is the Qwen form
  and is marked unverified in the source. If Gemini's composer differs, a send to
  a Gemini pane will report a launch timeout with the screen it was stuck on,
  instead of typing blindly as it did before.
- **Codex Web's composer.** No signed-in session here. It reuses the Codex
  recognizer on the evidence that its pane runs the Codex TUI
  (`scripts/qa/codex-web-tui-smoke.cjs` drives the real bundled binary to its
  `model:` header and `/model` picker), but no Codex Web composer screen was
  recorded.
- **Open Codex's real account.** Not signed in here, so the provider-startup
  probe skips it. Its composer form is not a guess, though: with the isolated
  fixture home that `scripts/qa/native-chat-selection-smoke.cjs` builds, the
  detector reaches a ready composer on an `open-codex` pane
  (`composerVerified: true` for `open-codex` and `codex`, 2026-09-13).
- **Cursor Agent's composer.** Never captured. Cursor panes keep the old
  behaviour: the prompt is typed as soon as the pane paints something that is not
  a startup screen.
- **Nothing is installed.** All of this is source work. The installed 0.1.121
  build still has all four defects.
- **The end-to-end Orchestrator flow was not run against live models.** The
  resolver, intent and readiness changes are covered by `npm run
  test:orchestrator`; the pane behaviour is covered by the probe. No live
  Orchestrator request was issued through a real brain.
- **The probe types one line per kind** ("Reply with exactly OK and nothing
  else."). It does not exercise a real task, a busy pane, a resumed
  conversation, or a pane that is already working.
- **Acceptance was confirmed by screen change**, not by the in-flight composer
  evidence `composerAcceptedPrompt` looks for: with a one-word answer the turn
  is over before the next poll. The evidence is that the line left the composer
  and the pane drew something new.
