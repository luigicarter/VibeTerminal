# Open Codex

Open Codex is a separate CLI integration in Lina Terminal. Choose **Open Codex**
from New session or the File menu. Its provider connections and available models
come from **Settings → Models & providers**, shared with Open Claude Code. See
[the shared catalog and migration](model-providers.md).

This integration has a dedicated CLI entry point (`backend/openCodexCli.cjs`),
its own bundled copy of the native Codex runtime, the shared provider catalog, and
an app-owned Codex home. It uses the native terminal interface; the embedded
upstream runtime still identifies itself as OpenAI Codex inside that interface.
It is not a new chat pane or a Fusion executor.

## Configure and use

1. Add an OpenAI-compatible provider's API base URL and key. Local servers may
   omit a key. Base URLs include the API prefix, for example
   `https://api.example.com/v1`.
2. Enter model IDs, or use **Load models** to discover IDs and add the desired
   models. Discovery does not automatically enable the provider's entire catalog.
3. Set each model's display label, context window, and supported reasoning/image
   inputs. The conservative context default is 32,768 tokens; set the actual
   limit advertised by the provider. Select a default model.
4. Launch Open Codex. The launcher lists configured models, and the native
   `/model` picker contains the same configured set, using readable provider/model
   IDs. A provider's upstream model ID is preserved when routing API requests.

Each launch snapshots its model catalog. Restart a pane to load catalog changes.
Removed models are rejected by the running adapter instead of silently routing
to a different model. API format defaults to Automatic; Responses and Chat
Completions can also be selected explicitly. Migrated Anthropic Messages providers
can also be used through the compatibility adapter.

## Ownership and transport

- `backend/modelProviders.cjs`: shared
  `<userData>/model-providers.json` store. `openCodexProviders.cjs` is a compatibility
  entry point over the same catalog used by Open Claude Code. API keys use Electron safeStorage
  where available; the UI reports the local-file fallback where no keychain is
  available. Listing returns `hasKey`, never the key. Keyless edits preserve the
  saved key; changing its endpoint requires re-entering the key.
- `backend/openCodexRuntime.cjs`: generation-scoped loopback adapter and catalog
  lifecycle. Provider keys remain in the main process. The child receives only a
  random, per-launch loopback capability. Superseded/closed launches abort active
  requests and remove their temporary catalog files.
- `backend/openCodexCli.cjs`: launches the separately bundled native executable,
  injects the custom provider and native lifecycle hooks, and reports a unique
  root process identity. It does not fall back to PATH `codex`. Native approvals,
  terminal input, and execution are owned by the native CLI.
- `<userData>/open-codex`: independent native configuration and conversation
  storage. Discovery, confirmation, saved-history reads, and resume use this home;
  an unavailable home never falls back to personal Codex history.
- `backend/openCodexAdapter.cjs`: authenticated localhost Responses endpoint.
  Direct Responses requests retain Codex's conversation and streaming protocol.
  Automatic mode tries Chat Completions only after an unsupported Responses
  endpoint (404, 405, or 501); authentication, quota, and rate-limit failures are
  returned without trying a different API. Select Chat Completions explicitly if
  a provider reports unsupported endpoints with a different status.

The Chat Completions adapter translates instructions, messages, image inputs,
function/custom tools, namespaced tools, tool results, structured output, and
streaming completion/usage events. Provider reasoning metadata round-trips as
opaque native reasoning content. Fragmented tools are held until complete; a
truncated or failed stream cannot publish an executable partial tool call.
Unsupported hosted-tool or input formats fail explicitly. Portable native tool
defaults are used, and OpenAI-hosted web search is disabled for this integration.

## Packaging and checks

`npm run prepare:open-codex` copies the prepared, pinned native Codex payload into
`vendor/open-codex/<platform>-<arch>`. Both Windows packaging commands prepare it
and package it as `resources/open-codex`. The current verified payload is
Codex CLI 0.144.0. Open Codex owns its own runtime process for each terminal pane.

- `npm run test:open-codex`: settings validation, credential boundaries, both API
  paths, tools/reasoning, interrupted streams, cancellation races, and history
  isolation.
- `npm run smoke:open-codex`: real bundled CLI with an isolated mock provider,
  including an actual file-writing tool round trip; then hidden Electron checks
  for settings, native `/model`, model switching, completed-turn telemetry, and
  isolated native history. Artifacts live under `.tmp/open-codex/`.
- Existing terminal status, launch/resume, history, persistence, Claude-provider,
  and renderer-build checks cover the shared integration surfaces.

These are local source checks with deterministic mock providers. They establish
the native transport and integration behavior, not the coding quality or feature
parity of every external model. No paid live-provider turn or installed release
has been verified for this implementation.

Provider configuration follows the [official Codex custom-provider contract](https://learn.chatgpt.com/docs/config-file/config-advanced#custom-model-providers).
OpenRouter documents its [Codex integration](https://openrouter.ai/docs/cookbook/coding-agents/codex-cli)
and [Responses endpoint](https://openrouter.ai/docs/api_reference/responses/overview).
