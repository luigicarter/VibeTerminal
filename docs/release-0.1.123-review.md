# Release 0.1.123 review

This release publishes the work prepared as 0.1.122 — Orchestrator first-prompt
readiness across every provider pane, idle-pane reuse, answer-plus-new-work
replies, the bundled Codex 0.144.0 → 0.154.0 pin and the Chats-only-from-Chats
rule. That work is recorded in [the 0.1.122 review](release-0.1.122-review.md)
and is not repeated here. `v0.1.122` is retained unpublished: its CI run failed
in the release gate on a test-harness race, so no installer was ever produced.
The only source change 0.1.123 adds on top of it is the repair to that harness.

## Repairs found during review

[CI run 34786799997](https://github.com/luigicarter/VibeTerminal/actions/runs/34786799997)
failed the "Run release checks" step for `v0.1.122` at `4a0842c`.
`test:orchestrator` reported 2,401 of 2,402 passing; the one failure was
`scripts/backend/observed-stop-adapter.test.cjs:40`, "adapter endpoint fences
nonce, awaits all owned child exits and refuses late spawn", asserting
`result.ok === true` at line 49 and getting `false`.

The defect is in the test harness. `adapter()` wrapped
`createHostStopObserver` with `timeoutMs: 15` for every adapter it built. That
test starts a stop, yields one event-loop turn, and only then emits the child
exit events. On the 4-core `windows-latest` runner that turn outlasted 15 ms, so
`backend/observedStop.cjs` settled the operation `unknown` before the exits
arrived and reported a stop that had in fact completed as unobserved. The
product default is 10,000 ms; nothing in `backend/observedStop.cjs` or
`backend/fusion-adapter.cjs` was wrong, and neither was changed.

`adapter()` now takes `adapter({ stopTimeoutMs = 5000 } = {})`. Which tests need
a short deadline follows from `backend/observedStop.cjs`: `stop()` returns on a
failed kill before it awaits the settle promise, and the `observeOnly` branch
never arms a timer at all, so only a test that reaches `await finished` depends
on the value.

| Test | Awaits the settle promise? | Deadline |
| --- | --- | --- |
| `:40` fences nonce, awaits all owned child exits | Yes — settles when the emitted exits arrive | default 5000 |
| `:52` kill failure remains failed | No — returns on `killError`, timer cleared | default 5000, inert |
| `:60` timeout observed under the original operation | Yes — the child never exits, only the timer can settle it | **explicit 15** |
| `:68` natural root exit is not full tree proof | Yes — settles on the live worker's exit; `unknown` comes from the unverified earlier tree, not the timer | default 5000 |
| `:75` observe-only unknown operation | No — returns immediately, no timer | default 5000, inert |

`:68` is the subtle one. At 15 ms a loaded runner can settle it through the
timer instead of through the exit and still see `unknown`, passing for the wrong
reason and hiding the path the test exists to cover. A generous deadline forces
the intended path.

The failure was reproduced before anything was changed, on an isolated copy of
the test with the loop turn delayed past the deadline:

```
=== BASELINE (no delay, timeoutMs:15 as shipped) ===
REPRO result.process = "stopped" ok = true error = undefined

=== REPRO: loop turn of 20ms > timeoutMs 15 ===
REPRO result.process = "unknown" ok = false error = "Process exit was not observed before the deadline."
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
    actual: false,
    expected: true,
```

With the generous deadline and the same delay — and at ten times the delay — the
same copy reports `stopped`:

```
=== REPRO with generous timeout, same 20ms loop turn ===
REPRO result.process = "stopped" ok = true error = undefined
=== also at 200ms loop turn ===
REPRO result.process = "stopped" ok = true error = undefined
```

**CPU load cannot reproduce this locally, and future triage should not try.**
Under 64 busy-loop processes on a 32-core machine the unrepaired test still
passed 20 of 20 runs; the repaired one also passed 20 of 20. A machine with
eight times the runner's cores cannot be starved into the window that
`windows-latest` hits. Deciding whether one of these timing tests is a harness
race or a product defect needs an injected delay on the loop turn, not load.

## Acceptance evidence

- `npm run test:orchestrator` on the repaired tree: 2,402 tests, 2,402 pass, 0
  fail, 0 skipped — the suite that failed on CI at 2,401.
- The repaired test also passed 20 consecutive runs under 64 busy-loop
  processes, and the timeout test still spends its deadline (21.89 ms), so the
  short path it covers is still exercised rather than skipped.
- All 59 local release gates passed on `4a0842c`
  (`apps/desktop/.tmp/release-checks-0.1.122.log`, 18:23, ending
  `All 59 release checks passed.`) including the same 2,402 backend tests. The
  only source change since that run is
  `apps/desktop/scripts/backend/observed-stop-adapter.test.cjs`, plus this
  release's version bump and documentation.
- The packaged verification from the 0.1.122 review carries over unchanged:
  `LinaTerminal-Setup-0.1.122.exe` at 533,038,821 bytes passed
  `scripts/qa/verify-release-artifacts.cjs` (feed identity, hash and size
  matched; exactly one pinned Fusion Codex version; 15 voice alerts and 14 voice
  models), all three packaged native bundles reported `codex-cli 0.154.0`
  (`open-codex/win32-x64`, `codex-web/native/win32-x64`, `codex-bin/win32-x64`),
  and `npm run smoke:open-codex:packaged` passed end to end. It carries over
  because the only change since is under `scripts/`, which the installer does
  not ship — and CI rebuilds the installer from the tag regardless.
- `npm run smoke:provider-startup`: seven kinds reached their composer and
  accepted a typed prompt — `codex` (codex-cli 0.154.0), `claude` (2.1.270),
  `grok` (1.0.30), `kimi` (0.27.0), `kimi-custom` (0.29.0), `qwen` (0.23.3) and
  `opencode` (1.18.30). Four skipped: `gemini` is not installed on the
  verification machine, and `cursor`, `open-codex` and `codex-web` are not
  signed in there.
- Not verified, unchanged from the 0.1.122 review: the Gemini and Codex Web
  composers (both reuse another provider's recognizer with no live composer
  recorded here), Cursor Agent's composer (never captured), a live Orchestrator
  request through a real brain, a real Fusion planner/executor delegation turn,
  and any bundle other than `win32-x64`.

## Publication

Not yet published. The release commit and the `v0.1.123` tag exist locally only;
the tag has not been pushed, so no CI run, GitHub Release, installer asset or
public update-feed entry exists for this version yet. Publication evidence — the
workflow run, the release assets, the downloaded installer size and hash, and
the latest-feed response — is to be filled in here after CI completes.

Unpublished tags 0.1.118, 0.1.119, 0.1.120 and 0.1.122 remain unchanged. Their
failed validation was not bypassed. Hosted account deployment, preview wiring,
mobile store submission and the documented recovery limits remain separate work.
Publication does not install or restart the user's running application.
