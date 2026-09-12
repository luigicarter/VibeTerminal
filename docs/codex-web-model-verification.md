# Codex Web response-model verification

September 11, 2026. Initial tests reproduced an Astra/Sol mismatch through the bridge's Temporary Chat path. **Genuine Work tests verified Astra at both Medium and High. Patch 45 now implements that Work flow and passed native CLI model-switching, local-file and resume tests.** Patch 43 only grounded identity wording; patch 44 added response verification. The earlier claim that Astra was unavailable on the web was wrong.

## Temporary Chat evidence

A separate owned Temporary Chat requested `gpt-6-astra-wm`, high effort, and answered a neutral arithmetic question without Codex instructions or any model-identity hint. Its completed response reported:

```text
resolved_model_slug: gpt-5-6
model_slug: gpt-5-6
default_model_slug: gpt-6-astra-wm
intended_default_model_slug: gpt-6-astra-wm
```

The account catalog names `gpt-5-6` GPT-5.6 Sol. Selecting Sol Work also resolved to that base model. Thus the requested/default model fields alone did not prove that Astra answered. Evidence is retained locally in `apps/desktop/.tmp/codex-web-routing-probe/metadata.json`; it contains metadata summaries, not credentials or full network bodies.

Work replies begin with an HTTP SSE `stream_handoff`, then deliver the actual response in WebSocket `conversation-turn-stream` messages. Some arrive as subscription catchups. Their `encoded_item` is another SSE fragment. The previous receipt code read only the initial HTTP response and missed those model fields.

## Genuine Work validation

The later test navigated to ordinary ChatGPT, explicitly selected the **Work** radio control, and confirmed the Work composer before submitting any prompt. No model-identity hint or Codex transport instructions were added. The account was the same one used by the installed app.

| Selected model | Effort | Prompt | Answer | Assistant response metadata |
| --- | --- | --- | --- | --- |
| GPT-6 Astra | Medium | `37 * 19` | `703` | `model_slug: gpt-6-astra-wm`, `thinking_effort: standard` |
| GPT-6 Astra | High | `51 * 13` | `663` | `model_slug: gpt-6-astra-wm`, `thinking_effort: extended` |

The second turn explicitly selected the Astra model radio and changed its Power control from Medium to High. The rendered conversation was marked **Work**, and both assistant responses and server turn metadata identified Astra. Evidence: `apps/desktop/.tmp/codex-web-work-check/result.json`, `network.json`, and `work-request-controls.json`. The test conversation is [Calculate 37 Times 19](https://chatgpt.com/c/6aa45c21-9fec-83ea-83d1-23cf4370ac7d).

Genuine Work still used `/backend-api/f/conversation` and `conversation_mode.kind: primary_assistant`. Those fields alone do not distinguish Chat from Work. The old bridge's unconditional Temporary Chat URL and its model-picker assumptions differed from this verified Work flow. Work's explicit model picker also exposes a different Power/effort control from the regular Chat slider. This evidence preceded the patch 45 routing change and its native-tool acceptance.

This validation changed no production runtime files. The test host shut down after its bounded inspection period; the two completed Work turns remain available for review.

## Work routing in resource patch 45

- Work catalog entries open a regular ChatGPT page and explicitly select **Work** before the prompt is submitted. Other models continue using Temporary Chat. Work's prompts and native tool results are therefore present in saved ChatGPT Work conversations; native local history remains authoritative for resume.
- The exact Work model radio is selected before adjusting its Power control. This avoids the default multi-model Power ladder. Fast mode is disabled and the requested account-supported reasoning level is verified in the composer and outgoing request.
- A Work request with `history_and_training_disabled: true`, a different model, or a different thinking effort is blocked before transmission. Work responses must identify the Work model; the former same-name Chat fallback allowance is removed.
- Work conversations can be retained because their explicit model and effort are reconciled on every round. Retention is scoped to surface, model, effort, system/tool contract and native history prefix. A saved browser conversation cannot substitute for native history.
- The existing response guard remains: missing or mismatched server model evidence cannot release an answer or native tool call. Receipts also record surface, effort, Temporary Chat status and a conversation ID for correlation.

All 78 focused tests and the expanded native smoke suite passed. The new offline browser fixture starts in Chat with the wrong default model, verifies Work/Astra/High selection, disables Fast, preserves a retained draft, and rejects a Temporary Chat surface for Work. The real native CLI verified Astra → Sol Work → GPT-5.5 Thinking → GPT-5.6 Thinking → Astra, with matching server model IDs throughout. Evidence: `apps/desktop/.tmp/codex-web-identity-live-bfxClc/result.json`.

A separate Astra/High CLI run created `work-routing.txt` on the local filesystem using a native command and read it back. A new CLI process resumed the same native thread, appended another line, and read both lines back through native tools. The final local bytes were `native-work-ok\nresumed-ok` (allowing the final newline). All model rounds identified Astra and reused Work conversation `6aa4674c-3490-83ea-85d2-b26df2cc0b94`. Native thread: `01a09233-7612-7e83-92b8-62fc90f24faf`. Global login/config and the saved private native login hashes were unchanged. Evidence: `apps/desktop/.tmp/codex-web-identity-live-qQPHRv/result.json`.

```powershell
node scripts/qa/codex-web-model-identity-live.cjs --live
node scripts/qa/codex-web-model-identity-live.cjs --live --tools
```

These tests establish model routing, native local tool execution and resume. The Work-specific image, interruption and full-window compaction scenarios have not received a separate live acceptance run; their existing shared mechanisms remain in place.

The final compatibility check also reproduced a model-refresh failure before inference. The private route was installed and active, but the old Compatibility V1 installation journal objected to the user's newer `agents.max_depth`. Model refresh now reads route status and preserves an active route when that specific unrelated journal warning is the only discrepancy. Disconnected routes and other integration errors retain the existing strict validation. No agent setting is rewritten. After this repair, an explicit model refresh and a native GPT-6 Pro turn completed with `responseModels: ["gpt-6-pro"]`; protected login/config hashes were unchanged. Evidence: `apps/desktop/.tmp/codex-web-identity-live-TbQHSj/result.json`.

## Earlier enforcement in resource patch 44

- `codexWebModelVerification.cjs` observes both transports and binds evidence to the exact request and its handoff topic. Other panes, previous requests, assistant prose, and requested/default model fields cannot verify the response.
- HTTP response chunks are read before the SSE connection closes, with buffered/chunk ordering preserved and a request-body hash binding the CDP stream to its routed request. This avoids rejecting a completed valid answer while its HTTP stream remains open. Input bodies are not persisted by the verifier.
- `resolved_model_slug` takes precedence over preliminary `model_slug` routing aliases. The observed `gpt-5-6-auto-thinking` alias belongs to the catalog's `gpt-5-6-thinking` route; it cannot satisfy Astra. A Work experience may resolve to the same named base model in the account catalog, but cannot resolve to another model family or an Instant variant.
- Response text, commentary and tool envelopes wait for model verification. A mismatch or missing model evidence fails the request. Native tools from the rejected response are not executed, and the selected model is not silently changed.
- Errors use the pinned native CLI's non-retryable InvalidRequest wire classification. The actual reason remains in the message and receipt; a rejected model does not produce repeated native reconnect attempts.
- Receipts distinguish `requestVerified` from `responseVerified` and record server model IDs. A slower response cannot overwrite another request's latest receipt. Diagnostic storage retains identifiers, not prompts, answer bodies, or credentials.
- `/model` retains all eleven account reasoning routes, including the separate GPT-5.5 Thinking, GPT-5.6 Sol Thinking and Luna chat routes. Work availability no longer hides a distinct Thinking choice. Instant and Auto stay hidden, and existing model/effort selections remain unchanged.

The guard blocks an incorrectly routed response; it does not create a genuine Work session. It must not be used as evidence that Astra is unavailable. Verification means checking the service's response metadata; it is not a cryptographic attestation of model weights.

## Earlier patch 44 acceptance

All 77 focused tests and the full native smoke suite passed. They cover server metadata versus requested names, HTTP SSE before connection closure, WebSocket messages and catchups, stale/cross-pane events, preliminary aliases, missing evidence, exact model families and restoration of cached Thinking choices. The real native picker showed eleven choices and kept shared permissions while login validation was pending.

The earlier opt-in check used ordinary arithmetic, not model self-identification. It checked the Temporary Chat routes and required the observed Astra-to-Sol fallback to fail with no assistant answer, native tool call or reconnect retry. The current command now performs the successful Work-routing checks described above:

```powershell
node scripts/qa/codex-web-model-identity-live.cjs --live
```

The test uses the saved development-preview browser login and an isolated native history. It does not modify the reported installed conversation or the global Codex login/config.

The final live run passed in native thread `01a091f1-cff7-70a3-9b0a-fc08ad3c9305`. Sol Work reported `gpt-5-6`; GPT-5.5 Thinking reported `gpt-5-5-thinking`; GPT-5.6 Thinking reported `gpt-5-6-thinking`. The Astra request reported `gpt-5-6-auto-thinking` and failed with no assistant answer, tool call, or native reconnect retry. The protected login/config hashes were unchanged. Evidence: `apps/desktop/.tmp/codex-web-identity-live-m6LGTO/result.json`.

## GPT-6 Pro and ChatGPT Work availability

The account catalog was refreshed at 19:43 UTC on September 11. Its two exposed GPT-6 entries were `gpt-6-astra-wm` (`workMode: true`) and `gpt-6-pro` (`workMode: false`, Pro). A separate native CLI arithmetic request to GPT-6 Pro completed with `responseModels: ["gpt-6-pro"]` and `responseVerified: true`. Evidence: `apps/desktop/.tmp/codex-web-identity-live-AEwn6o/result.json`; thread `01a091fe-b7c5-7ea1-8377-cb33a2bdd1a1`.

OpenAI's [model guide](https://learn.chatgpt.com/docs/models#gpt-6-astra) explicitly lists Astra for ChatGPT Work on the web, subject to account/rollout availability. The tests above verify Astra through Work and Pro through regular Chat on this account. Patch 45 selects the appropriate flow. The server has not supplied an internal explanation for its fallback when a Work model is sent through the Temporary Chat path.

## Local installation

Patch 45 is installed locally. The two compiled bridge scripts and their manifests passed complete bundle-integrity validation before and after replacement. Backup and hashes: `apps/desktop/.tmp/codex-web-work-backup-9m8tPF/`. The small refresh repair is also applied to the existing unpacked `codexWebLauncher.cjs`; an Electron check loaded it through the installed archive and confirmed that it preserves the user setting. Its backup is `apps/desktop/.tmp/codex-web-refresh-backup-BhklKg/`. Installed runtime/helper hashes match the tested source. Restart Lina to load it. No public release was published.

The preceding patch 44 updated the existing unpacked model-catalog helper to expose the separate Thinking routes. An Electron check loaded that helper through the installed archive and confirmed eleven choices.

During patch 44 installation, the running application locked its archive against replacement. That archive-based attempt was rolled back and hash-verified; the replacement approach left `app.asar` unchanged and updated the existing unpacked catalog helper and four Codex Web resource files. Its backups and exact receipt remain in `apps/desktop/.tmp/codex-web-verification-install/backup-QAvONt/`. Patch 45 also leaves the archive unchanged.
