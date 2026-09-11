# Shared models and providers

**Settings → Models & providers** is the single provider/model catalog for
**Open Claude Code** and **Open Codex**. Save a provider connection and its desired
models once. Both launchers use the same catalog and shared default model.
The New session menu lists each configured model once, with an engine selector
for Open Claude Code or Open Codex. CLI processes, configuration homes, and
conversation histories remain separate.

`frontend/components/ModelProviderSettings.tsx` owns the common settings form.
`backend/modelProviders.cjs` owns `<userData>/model-providers.json`, validation,
model discovery, the default selection, and key encryption through Electron
safeStorage. The renderer receives only `hasKey`, never saved keys. The old
`providerProfiles.cjs` and `openCodexProviders.cjs` entry points are compatibility
views over this one catalog, not independent stores.

## Migration

The first catalog read imports existing `claude-providers.json` and
`open-codex-providers.json` files if the shared store does not exist. The original
files remain intact. Profile IDs, configured model IDs, key ciphertext, and the
explicit Claude default (or otherwise the Codex default) are preserved. Claude
main and small/fast model slots become catalog entries. Existing Claude endpoints
retain their Anthropic Messages format. Existing Codex endpoints retain their
configured format. Providers are not merged merely because their URLs match:
they may represent different accounts, and their saved IDs must remain valid.

Import writes the shared store atomically. An invalid legacy file stops import
instead of replacing it with an empty catalog. Once the shared store exists,
deleting a provider does not re-import it from the older files.

## Using one endpoint from both CLIs

Supported endpoint formats are OpenAI Responses, OpenAI Chat Completions, and
Anthropic Messages. Automatic mode prefers Responses and falls back to Chat
Completions only for an unsupported Responses route. Provider format describes
the connection; it does not restrict the choice of CLI.

`claudeProviderGateway.cjs` presents a local Anthropic Messages endpoint to Claude
Code. For an OpenAI-compatible provider it translates Claude messages, tools,
tool results, and streaming events through the existing Responses adapter. For
an Anthropic endpoint it preserves the native Messages request/response format.
Claude receives a local capability token, while the real API key stays in the
main process. Standard model aliases and background-model defaults point to the
configured selection. The custom context limit comes from its catalog entry.

`anthropicProtocol.cjs` also lets Open Codex route through a migrated Anthropic
provider. Streaming failure is explicit; truncated tool calls do not become
completed actions. Tool IDs and compatible reasoning metadata are retained
across translated turns. Unsupported hosted-tool or message content fails
explicitly. The non-Anthropic `count_tokens` endpoint provides a conservative
local estimate, identified by `X-Lina-Token-Count: estimate`; it is not provider
billing usage. Actual response usage comes from the provider.

Native Claude model-picker behavior depends on the installed Claude Code
version. Lina exposes every configured model in its common launcher, supplies
the chosen custom-model option, and enables gateway model discovery. Open
Codex's native picker uses a launch snapshot of the configured catalog. Restart
panes after editing model configuration.

## Verification

- `npm run test:model-providers`: shared migration/default/credential behavior,
  both compatibility interfaces, translation in both directions, failure cases,
  and Open Codex adapter/lifecycle tests.
- `npm run smoke:model-providers`: both real native CLIs use the same saved
  OpenAI-compatible model against a local mock endpoint; the hidden Electron
  check verifies the single settings section, one model list, selection of
  either CLI, native Codex model switching, completion, and separate history.
- Existing Claude-provider, Fusion launch, workspace setup, and renderer checks
  cover the shared launch/configuration surfaces.

Evidence is kept under `.tmp/shared-models/` and `.tmp/open-codex/`. These are
source/local checks with mock endpoints, not a published installation or a paid
live-provider acceptance run.
