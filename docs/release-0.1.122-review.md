# Release 0.1.122 review

This release covers the pending work that follows
[0.1.121](release-0.1.121-review.md): the Orchestrator terminal-readiness repair
recorded in
[terminal readiness](orchestrator-terminal-readiness-2026-09-13.md), the bundled
Codex pin bump recorded in
[the Codex bundle note](codex-bundle-0.154-2026-09-13.md), and the Chats
provenance rule recorded in
[the Chats implementation record](chat-section-implementation-2026-09-13.md).

## Scope

- **Orchestrator first-prompt readiness.** On installed 0.1.121 the Orchestrator
  could not reliably get a first prompt into a pane. Four defects produced the
  same symptom. Claude's composer rule still required the `? for shortcuts`
  footer that Claude Code stopped printing in 2.1.269, so every send to a Claude
  pane waited out the startup budget and reported a launch timeout having typed
  nothing. Only `codex`, `claude`, `claude-custom` and `terminal` waited for a
  composer at all, so every other kind typed into whatever its TUI was painting
  and never received the startup-screen report or the folder-trust answer. A
  never-prompted pane could never satisfy the idle-reuse rule, so the resolver
  opened a second pane beside an empty one. A cancelled or failed request kept
  its pane reserved forever.
- **Recorded-screen recognizers.** The hand-written readiness fixtures are gone.
  `scripts/backend/orchestrator-prompt-readiness.test.cjs`,
  `scripts/backend/orchestrator-startup-input.test.cjs` and
  `scripts/qa/native-chat-selection-smoke.cjs` replay real PTY recordings
  through `backend/terminalObservation.cjs`. Recognizers were added for Grok,
  Kimi (and Kimi custom), Qwen, Gemini and OpenCode; Open Codex and Codex Web
  reuse the Codex form because both run the Codex TUI. A kind with no captured
  composer — Cursor Agent — reports `unsupported`, which
  `waitForNativePromptReady` now treats as "type as before" with an
  `unverifiedComposer` receipt rather than as a failure, so those panes keep the
  behavior they had and gain the startup-screen guard.
- **Startup-screen catalogue.** Sign-in screens for Open Codex, Cursor Agent and
  Gemini/Claude auth pickers, Claude's external-`CLAUDE.md` import question, a
  numbered Qwen self-update menu and Claude's hook review were added. The plain
  "update available" banner Grok and Qwen print beside a ready composer is
  deliberately not a screen anyone has to answer, and a test fixes that
  distinction.
- **Answer-plus-new-work replies.** `backend/orchestratorIntent.cjs` refused a
  reply that both continued a read-only pending command and added new terminal
  work, losing both halves behind a generic interpretation failure. Access is
  now recorded per grant; the request takes the wider of the two, and each
  pane's workspace lane takes the access of the grants that own that pane. New
  mutating work inside the pane the reply is only reading is still refused. The
  specific reason is now rendered for both the conversation message and the task
  row from one catalogue entry in `backend/orchestratorFailureText.cjs`.
- **Bundled Codex 0.144.0 → 0.154.0.** The user's own `~/.codex/config.toml`,
  written by Codex CLI 0.154.0, carries an `[agents]` table 0.144.0 parses as a
  type error. Every Lina surface that runs the bundled binary against the user's
  global Codex home inherited that: the Fusion app-server logged
  `Invalid configuration; using defaults` and silently dropped the user's model,
  approval policy, sandbox mode and project trust, and `codex debug models`
  returned an empty catalog. `vendor/codex-appserver/0.144.0/` was replaced by
  `vendor/codex-appserver/0.154.0/`, and `vendor/codex-bin/win32-x64` and
  `vendor/open-codex/win32-x64` were re-prepared from an isolated
  `@openai/codex@0.154.0` install. Codex Web was already pinned at 0.154.0, so
  all three bundles now agree. Codex-side effort is now `low` through `ultra`;
  a saved legacy `minimal` normalizes to `low`.
- **Chats provenance.** Chats is one flat list, newest first, of conversations
  started from the Chats section itself — its New chat picker or one of its
  rows — recorded by a persisted `chat` flag on the pane and an `origin` field
  on the catalog row. Panes opened from the terminal launcher, the Orchestrator
  or the spare-pane keeper are terminals and never appear, and neither do rows
  found by a folder scan. The sidebar no longer scans folders for provider
  history. Each row shows `provider · status · folder label`, and the section
  collapses to its header with the choice remembered in `localStorage`,
  returning the reclaimed sidebar height to Projects. Because no earlier row can
  be proven to have been started as a chat, the list begins empty after this
  upgrade; every prior catalog row is retained in the database and only hidden.

## Repairs found during review

`npm run smoke:open-codex:packaged` — the CI step that guards packaged Open
Codex console input and model routing — failed on the first packaged build of
the 0.154.0 bundle. It asserted that one prompt produces exactly one provider
request. Two arrived, 45 ms apart. The second is new upstream behavior: Codex
0.154.0 asks the same model for a short task title beside the turn
(`Generate a concise, single-line task title of at most 36 characters…`).

Routing itself was correct — both calls carried the model chosen in the picker,
and neither fell back to the default. What the assertion encoded was a request
count that Codex owns, not the guarantee the smoke exists to protect. It now
requires that the turn reached the provider and that *every* call carries the
selected model, which is the stronger form of the same guarantee and no longer
breaks when Codex adds or removes a call of its own. The count was not relaxed
to make a failing product pass: no Lina behavior changed, and the title call is
wanted — it is where a Codex pane's generated title comes from.

The user-visible consequence is that an Open Codex turn now costs one extra
small call against the configured provider.

`smoke:electron:terminal-board` failed once during review on the drag-preview
equality check (`scrolled preview/release left: 0 != 19.99993896484375`). The
drop was correct at the pointer delta; only the preview sample was wrong.
`drag()` in `scripts/qa/terminal-board-smoke.cjs` read the preview rectangle
after a flat `sleep(120)`, so one slow frame returned the pane's pre-drag
rectangle. A fixed wait cannot be right on a slower machine, and CI's
`windows-latest` runner is slower than the machine this was measured on, where a
spurious failure costs the tag.

`drag()` now captures the pane's rectangle before the press and polls
`geometry()` every 50 ms until two consecutive samples agree *and* the rectangle
has left where it started, capped at 1500 ms. On the cap it keeps the last
sample, so a preview that genuinely never moves still fails. `closeEnough`'s
1 px tolerance is untouched — the repair changes when the rectangle is read, not
what counts as equal. Verified by injecting a stale sample: with the poll forced
to return the pre-drag rectangle the smoke fails `drag preview/release left: 0
!= 832`, and with the repair in place six consecutive runs pass with run time
unchanged at 26.4 s, so the poll settles immediately rather than reaching its
cap. `scripts/qa/tiled-board-drag-smoke.cjs` (`smoke:electron:tiled-drag`) has
no fixed-wait sampling to repair: it runs inside the renderer and synchronises
on `requestAnimationFrame`, with no `sleep()` in the file.

A third, unrelated defect surfaced in the same review.
`scripts/frontend/workspace-setups-smoke.cjs` checks that `sanitizeSetup` strips
a pane's secrets by asserting the serialized setup does not contain the sentinel
`'bad'`. `bad` is three hex digits, and the serialized setup carries its own
generated UUID, so the sentinel appeared inside that id by chance and failed the
gate with nothing wrong. Measured over 20,000 generated setups the rate is
0.600% — about one spurious release-gate failure in every 167 runs, on CI as
much as locally (an observed id was `370fd594-fd74-4de6-b4cd-6f33420abad8`). The
sentinel is now `must-not-survive`, which a generated id cannot contain. The
assertion is unchanged in strength; it can no longer pass or fail by accident.

## Acceptance evidence

- All 59 local release gates passed on the final tree
  (`apps/desktop/.tmp/release-checks-0.1.122.log`, ending
  `All 59 release checks passed.`), including 2,402 backend tests in
  `test:orchestrator` with 0 failures, 0 skipped.
- `smoke:electron:terminal-board` passed three consecutive runs after its
  fixed-wait preview sampling was replaced with the bounded settle poll
  described above, and three more after the fault-injection check that proves
  the assertion still fails on a preview that never moves. Run time is unchanged
  at 26.4 s.
- `npm run smoke:provider-startup` opened a real pane of every launchable kind
  through the app's own shim directory and ConPTY host. Seven reached their
  composer and accepted a typed prompt: `codex` (codex-cli 0.154.0) 7.6 s,
  `claude` (2.1.270) 4.3 s, `grok` (1.0.30) 3.6 s, `kimi` (0.27.0) 5.7 s,
  `kimi-custom` (bundled 0.29.0) 5.7 s, `qwen` (0.23.3) 8.9 s and `opencode`
  (1.18.30) 6.5 s. Four skipped: `gemini` is not installed here, and `cursor`,
  `open-codex` and `codex-web` are not signed in on this machine.
- The Windows installer was built locally (`npm run dist:win -- --publish
  never`): `LinaTerminal-Setup-0.1.122.exe`, 533,038,821 bytes, SHA-512
  `8jqT7Oy2jx5EKMVNUknh/Sr38grBSKl6MNkwqEMMuoL/93uwlIGcMWFDdqrpXSChGl1iP6aoJw7R/+hmgfrAXg==`,
  with a 533,864-byte blockmap and a regenerated `latest.yml`.
  `scripts/qa/verify-release-artifacts.cjs` passed: feed identity, hash and size
  match the installer, exactly one pinned Fusion Codex version is present, and
  15 voice alerts and 14 voice models are packaged. The three repairs above
  landed after that build; all are in `scripts/`, which the installer does not
  ship, so the packaged bytes are unchanged by them. CI rebuilds the installer
  from the tag regardless.
- This is the first packaged verification of the 0.154.0 pin. All three packaged
  native bundles report `codex-cli 0.154.0`:
  `resources/open-codex/win32-x64`, `resources/codex-web/native/win32-x64` and
  `resources/codex-bin/win32-x64`. `npm run smoke:open-codex:packaged` then
  passed end to end — packaged PowerShell launch, native input, `/model` switch,
  provider turn, interrupt, lifecycle telemetry and cleanup.
- Not verified: the Gemini and Codex Web composers (both reuse another
  provider's recognizer with no live composer recorded here), Cursor Agent's
  composer (never captured), a live Orchestrator request through a real brain,
  a real Fusion planner/executor delegation turn, and any bundle other than
  `win32-x64`.

## Publication

Not yet published. The release commit and the `v0.1.122` tag exist locally only;
the tag has not been pushed, so no CI run, GitHub Release, installer asset or
public update-feed entry exists for this version yet. Publication evidence — the
workflow run, the release assets, the downloaded installer size and hash, and
the latest-feed response — is to be filled in here after CI completes.

Unpublished tags 0.1.118, 0.1.119 and 0.1.120 remain unchanged. Hosted account
deployment, preview wiring, mobile store submission and the documented recovery
limits remain separate work. Publication does not install or restart the user's
running application.
