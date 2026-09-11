# Fusion and Open Fusion menus — September 10, 2026

Implemented in source; the installed app and release feed have not been changed.

Both panes use `frontend/components/FusionCommandPalette.tsx`. The menu sits
above the composer, groups commands by purpose, searches names/descriptions
and aliases, marks current settings, and provides Back, Close, and catalog
Refresh buttons. The list resizes to the pane so the composer stays reachable.
Arrow keys, Home/End, Page Up/Down, and Enter navigate actionable rows; disabled
commands, loading notices, and empty results cannot activate. The composer
exposes the listbox and active option to assistive technology. IME commit Enter
does not activate a command. A commands button and both model chips preserve
the draft while browsing. Escape from a picker returns through its parent menu;
Escape at the root dismisses it and preserves/restores the draft.

Fusion exposes planner/executor model pickers, effort, speed presets, fast
serving, and catalog refresh in the root menu. Existing typed shortcuts remain.
Help uses the same registry. Model search works across both families before
drilling into one. Effort menus lead with the current selection; Codex Auto
uses the live default model's advertised efforts when available. Compaction
explains its Claude-planner requirement and is disabled during a turn.

Open Fusion keeps its provider-owned catalog and explicit model setup. Both
model chips are interactive. The current model leads the picker and selecting
it again does not restart or change settings. Provider/model/saved-chat lists
expand through actionable Show more rows. A refreshed provider replaces the
open picker's old model snapshot. Failed initial loads show an error and a
retry control; empty results do not claim to be loading. Unknown-provider
attempts are offered only when the full catalog is unavailable, matching the
existing backend contract. The provider credential and application-data
isolation are unchanged.

`/refresh-models` in Fusion bypasses the main-process catalog TTL and reloads
both families. In Open Fusion it requests the running engine's provider and
model catalog; it does not upgrade OpenCode or claim to invalidate OpenCode's
upstream catalog cache.

## Model evidence

The curated choices were checked against the [Anthropic model catalog](https://platform.claude.com/docs/en/models/overview)
and [GPT-6 Astra documentation](https://developers.openai.com/api/docs/models/gpt-6-astra).
Fusion offers pinned Opus 5, Sonnet 5, and Fable 5.1 IDs alongside the CLI's
`opus`, `sonnet`, and `fable` aliases. Aliases are labeled “latest” rather than
pretending to be a fixed version. GPT-6 Astra joins Sol/Terra/Luna; obsolete
GPT-5.1 shortcuts leave the curated list, while saved and custom IDs remain
accepted. Quick Codex planning now uses GPT-5.6 Luna. Existing user choices and
the default model settings are preserved.

Astra's built-in effort fallback follows the public API's low through max
levels; an account/runtime catalog may advertise additional levels and takes
precedence. A menu entry is not proof of account access. Open Fusion continues
to use [OpenCode's provider/model catalog](https://opencode.ai/docs/models/)
rather than assuming direct-provider IDs apply to every endpoint.

## Verification and boundaries

Passed: production build/typecheck; Fusion settings, chat parsing, adapter,
delegation-race and interrupt-deduplication checks; Open Fusion chat parsing;
and `npm run smoke:electron:fusion-menus` against both real React panes with a
deterministic bridge. The Electron check covers search, empty/disabled rows,
model-current no-op, catalog refresh, pagination, draft restoration, failed
catalogs, and 520×380 short-pane geometry. Its screenshots and results are under
`.tmp/fusion-menus-smoke/`. It launches no provider processes and makes no model
requests.

Live authenticated turns are not verified by this change. A read-only probe of
the embedded Codex runtime hit an existing user `config.toml` incompatibility:
an `agents` entry contained a string where that binary expects an AgentRoleToml
object. The same binary's model listing succeeded with an isolated empty test
home, advertising the GPT-5.6 family and older models. No personal config,
credentials, model cache, or installed runtime was modified. GPT-6 account
availability and runtime behavior still require a live acceptance run with a
compatible configuration.
