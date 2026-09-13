# Mobile bridge (read-only)

The mobile bridge is an opt-in HTTP server inside the desktop app that lets the
Lina phone app, on the same local network, **read** the workspace: which projects
exist, which terminals and chats are open, what each one is doing right now, the
text currently on a terminal's screen, a live rendering of that terminal in a
real xterm with its scrollback, what each pane is visibly waiting on, an agent
pane's saved conversation, and the Orchestrator's saved history.

It is built for a phone on a cellular connection: the live view is a
**changed-rows frame protocol** rather than the pane's raw PTY bytes, every
response and the event stream are gzipped, the vendored xterm files are
content-addressed and cached for a year, and the read endpoints are paginated
and carry nothing a phone can already work out. A pane repainting thirty lines
thirty times a second cost the phone its whole escape stream before; it now
costs twelve frames of changed rows — **13.7×** less on the measured fixture.

It is off until the user turns it on in **Settings → Phone**, it binds nothing
until then, and it is read-only by construction: this build ships no endpoint that
types into a terminal, sends a key, interrupts a turn, or submits an Orchestrator
request. See [Reserved, not implemented](#reserved-not-implemented) for why.

## Where it lives

- `apps/desktop/backend/mobileBridge.cjs` - the server, routing, authorization,
  rate limiting, long polling, response compression, the bridge's own
  terminal-screen decoder, the live frame stream, the terminal page and its
  content-hashed vendor assets, and the saved-conversation reader.
- `apps/desktop/backend/mobileBridgeSettings.cjs` - the `mobile-bridge.json`
  preference store and the pairing-code generator.
- `apps/desktop/backend/mobileBridgeState.cjs` - pure assembly and normalization
  of the phone's view, including the `needsInput` prompt parser (no I/O, no
  clock of its own).
- `apps/desktop/backend/mobileBridgeFrames.cjs` - frame protocol v2: one buffer
  line to a self-contained ANSI row string, the row hash, the screen/scrollback
  renderers, the row diff, and the frame pump that caps a pane at twelve frames
  a second. Pure functions plus one injectable clock; it reads
  `terminal.buffer.active` and returns strings.
- `apps/desktop/backend/mobileBridgeTerminalPage.cjs` - the self-contained
  `/terminal/:id` page: the desktop's exact xterm theme, font and per-kind
  cursor accent, the stream client, and the `window.linaTerminal` surface.
- `apps/desktop/frontend/components/PhoneSettings.tsx` + `phoneSettings.css` - the
  Settings panel.
- `apps/desktop/frontend/components/PhonePairPrompt.tsx` - the approval prompt,
  mounted once near the app root and rendering only while a phone is asking.
- `apps/desktop/frontend/components/phoneBridgeApi.ts` - the shared typing for
  the preload namespace.
- `apps/desktop/scripts/backend/mobile-bridge.test.cjs` - unit coverage.
- `apps/desktop/scripts/qa/mobile-bridge-smoke.cjs` - Electron end-to-end check.

Hooks in existing files are deliberately thin: `backend/main.cjs` constructs and
starts the bridge after `installOrchestrator`, taps `broadcastTerminalEvent` and
the terminal runtime's snapshot `emit`, releases a pane's decoder wherever it
calls `forgetTerminal`, closes on `before-quit`, and owns three IPC channels;
`preload/preload.cjs` exposes the `window.vibe.mobileBridge` namespace;
`SettingsDialog.tsx` adds the `phone` navigation entry and its panel; and
`App.tsx` mounts `<PhonePairPrompt/>` once at the root.

## Pairing flow

Nobody types an address or a code. The phone finds the desktop, asks, and a
person on the desktop says yes.

1. The user opens **Settings → Phone** and turns on *Allow phone connections on
   this network*. The app starts listening.
2. The phone app finds this desktop on the LAN and calls `GET /api/discover`,
   which answers without any credential and tells it only the app name, the
   hostname, the version and a random `desktopId` — never anything about the
   workspace. `desktopId` is a 16-hex value minted once and kept in
   `mobile-bridge.json`, so a phone can tell two desktops apart and recognise the
   same one next time.
3. The phone calls `POST /api/pair` with its name and platform. That creates a
   short-lived offer and nothing else: no code, no workspace data.
4. The desktop shows **"A phone wants to view this workspace: \<name\> (\<platform\>)
   from \<address\>"** with **Allow** and **Deny**. The same request also appears
   under *Waiting for approval* in Settings → Phone; either surface answers it.
5. The phone is long-polling `GET /api/pair/:requestId`. On **Allow** that poll
   returns `{status:'approved', code}` — the one and only time the code crosses
   the wire — and the offer is consumed. On **Deny** it returns `denied` and
   nothing is recorded. Unanswered, it becomes `expired` after 120 seconds.
6. The phone sends every later request with `Authorization: Bearer <code>`.

Approved phones are listed in Settings → Phone with their name, platform and
approval time (at most 20, newest last). **New code** rotates the secret: every
paired phone stops working on its next request, held long polls are released, and
the device list is cleared, because none of those pairings are valid any more.

### Manual fallback

*Connect manually instead* in Settings → Phone reveals the LAN addresses, the
port (default `47831`) and the pairing code, for a network where discovery does
not work. The code uses Crockford base32 with `0`, `O`, `1`, `I`, `L` and `U`
removed, so a code read off a screen and typed on a phone cannot be misread; it
comes from `crypto.randomBytes` with rejection sampling (30 usable characters,
~78 bits). This path is hidden by default and is not the intended front door.

## API contract v1

Everything is JSON. Every response carries `X-Lina-Bridge: 1` and CORS headers
`Access-Control-Allow-Origin: *`, `Access-Control-Allow-Headers: Authorization,
Content-Type`, `Access-Control-Allow-Methods: GET, OPTIONS`. `OPTIONS` is answered
`204` without a code. Errors are `{ok: false, error}`; an unexpected exception is
`500`, logged with the `[mobile-bridge]` prefix, and never crashes the app.

`X-Lina-Bridge` is still `1`: the HTTP contract — routes, authorization,
pairing, limiters — is the same one. What changed inside it is the shape of the
live stream, which announces its own `protocol: 2` in `hello`, and the size of
the read payloads.

**Compression.** Every response carries `Vary: Accept-Encoding`. A JSON body
over **512 bytes** is gzipped when the request's `Accept-Encoding` allows it —
below that a gzip member's own header costs more than it saves, so `hello` and
the error shapes stay plain. The terminal page and the vendor assets are
gzipped on the same rule, and the event stream is gzipped for its whole life
(see [the stream](#get-apisessionsidstreamcodecredential)).

**Authorization.** `Authorization: Bearer <code without dashes, upper case>`,
compared in constant time against the stored code's digest. Missing or wrong is
`401 {ok: false, error: "unauthorized"}`. Ten failures from one IP address inside
60 seconds earn `429 {ok: false, error: "too many attempts"}` for the rest of that
window — including for a request that then carries the right code.

Two routes also accept the same code as a `?code=` query parameter, because a
browser cannot put a header on them: `GET /api/sessions/:id/stream` (opened by
`EventSource`) and `GET /terminal/:id` (typed, or opened in a WebView). The value
is canonicalized and digest-compared exactly like the header, and a failure
spends the same limiter budget. **No other route accepts it** —
`/api/state?code=…` is `401` — so the credential only ever reaches a URL for a
surface that has no other way to carry it. See [Security](#security) for what
that costs.

`GET /vendor/*` needs **no credential at all** and is answered before the
credential gate. Those files are the desktop's own vendored `@xterm` build, byte
for byte identical in every install, and say nothing about the workspace. They
are also outside both limiters: a `<script>` cannot send a header, so requiring
one would mean a stale code cost four failed authorizations per page load and
locked the phone out of its own bridge — and metering them instead would have
moved the same lockout onto discovery.

**Anything else is 404.** An unknown route, and any verb a route does not accept,
returns `404 {ok: false, error: "not found"}`. The only route in this build that
accepts a body at all is `POST /api/pair`, capped at 8 KB.

### Unauthenticated: discovery and pairing

These three answer before a credential exists — they are how a phone gets one.
They share their own budget of **30 requests per IP per minute** (`429 {ok:false,
error:"too many requests"}` beyond it), separate from the authorized routes'
limiter, so a phone scanning and polling cannot lock a paired phone out.

#### `GET /api/discover`

```json
{"ok":true,"app":"lina-terminal","host":"teki","version":"0.1.117","bridge":1,"readOnly":true,"desktopId":"b10d37810a622f44"}
```

Those seven fields and nothing else. No project, session, path or title is
reachable here, ever — it is the one route an unpaired device can read.

#### `POST /api/pair`

Body `{deviceName, platform}`: `deviceName` is 1–64 characters after control
characters are stripped (empty is `400`); `platform` is `ios`, `android`, `web`
or any other short token, reduced to `[A-Za-z0-9._-]`.

```json
{"ok":true,"requestId":"…","expiresAt":1789261453177}
```

At most **3** offers may be pending; a fourth is `429 {ok:false,error:"too many
pending requests"}`. An offer expires after **120 seconds**. Creating one pushes
`mobile-bridge:pair-request` `{requestId, deviceName, platform, remoteAddress,
expiresAt}` to every renderer window, and nothing else happens until a person
answers.

#### `GET /api/pair/:requestId?wait=<ms 0..25000>`

Long-polls one offer. `{ok:true, status:'pending'|'approved'|'denied'|'expired'}`
— and, when approved, `code` in its grouped `XXXX-XXXX-XXXX-XXXX` form. The code
is delivered **exactly once**: the offer is consumed on that response, so a
replayed `requestId` is `404`. An unknown id is `404`. A pending or denied
response never carries a code.

Approval appends `{deviceName, platform, approvedAt}` to `devices` in
`mobile-bridge.json` (capped at 20, a re-pair refreshing rather than duplicating).
**Denial records nothing at all.**

### Authorized routes

### `GET /api/hello`

```json
{"ok":true,"app":"lina-terminal","version":"0.1.117","host":"teki","bridge":1,"readOnly":true}
```

`version` is the desktop package version; `host` is `os.hostname()`.

### `GET /api/state?revision=<n>&wait=<ms 0..25000>`

The whole phone view, and the long poll. If `revision` equals the current
revision and `wait` is above zero, the response is held until something changes or
the deadline passes; otherwise it returns at once.

```json
{
  "ok": true,
  "revision": 12,
  "at": 1789261333177,
  "projects": [
    {"id":"phone","name":"Phone QA","path":"C:/work/app",
     "counts":{"working":1,"waiting":0,"done":0,"failed":0}}
  ],
  "sessions": [
    {"id":"phone-shell","generation":"g7","projectId":"phone","projectName":"Phone QA",
     "title":"pwsh","kind":"terminal","provider":"terminal","isChat":false,
     "status":"working","lastActivityAt":1789261330000,"attention":false,
     "snippet":"$ npm test","needsInput":null,"statusLabel":"running"}
  ],
  "orchestrator": {"enabled":true,"ready":true,"activeCount":0,"lastMessageAt":1789261000000}
}
```

- `title` is `conversationTitle || conversation.title || terminalTitle || name`,
  falling back to a readable kind label (`Open Codex`, `Open Fusion`, …).
- `status` is normalized: `running` and `interrupt requested` → `working`;
  `waiting` and `needs input` → `waiting`; `done` and `completed` → `done`;
  `failed` → `failed`; `exited` and `interrupted` → `exited`; `starting` and
  `awaiting activity` → `starting`; anything else → `idle`.
- `statusLabel` is the raw provider string, so a state this contract does not know
  degrades to `idle` rather than being invented. It is **omitted when it equals
  `status`**, which is most of the time; a phone reads
  `statusLabel ?? status`.
- `cwd` is **omitted when it is the session's project path**, which is almost
  always; a phone reads `cwd ?? project.path`. A pane running somewhere else, or
  one with no project, still carries it.
- `snippet` is the last non-empty line of that session's screen text, at most 80
  characters, or `""`. Eighty is a phone-width line; the rest was never drawn.
- `attention` is `true` only when the terminal runtime's `attention` record — the
  object it publishes, `{id, state, reason, updatedAt}`, from the head of a
  pane's approval ledger or its latest agent-attention event — is in state
  `waiting`. A `completed` or `failed` attention is a turn outcome that `status`
  already carries, and an absent one is `false`. A record carrying the older bare
  boolean still reads.
- `counts` are per project by normalized status; `failed` counts `failed` only.
- `activeCount` is the number of targets the relay currently has in flight, not a
  task total.
- `revision` advances only when something a phone would repaint actually changes.
  The wall clock alone never advances it, so an idle workspace does not burn a
  poll every rebuild. `needsInput` is part of that fingerprint, so a pane that
  starts asking wakes a held poll.

#### `needsInput`

`null`, or what the pane is **visibly** waiting on, so the phone can offer
one-tap chips instead of a keyboard. It is read off the screen text the state
build already sampled — a pure function, computed per session during a rebuild
and never on a timer, so an idle workspace with no phone polling pays nothing
for it.

```json
{"kind":"menu","prompt":"Do you want to make this edit to server.ts?",
 "options":[{"key":"1","label":"Yes"},{"key":"2","label":"Yes, and don't ask again this session"},
            {"key":"3","label":"No, tell Claude what to do differently (esc)"}]}
```

- `kind: "menu"` — 2 to 9 consecutive lines within the last 20 matching
  `^\s*[❯›>]?\s*(\d)[.)]\s+(.+)$`, with distinct digits. A box-drawing frame is
  stripped from each line first, because that is how Claude Code and Codex
  actually draw their prompts. `key` is the digit, `label` the option text,
  `prompt` the nearest preceding line that is not another option, a rule or
  blank. All text is trimmed to 200 characters.
- `kind: "yesno"` — the last non-empty line matches `\((y|yes)/(n|no)\)`;
  `options` are `y`/`n`.
- `kind: "approval"` — no menu was recognised but the terminal runtime holds
  waiting approval evidence for that pane (a non-empty `approvals` list, or
  `attention` in state `waiting` for reason `approval`). `prompt` is then the
  last non-empty screen line, or `"Waiting for approval"`; `options` is empty,
  because the runtime carries no choices. The runtime's `pendingInput` is
  deliberately **not** consulted: there it means text the Orchestrator has
  dispatched and not yet observed, which is the opposite of the pane waiting on
  a person.
- A drawn menu outranks a `(y/n)` line, which outranks the runtime's approval
  flag. Anything unrecognised is `null` rather than a guess, and a repeated or
  over-long numbered run is treated as a listing, not a set of choices.

This build reports what a pane is waiting on. It still has no way to answer it;
see [Reserved, not implemented](#reserved-not-implemented).

### `GET /api/sessions/:id/screen?maxChars=<default 12000>`

```json
{"ok":true,"text":"...","exited":false,"updatedAt":1789261330000}
```

ANSI-stripped text of what is on that pane's screen, newest `maxChars` characters.
`404` for an unknown session. A session with no live decoder (a chat pane, or a
pane removed since) answers with empty `text` rather than an error.

### `GET /api/sessions/:id/stream?code=<credential>`

`text/event-stream` carrying **frame protocol v2**: the rows of the pane that
actually changed, as self-contained ANSI, coalesced to at most twelve frames a
second. `404` for an unknown session; at most **8** streams are open at once
across the whole bridge, and a ninth is `503 {ok:false,error:"too many
streams"}`.

The whole stream is gzipped when the request carries `Accept-Encoding: gzip`
(`Content-Encoding: gzip`, `Vary: Accept-Encoding`), with a `Z_SYNC_FLUSH` after
every event so a frame is never held back waiting for a fuller deflate window.
`EventSource` asks for gzip on its own, so the terminal page gets it without
doing anything.

| event | payload | when |
| --- | --- | --- |
| `hello` | `{protocol: 2, cols, rows, seq, exited, control: false}` | first, always |
| `scrollback` | `{lines: [<ansi row>, …]}` | second: up to **300** lines above the viewport, `[]` when nothing has scrolled off |
| `screen` | `{seq, rows: [[rowIndex, <ansi row>], …all rows…], cursor}` | third, after any `resize`, and whenever a change cannot be expressed as a diff |
| `frame` | `{seq, rows: [[rowIndex, <ansi row>], …only changed rows…], cursor}` | every coalesced change after that |
| `resize` | `{cols, rows}` | the PTY's geometry changed; a `screen` follows |
| `exit` | `{}` | the process exited, after one last frame |

Plus a `: keepalive` comment every 15 seconds, so an idle pane does not look like
a dead connection — 19 gzipped bytes over twenty idle seconds, measured. The
stream closes when the client disconnects, when the pane is forgotten, or when
the listener stops.

`seq` is the pane's **state number**: it advances once per published frame, and
`hello` reports where the pane already is. It is not a resume cursor —
protocol v2 has none, and `since=` is gone. A phone that loses its connection
reconnects and is answered with the scrollback and a whole screen, which is
smaller than the byte replay it replaced.

**A `frame` with no changed rows but a moved cursor sends `rows: []`.** A frame
where nothing changed at all is not sent.

#### Row format

A row is self-contained: it assumes the terminal is at the default style when it
starts, and it always ends at the default style.

- SGR runs for foreground and background in all three colour modes (the 16
  palette as `30`–`37`/`90`–`97`, 256 as `38;5;n`, truecolour as `38;2;r;g;b`,
  and the `4x`/`10x`/`48` forms for background), and for bold, dim, italic,
  underline, blink, inverse, invisible, strikethrough and overline.
- A style change that only **adds** attributes emits just the additions; one
  that turns something off emits `\x1b[0m` and restates, because SGR has no
  attribute-safe "un-bold".
- A wide character is emitted **once**; its zero-width trailing cell is skipped.
- Trailing blank cells are trimmed — a blank counts as visible when it carries a
  painted background, an inverse run, an underline, a strikethrough or an
  overline.
- Every row ends `\x1b[0m`. An empty row is exactly `\x1b[0m`.

#### How a phone draws it

```
row:    \x1b[<rowIndex+1>;1H  +  <row>  +  \x1b[K
cursor: \x1b[<y+1>;<x+1>H     +  \x1b[?25l or \x1b[?25h
```

Rows are addressed absolutely inside the viewport, so a dropped frame costs one
stale row until that row next changes, never a corrupted screen. The
`scrollback` lines are written once with newlines, followed by a blank screen,
so they end up above the viewport that the first `screen` then fills.

#### Where the frames come from

The bridge's own `terminalObservation` decoder — the headless `@xterm/headless`
terminal it already feeds from main's `broadcastTerminalEvent` tap, the same one
behind `/api/sessions/:id/screen`. It is constructed with `scrollback: 300`
(the module's default is 1, which is all a screen sample needs) and exposes a
read-only `inspect()` accessor for the buffer. Nothing is asked of the PTY host:
no `attach`, no `sendToPtyHost`.

Every published frame renders the viewport **once per pane** and each viewer
diffs it against its own row-hash table, so two phones attached at different
moments each get a correct diff without the pane being rendered twice. Rows are
compared by an FNV-1a hash of the serialized row, so "changed" means changed
text *or* changed attributes, and an unchanged row never ships.

A frame is never taken the instant a PTY chunk arrives: the decoder parses on
its own queue, so the bridge waits for the pane to settle and then reads the
buffer once.

**What this replaced.** A bounded ring of raw PTY bytes (512 KB per session,
16 MB overall) and a `since` replay. Both are gone, with `mobileBridgeStream.cjs`
and its tests. So is the opportunistic seeding of that ring from a renderer
`snapshot` event: a bridge switched on **after** a pane started has no decoder
for it and answers with an empty screen until the pane next writes, exactly as
`/api/sessions/:id/screen` already did.

### `GET /api/sessions/:id/metrics`

```json
{"ok":true,"rawBytes":66950,"rawChunks":7370,"frames":68,"sentBytes":4127,
 "seq":68,"streams":1,"cols":81,"rows":13,"exited":false}
```

What the bridge took in for one pane and what it sent out for it: `rawBytes` is
the UTF-8 size of the PTY `data` events it ingested since the pane was created,
`sentBytes` is the compressed bytes actually written to that pane's streams,
`frames` is how many it took. It is observation only — it writes nothing, and it
exists so the redraw-storm fixture can prove the protocol costs less than the
bytes it replaced. `404` for an unknown session.

### `GET /terminal/:id?code=<credential>`

A self-contained HTML page — inline CSS and JS, fetching nothing but the
bridge's own `/vendor/*` and its stream — that renders the pane in a real xterm.
`401` without a valid credential, `404` for an unknown session.

- The desktop's exact theme, font stack (`Cascadia Mono`…), weight and line
  height from `TerminalPane.tsx`, and the pane kind's own cursor accent, with
  `scrollback: 5000`, `cursorBlink: false` and `disableStdin: true`.
- Geometry is the PTY's, never the phone's: the page keeps the PTY's `cols` and
  `rows` and sizes the **font** so those columns fit the viewport exactly. There
  is no readable floor any more — the font goes as small as it has to (the only
  clamp left is 1–16px), and after xterm has drawn, the page measures the screen
  it actually produced and shrinks further until it is inside the viewport. The
  size is re-derived on viewport rotation/resize and on a `resize` event from
  the stream.
- **The page never scrolls sideways, at any width.** `html`, `body`, the stage,
  the host and `.xterm-viewport` are all `overflow-x: hidden`, and the fit above
  means there is nothing to scroll to.
- **Zoom instead.** The terminal is wrapped in a layer the page scales and
  translates: pinch to zoom **0.6×–3×** anchored on the pinch midpoint, one
  finger to pan while zoomed, double-tap to reset. Programmatic zoom has no
  fingers to anchor on, so it anchors on the view instead — the **left** edge,
  so column 0 never leaves, and the **bottom** edge, because a terminal is read
  from the newest line up. Panning is bounded so an edge
  of the content can never leave the viewport, and at 1× the pan is pinned to
  zero. Unzoomed, one finger is xterm's own vertical scroll, untouched
  (`touch-action: pan-y`, switched to `none` only while zoomed). None of it
  touches the PTY.
- **No scrollbars anywhere** (`scrollbar-width: none`, `::-webkit-scrollbar {
  display: none }`, every container `overflow: hidden`). The only position cue
  is a slim **2 px right-edge rail**, shown solely while the reader is scrolled
  away from the newest output.
- It speaks frame protocol v2: `scrollback` is written once with newlines
  followed by a blank screen, and every `screen`/`frame` row is drawn at its
  absolute position. There is no resume cursor — a dropped connection
  reconnects with exponential backoff (0.5 s doubling to 15 s) and is answered
  with a fresh scrollback and screen.
- A slim top banner reads **View only**. There is a clearly marked `send(data)`
  stub that only logs — this build has no input path for it to use.
- `window.linaTerminal = {focus(), fit(), scrollToBottom(), zoom(delta),
  resetZoom(), send()}` for the phone app — `zoom` is relative, anchors on the
  view's left and bottom edges, and returns the new scale — and
  `{type:'ready'|'exit'|'error', …}` is posted through
  `window.ReactNativeWebView.postMessage` when that object exists. The ready
  message is `{type:'ready', control:false, id, cols, rows}`: **`control` is
  what the phone app keys its on-screen key bar off**. It is stamped by the
  server, not decided in the page, and it is `false` in this build because the
  bridge exposes no route that writes to a terminal. It becomes `true` only when
  a real send path exists — so a phone that trusts it will never show keys that
  do nothing.
- Page background `#17181c`; the page itself never scrolls, only the terminal.
- 17.9 KB, **6.1 KB gzipped**, and it is served gzipped.

It works in a plain browser tab, which is the quickest way to check a build.

### `GET /vendor/<contentHash>/xterm.js`, `…/xterm.css`, `…/addon-fit.js`

The desktop's own `@xterm/xterm` and `@xterm/addon-fit` files, served from
`node_modules` with their real content types, addressed by the first 16 hex
characters of the SHA-256 of their bytes:

```
ETag: "1f991ac3b4b283eb"
Cache-Control: public, max-age=31536000, immutable
Vary: Accept-Encoding
```

Immutable by construction — the same bytes keep the same URL, and a build
upgrade mints a new one — so a phone downloads `xterm.js` (289 KB, **67 KB
gzipped**) exactly once per build and never revalidates. An `If-None-Match` that
matches is answered `304` with no body anyway. The terminal page is generated
against the current hashes, so it never points at a stale URL.

The old unhashed `/vendor/<name>` paths **redirect** (`302`, `Cache-Control:
no-store`) to the current hashed URL rather than 404ing, so an older client or a
bookmarked path still lands on the asset; a hashed URL whose hash is not the
current build redirects the same way rather than serving something stale.

**No credential** — see [Authorization](#api-contract-v1) for why — and no
limiter; a verb other than `GET`/`HEAD`, or an unknown name, is the same `404`
as anywhere else. Nothing is fetched from a CDN, and no new dependency was
added. In a packaged build `backend/` is unpacked from the asar while
`@xterm/xterm` is not, so the reader falls back to the copy inside `app.asar`,
which Electron reads through transparently.

### `GET /api/sessions/:id/transcript?limit=<n default 50>&before=<index>`

```json
{"ok":true,"status":"found","total":130,"nextBefore":80,
 "messages":[{"role":"user","text":"..."},{"role":"assistant","text":"..."}]}
```

Newest-last pagination. `total` is the whole conversation; `messages` is the
`limit` messages ending at `before` (default: the end), newest last;
`nextBefore` is where the previous page ends, or `null` at the front. `before`
is an index into the whole conversation, so the server holds no cursor. A call
with no parameters is the last **50** with the total behind them; `limit` is
capped at 500.

`status` is `found`, `unavailable` or `unsupported`:

- Agent panes (`codex`, `open-codex`, `claude`, `claude-custom`, `cursor`,
  `gemini`, `grok`, `kimi`, `kimi-custom`, `qwen`, `opencode`) are read from the
  provider's own saved conversation store, matched by the pane's owned thread id.
- Fusion and Open Fusion chat panes return the pane's current chat body as one
  assistant message.
- A plain shell (`terminal`), and any kind with no native store, is `unsupported`.
- A pane whose conversation cannot be identified or opened is `unavailable`.

`404` for an unknown session.

### `GET /api/orchestrator/history?limit=<default 100>`

The last `limit` messages, chronological, plus the last **100** tasks (`limit`
is capped at 2000).

```json
{"ok":true,"enabled":true,"ready":true,
 "messages":[{"id":"m1","role":"user","text":"...","at":1789,"requestId":"r1","taskId":"t1","status":"sent","targetId":"a"}],
 "tasks":[{"id":"t1","requestId":"r1","text":"run tests","status":"finished","terminalId":"a","projectId":"p1","cwd":"C:/work/app","createdAt":1,"updatedAt":2,"result":"green","error":null,"summary":"ok"}]}
```

Both lists are projected field by field onto the published shape, so nothing the
relay happens to carry internally leaks through. The source is the already
redacted `getState()` snapshot.

## Reserved, not implemented

The contract reserves, and this build deliberately **does not implement**:

- `POST /api/sessions/:id/input` - type into a terminal.
- `POST /api/sessions/:id/interrupt` - interrupt a running turn.
- `POST /api/orchestrator/request` - submit an Orchestrator request.

They are absent, not disabled: no route matches them, no handler exists, and no
code path in `mobileBridge.cjs` reaches `sendToPtyHost`, the relay's `send` /
`dispatch` surface, or any renderer action. Every non-`GET` verb falls through to
the same `404` as an unknown path, so nothing here can be mistaken for a control
surface that is merely switched off. The live stream does not change that: it is
a one-way `text/event-stream`, nothing a client writes on that connection is
read, the terminal page creates its xterm with `disableStdin: true`, and its
`send()` stub only logs. `needsInput` reports what a pane is waiting on **and
gives the phone no way to answer it** — the chips it describes are for a later
build that has a write path designed.

The reason is blast radius. A write endpoint on an unencrypted LAN listener would
let anything that learns the pairing code run commands in the user's shells with
the user's credentials. Read access leaks what is on screen; write access is
remote code execution. Shipping the read half first lets the phone app, the
pairing flow and the code-rotation path be used and trusted before any write path
is designed — and a write path needs its own design: per-action confirmation in
the desktop UI, an audit trail, and a transport that is not plaintext HTTP.

## Security

- **Off by default.** Nothing binds until the user turns it on, and a
  switched-off app writes no preference file at all — the desktop identity is
  persisted only once the listener is actually up. The preference lives in
  `<userData>/mobile-bridge.json`, written atomically (temp file plus rename) at
  mode `0600`, the same idiom as the workspace setup store.
- **A person approves every phone.** Discovery and the pair offer expose nothing
  but the desktop's name and a random id; the credential is handed over only
  after someone on this desktop presses Allow, and only through the poll that
  consumes the offer. Three pending offers at most, 120 seconds each.
- **LAN only, no TLS.** The listener binds `0.0.0.0:47831` by default and speaks
  plaintext HTTP. Traffic is readable by anything on the same network segment.
  Do not enable it on a network you do not trust, and do not forward the port.
- **Bearer code.** Every route, `/api/hello` included, requires the pairing code.
  Comparison is constant-time over SHA-256 digests, so neither a wrong length nor
  a wrong prefix is distinguishable by timing.
- **The `?code=` query credential.** The stream and the terminal page also accept
  the code in the URL, because `EventSource` cannot send a header and neither can
  a typed address. That is a real, deliberate cost: a URL carrying the code lands
  in browser history, in the address bar, and in any `Referer` a future link
  might send, where a header would not. It is bounded three ways — those two
  routes only (`/api/state?code=…` is `401`), the same constant-time check and
  the same failure limiter as the header, and the same plaintext LAN the whole
  bridge already runs on, where the header was never secret from the network
  either. Rotating the code with **New code** invalidates every URL already
  handed out.
- **`/vendor/*` is open on purpose.** The vendored `@xterm` files answer with no
  credential and outside both limiters. They are a public library, identical in
  every install, and carry nothing about the workspace; the alternative was
  worse. Requiring a credential a `<script>` cannot send would have meant the
  page charging **four** failed authorizations per load with a stale code — two
  bad loads and the ten-per-minute limiter locks the phone out of the bridge it
  is paired to, including `/api/state`. The residual exposure is that anything
  which can reach the port can download the same xterm build it could download
  from npm, and can pull it repeatedly; the bytes are read from a memory cache.
- **Rate limited.** Ten failed authorizations from one address in 60 seconds
  blocks that address for the rest of the window. Discovery and pairing have
  their own 30-per-minute budget, so neither limiter can be used to lock out the
  other's traffic.
- **Fixture override.** `LINA_MOBILE_BRIDGE_AUTO_APPROVE=1` approves every pair
  request after 500 ms with no prompt. It exists so the smoke can drive the flow
  unattended; it logs a `FIXTURE USE ONLY` warning at startup and again on every
  approval, and Settings → Phone says so on screen while it is set. Never set it
  on a real machine.
- **Windows Firewall.** The first time the listener binds, Windows shows its
  "Allow an app to communicate" prompt. Declining it leaves the app running with
  the listener reachable only from the machine itself; the Settings panel still
  reports *Listening*, because the socket is open — the block is in the firewall,
  not in the app.
- **Rotation.** *New code* invalidates every previous pairing immediately and
  empties the device list, so the panel never advertises a pairing that no longer
  works.
- **Renderer-side privilege.** The three IPC channels refuse any sender that is
  not the workspace window, so no other surface can open the port.
- **Memory.** The bridge keeps its own terminal decoder, bounded at 256 KB of
  display samples per pane and 8 MB overall, plus a `scrollback: 300` xterm
  buffer per live pane and a handful of counters. The raw-output ring that used
  to sit behind the stream — 512 KB per pane, 16 MB overall — is gone with the
  protocol that needed it. Everything is released wherever the app already
  forgets that terminal, and emptied when the bridge is switched off. It ingests
  nothing while disabled.
- **Stream ceiling.** At most eight streams are served at once, so a client that
  reconnects in a loop cannot open unbounded connections; a ninth is `503`.

## Verification

```
cd apps/desktop
node --test scripts/backend/mobile-bridge.test.cjs
npx vite build && node scripts/qa/mobile-bridge-smoke.cjs
```

The unit suite covers the code alphabet and store, status normalization, title
fallbacks, per-project counts, the fingerprint's clock independence, LAN address
filtering, `401`/`429`, `hello`, the state shape, long polling (held to its
deadline and woken by a change), `screen`, all four transcript outcomes,
orchestrator history ordering and limits, `OPTIONS`, every write verb returning
`404`, listen-failure reporting, decoder release, and code rotation. For
discovery and pairing it also covers the `discover` shape with an explicit
no-leak assertion, the three-offer cap, a pending poll never carrying a code,
approval delivering the code once and then `404`, the device record and the
absence of one after a denial, expiry freeing its slot, the auto-approve override
and its warning, the separate public budget, the device cap and re-pair refresh,
and rotation clearing the device list while the desktop id survives.

For the live view it covers **frame protocol v2** against a real headless
terminal: row serialization (palette/256/truecolour, stacked attributes, a wide
glyph emitted once, trailing blanks trimmed, every row ending reset), row
hashing and the diff (attributes part of the hash, a settled screen shipping
nothing, a missing or differently sized hash table meaning a whole screen), the
scrollback slice and its 300-line bound, the frame pump's twelve-a-second cap on
a fake clock with one frame in flight per pane, and a **round trip**: the rows
the server sends, drawn the way the page draws them into a second headless
terminal, reproduce the source screen cell for cell and attribute for attribute,
and a diff applied on top lands where a full redraw would. Over the server it
covers `hello`/`scrollback`/`screen` on attach, a one-line change shipping one
row, a rewritten row shipping only that row, a `resize` followed by a whole
screen, keepalive comments, a second viewer getting its own screen rather than
this one's diff, `404`, and the eight-stream `503` with a slot freed on hang-up;
the stream's gzip (`Content-Encoding`, `Vary`, and a thirty-repaint storm
costing a fifth of the raw bytes), its plain-text fallback, and the `metrics`
counters behind it; JSON compression over 512 bytes with a short answer left
alone; the slimmer state shape (absent `statusLabel`, absent `cwd`, 80-character
snippets) and the fingerprint still moving when a field starts or stops being
omitted; transcript pagination (the unparameterised last fifty, walking
backwards with `before`, stopping at the front, the server's own cap); the
vendor assets' content types, their content-hashed immutable caching, `304`
revalidation, gzip, the redirect from an unhashed or stale-hash path, their
answering with no credential, their refusal of a write verb, and forty reads of
one spending neither limiter; the terminal page's theme colours, font, geometry,
`linaTerminal` surface (`zoom`/`resetZoom` included), `control:false` and the
`cols`/`rows` in its ready message, its v2 event handlers and absent write path
and resume cursor, the CSS that makes a horizontal scroll impossible (every
`overflow-x: hidden`, the hidden scrollbars, the 2 px rail, the departed 7 px
font floor and the 0.6×–3× zoom bounds), with `401`/`404`, the proof
that `?code=` is refused on every other route, and the proof that the page does
not put the code in a vendor URL; the `attention` object shape the runtime really
publishes (`waiting` true, `completed`/`failed`/absent false, legacy boolean
still read); and the `needsInput` parser
against hardcoded Claude Code and Codex approval screens plus the yes/no, idle,
listing and runtime-approval cases.

The smoke runs Electron twice against the built renderer. Phase 1 uses
`LINA_MOBILE_BRIDGE_ENABLED=1 LINA_MOBILE_BRIDGE_PORT=47999
LINA_MOBILE_BRIDGE_CODE=<fixed> LINA_MOBILE_BRIDGE_HOST=127.0.0.1
LINA_MOBILE_BRIDGE_AUTO_APPROVE=1`, opens one live shell in a project, and walks
discovery → pair → approved poll → the delivered code opening `/api/hello`,
followed by every read route and the refused writes.

Three of its checks are measurements rather than assertions about shape:

- **`storm-bytes`** drives a real redraw storm — `1..120 | % { $i=$_; Clear-Host;
  1..30 | % { "line $_ tick $i" }; Start-Sleep -Milliseconds 33 }`, typed into
  the shell through the renderer's own input path, because the bridge has no
  write route — while a raw gzip socket reads the stream. It prints
  `PASS storm-bytes {"raw":…,"sent":…,"ratio":…,"fps":…}` from
  `/api/sessions/:id/metrics` and the socket's own byte count, and **fails if
  the ratio is under 5 or the frame rate is over 13**.
- **`idle-stream-bytes`** holds the same stream over an idle pane for twenty
  seconds and reports what it cost (keepalives only, and no frames at all).
- **`state-payload-is-slim`** reports `/api/state` plain, gzipped, and as the
  same workspace would have serialized before the read was slimmed.

Phase 2 relaunches on port
`47993` **without** the auto-approve override and asserts that an unanswered poll
stays `pending` for a full two seconds, then clicks **Allow** in the real
`PhonePairPrompt` through CDP and confirms the poll returns the code, the prompt
dismisses and the device is listed. Each check prints `PASS <check>`;
`--hold=<seconds>` keeps phase 1 up and prints
`HOLD http://127.0.0.1:47999 code <code>` so a phone or `curl` can be pointed at
it by hand, and `HOLD terminal <url>` so the page can be opened in a browser.
All five environment variables exist for fixtures; they override the stored
preference for that run only and are never written to disk.

## Verified and not verified

Verified locally on Windows 11 (Electron 42, Node 24.19), 2026-09-13, for
protocol v2 and the transmission work:

- Unit suite: **40 tests, all passing** (`node --test
  scripts/backend/mobile-bridge.test.cjs`).
- Electron smoke: **20 checks, all passing**, including the three measurements:
  - `storm-bytes {"raw":66950,"sent":4871,"ratio":13.74,"fps":10.14,"frames":78,
    "seconds":7.7,"uncompressed":35345,"rawChunks":7343}` — a real PowerShell
    redraw storm through an 81×13 shell: **66,950 PTY bytes in, 4,871 compressed
    bytes out, 13.7× less, 78 frames over 7.7 s (10.1 fps)**. The same frames
    uncompressed would have been 35,345 bytes, so the row diff is doing about
    half the work and gzip the other half. Three runs of the same fixture landed
    at ratios 16.2, 13.7 and 13.7 with 10.0–10.1 fps; the gate is ratio ≥ 5 and
    fps ≤ 13.
  - `idle-stream-bytes {"seconds":20,"bytes":19,"keepalives":1,"frames":0}` —
    twenty idle seconds cost **19 bytes** and produced no frames at all.
  - `state-payload-is-slim {"slim":713,"slimGzip":426,"verbose":835,
    "savedBytes":122,"sessions":1}` — one session, so the per-session saving is
    122 bytes of 835 (**15%**) before compression and 713 → 426 (**40%**) after.
  - `terminal-page-and-vendor-assets {"page":17969,"pageGzip":6196,
    "vendorUrl":"/vendor/1f991ac3b4b283eb/xterm.js","vendorBytes":289255,
    "vendorGzip":67469,"etag":"\"1f991ac3b4b283eb\"","revalidated":304}` — the
    page is **6.1 KB on the wire**, `xterm.js` **67 KB** and then never
    downloaded again for that build.
- **The page in a plain browser tab** (Chrome, against the smoke's held
  listener), 2026-09-13: the stormed shell rendered in a real xterm with the
  desktop's theme and colours, the `echo` keyword still yellow (so SGR survived
  the row round trip), the *View only* banner, 13 drawn rows for a 13-row PTY,
  and 300 lines of scrollback reachable by scrolling up to `line 1 tick 120`.
  **No console errors.** `window.linaTerminal` exposed
  `focus`/`fit`/`scrollToBottom`/`zoom`/`resetZoom`/`send`, with `send()`
  returning `false` and printing its view-only notice, `zoom(1)` → `2` and
  `transform: translate(-1280px, -622px) scale(2)`, `zoom(99)` clamped to `3`,
  `zoom(-99)` clamped to `0.6`, and `resetZoom()` returning
  `translate(0px, 0px) scale(1)` and clearing the `zoomed` class. The 2 px rail
  was hidden at the bottom, shown when scrolled up (`height: 457px, top: 0`) and
  hidden again on return. At **390 px** the 81 columns drew **377 px** wide at a
  7.94 px font, and at **320 px** they drew **307 px** wide at 6.46 px — below
  the old floor, as intended — with **no element** (`documentElement`, `body`,
  `#stage`, `#host`, `.xterm-viewport`) having any horizontal overflow at either
  width, and `scrollbar-width: none` in force.

Verified earlier on Windows 11 (Electron 42, Node 24.19), 2026-09-12, for the
contract this build kept:

- Electron smoke: 16 checks, all passing — discovery answering with no code and
  no workspace data; a pair offer approved and its poll returning a code that
  then opens `/api/hello`; in the no-auto-approve phase, a poll held `pending`
  for 2.0 s and then approved by a real **Allow** click in the desktop prompt,
  which named the device, platform and remote address, dismissed itself, and left
  the phone listed; `hello` reporting `readOnly: true` and
  the real package version, `401` without a code, the state listing one project
  and one live `terminal` session, non-empty ANSI-free screen text containing the
  line the shell had just echoed, a valid transcript status, orchestrator history
  `200`, `POST` to `input` / `interrupt` / `request` all `404` **with proof the
  refused body never reached the shell**, a long poll held and then woken by
  terminal output, and the CORS preflight. Plus, for the live view: the stream
  opening with `hello {cols:81, rows:13}`, replaying what the pane had already
  printed, then carrying a freshly echoed line in 50-odd numbered `data` frames
  with strictly rising sequence numbers; `/terminal/<id>?code=…` answering
  `200 text/html` with the theme, the *View only* banner and no write path,
  `/vendor/xterm.js` `200 application/javascript` with no credential at all
  while the page and the stream are both `401` without the code; and
  `needsInput` present and `null` on the idle shell. The raw-byte parts of that
  run (`snapshot`, numbered `data` frames) describe protocol v1 and were
  replaced; everything else still holds.
- `/api/state?code=…` refused `401` from the page, so the query credential
  really is limited to the two viewing routes.
- `npx tsc --noEmit` clean across the desktop app.
- **Settings → Phone** driven through CDP in a running app: the tab appears
  alongside Orchestrator & voice / Models & providers / Appearance; the panel
  reads `Off` with no details before opting in; ticking *Allow phone connections
  on this network* starts a real listener, lists the machine's LAN address, and
  shows `Listening on 192.168.2.38:47996`; a `hello` sent to that UI-opened
  listener with the code from the panel returns `readOnly: true`; and the
  preference persists to `mobile-bridge.json` with the stored port, not the
  fixture's override. Driven again after pairing landed: a live offer shows up
  both in *Waiting for approval* and in the modal prompt, approving from either
  surface clears both, the phone appears under *Allowed phones* with its
  approval time, the poll then returns the code, and **New code** empties the
  list.

- **Rotation from the panel.** *New code* clicked in the running app: the device
  list emptied and the old code stopped being accepted.

Not verified:

- **A phone.** No physical device or phone-app client has connected; only
  `fetch` from the smoke script, a desktop Chrome tab, and the unit suite. The
  `ReactNativeWebView` messages and `window.linaTerminal` have never been called
  from a real WebView host.
- **A real TUI on the page.** The pane rendered in the browser was a plain
  PowerShell shell running a redraw fixture. A full-screen agent TUI (Claude
  Code, Codex) has not been watched through the stream, so alternate-screen
  switches, mouse-mode sequences and wide/emoji glyphs at a sub-7 px font are
  untested there. The row serializer's wide-glyph and attribute handling is
  covered by unit tests against a real headless terminal, not by a live TUI.
- **Touch gestures.** Pinch-zoom, one-finger pan and double-tap-to-reset were
  exercised through `window.linaTerminal.zoom`/`resetZoom` and their bounds, not
  by real `touchstart`/`touchmove` events from a finger on a phone.
- **Scrollback while attached.** Protocol v2 sends the lines above the viewport
  **once**, right after `hello`. Output that scrolls off the desktop pane while
  a phone is already attached does not enter the phone's scrollback until it
  reconnects — a deliberate consequence of drawing rows at absolute positions,
  not a bug, but it has not been weighed against a real reading session.
- **A bridge switched on mid-pane.** With the raw ring gone, a pane that was
  already running when the bridge started has no decoder, so its stream opens on
  an empty screen until it next writes. `/api/sessions/:id/screen` behaved that
  way already; nobody has sat with it.
- **`needsInput` against a live prompt.** The parser is covered by hardcoded
  Claude Code and Codex screens in the unit suite and by the idle-`null` case in
  the smoke. No real agent has been driven to an approval prompt and observed
  through `/api/state`, and the `approval` branch has never fired from a real
  runtime ledger.
- **A dropped connection.** A second viewer opening its own stream is covered;
  the page's own reconnect-with-backoff path has not been exercised by an actual
  network interruption.
- **A packaged build's vendor assets.** The `app.asar` fallback path in
  `vendorAsset` has only been reasoned about and written; every run so far
  resolved `@xterm/xterm` from `node_modules` in a development tree. The content
  hash is computed from whatever bytes that read returns, so a packaged build
  would mint its own URL — not observed.
- **A transcript from a real agent pane.** The smoke's pane is a plain shell, so
  `transcript` was exercised only on its `unsupported` outcome. The agent path
  (saved-history lookup by owned thread id) is covered by unit tests against a
  fake history service, not against a real Codex/Claude store.
- **Off-machine access.** The smoke binds `127.0.0.1`. Binding `0.0.0.0` and
  reaching the app from another device on the LAN, and the Windows Firewall
  prompt that follows, have not been exercised.
- **Concurrent phones.** Only one client at a time was exercised.
- **IPv6.** Only IPv4 addresses are discovered and reported.
- **How the phone finds the desktop.** The bridge answers `GET /api/discover`;
  it does not advertise itself. Whatever the phone app uses to locate candidates
  — mDNS/Bonjour, a subnet sweep, a QR code — is the phone app's half and is not
  implemented or tested here.
- **Denial and expiry from the desktop prompt.** Deny and the auto-dismiss timer
  are covered by unit tests against the server; only **Allow** was clicked in a
  running app.
