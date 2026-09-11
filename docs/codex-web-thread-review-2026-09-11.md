# Codex Web: flying-dog thread review

Reviewed native thread `01a0913e-9ef0-7250-b45d-9ee0df8de913`, in `C:\Users\ahmed\Documents\imposter`, September 11, 2026, 12:14–12:22 Toronto time. Its two requests generated a flying-dog image and webpage, then expanded that webpage. The selected account model was `gpt-5-6-thinking`, high effort. Review did not edit that workspace or its conversation.

## What the terminal showed

The rollout contains 17 real native tool calls and six assistant messages (four progress messages, two final answers). None of the assistant messages contains a source-code block, patch body, or `LINA-TOOL-CALL` envelope. Successful patches are native `FileChange` events. Codex's own `PatchHistoryCell` and `diff_render` render additions/deletions as code with line numbers; the Web pane uses that unchanged native display.

The first HTML addition contained 150 lines. The later replacement deleted those lines and added a 504-line file. That explains the large amount of code in the terminal without a duplicate assistant answer. Hiding native diffs would change normal Codex behavior.

## Findings

1. **Disruptive patch recovery.** The model submitted Delete and Add operations for the same file in one patch; native Codex rejected it. The recovery deleted the existing file at 16:20:31.349 UTC and recreated it at 16:21:22.453 UTC, leaving a 51.104-second gap. The task finished, but an interrupted or failed replacement would have left the page absent. An Update File patch would keep the existing file in place until the update is ready.
2. **Incomplete editing contract.** The upstream request parser kept a freeform tool's name/description but dropped its `format` grammar. The native `apply_patch` description is short; its Lark grammar contains the actual Update/Add/Delete syntax. This is a confirmed adapter omission, although it cannot prove the omission alone caused this model's mistake. The Lina overlay now preserves that grammar and includes it in the Web tool inventory. Guidance covers updating existing files, recovering without deleting first, concise replies, and accurate verification claims.
3. **Browser verification did not complete.** The installed Browser Use tool rejected the local `file:` tab under its URL policy. The model respected the rejection and ran static file/anchor/script checks. Its final answer correctly called them static checks, but did not explicitly explain that visual layout and actual browser interactions remained unverified. No workaround to the blocked browser action was attempted during this review.
4. **Slow work included avoidable extra rounds.** The initial request took 171.698 seconds, including a 35.600-second image operation and six Web model rounds. The upgrade took 249.880 seconds and eight model rounds. The invalid patch and delete/recreate recovery contributed extra work; these timings do not establish that the bridge alone caused the latency. The large `inputChars` values after `view_image` measure the native request JSON, including image bytes. The parser transports that image as a structured attachment, not base64 prose; those values do not establish repeated full-image uploads to ChatGPT.

The generated image was copied into the requested workspace, and its SHA-256 matches the saved original. The webpage references that local file. It is one HTML page plus a PNG, not a self-contained HTML file with an embedded image; the original wording requested a single page and did not explicitly require a single distributable file.

## Model naming repair

Native Codex uses the model ID itself in `/model`, its reasoning selector, and the status line. Changing only `display_name` would leave internal names visible. Account-derived native IDs now use Codex conventions:

| Native ID | Exact Web account slug |
| --- | --- |
| `gpt-6-astra` | `gpt-6-astra-wm` |
| `gpt-5.6-sol` | `gpt-5.6-sol-wm` |
| `gpt-5.6-terra` | `gpt-5.6-terra-wm` |
| `gpt-5.6-luna` | `gpt-5.6-luna-wm` |
| `gpt-5.6-sol-thinking` | `gpt-5-6-thinking` |
| `gpt-5.6-sol-instant` | `gpt-5-6-instant` |

All 14 models exposed by this account remain available. Work choices appear first; Auto, Instant, Thinking, Pro, and the separate Luna chat route remain distinguishable. Codex-only models and unsupported effort levels are not added. Membership in the private Web catalog determines routing; the readable IDs do not activate normal Codex authentication or inference. Old `chatgpt-web/...` IDs remain accepted aliases, including the saved selection and effort. Existing cached catalogs receive the naming migration locally without requiring sign-in or a network model refresh.

The subsequent requested thinking-only picker policy shows eight reasoning choices (the five Work models and three Pro variants). Six overlapping/non-reasoning entries are hidden using native `visibility`, while their metadata and exact routing remain available for saved selections and resume. No existing conversation silently changes model. The later diff-color report was traced to inherited `NO_COLOR=1`; the interactive Web CLI now explicitly enables truecolor, retaining native red/green styling. A native PTY/xterm fixture verified red deletion signs, green insertion signs, and the standard distinct RGB backgrounds without any Web request.

## Verification

- 66 focused tests passed, including model alias routing, account-only filtering, cached-name migration, unchanged reasoning levels, fragmented patch-envelope handling with zero assistant-text leakage, and native browser-denial handling.
- Native CLI smoke checks passed. An actual first native request was parsed through the rebuilt adapter: the image tool remained directly available and the original Lark patch grammar reached the Web contract.
- The native `/model` picker loaded all 14 renamed models and persisted a selection in an isolated test home while login validation was held pending. Shared sandbox settings were preserved. No model inference was used for this picker check.
- A separate live native TUI task used the same account model and high effort, under its new `gpt-5.6-sol-thinking` name. It added a theme control to a QA Canada page with one Update File patch, preserved the existing user marker, and produced short progress/final replies without repeated source code. The model later attempted to serve that QA page over localhost after Browser Use rejected its `file:` URL. That complete run is **not** counted as passing behavior acceptance. The task-owned server subsequently shut down on Ctrl+C; its expected exit code 1 also tripped the initial test's overly broad command-failure assertion.
- The follow-up repair stops the current Web turn on an explicit native Browser Use security-policy denial before another model request or tool call. It preserves files/history and gives an actionable error; a new independent static-check request remains allowed. The exact native failure was replayed through the rebuilt request parser and relay: zero further model calls, one non-retryable `native_browser_policy_denied` event. The original flying-dog thread respected its browser rejection; the workaround failure occurred in the later QA task.
- After the final rebuild, a new native process using `gpt-5.5-instant` resumed a pre-migration compacted QA conversation and correctly recalled `cat`. The native authentication, TUI, image-attachment and tool-contract smoke checks passed again against resource patch 41. The development preview was relaunched; the installed release is unchanged.

These repairs preserve the native Codex harness and display. They cannot guarantee that a ChatGPT Web model makes the same editing decisions as a regular Codex model on every task.
