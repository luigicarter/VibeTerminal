# Mobile application

Lina Terminal now has a third application alongside the desktop app and the
website: `apps/mobile`, an Expo SDK 57 React Native app written in TypeScript
that targets iOS and Android from one codebase.

## Platform decision

React Native with Expo was chosen over native Swift and Kotlin projects for two
reasons.

The development machine runs Windows. Xcode does not run on Windows, so a native
Swift app could not be built, run, or debugged here at all; the iOS half of the
product would be unbuildable locally. Expo's EAS Build compiles iOS binaries in
Expo's macOS cloud, which is the only path to an iOS build from this machine.

The rest of the repository is already React and TypeScript. `apps/desktop` is an
Electron app with a React renderer and `apps/website` is a React and Vite site,
so React Native reuses the language, the type system, the component model, and
the existing review habits. Two native codebases would have meant three
languages and three toolchains for one product.

The trade-off accepted: anything that needs a native module beyond Expo's
included set requires a development build rather than Expo Go, and iOS release
builds depend on Expo's cloud service rather than a local toolchain.

## What exists now

A companion remote for the desktop app. Projects are the top-level list, a
project opens into its terminals, **a terminal opens into the terminal itself**,
a pinned "Ask Lina" chat talks to the Orchestrator, and Settings pairs the phone
with a desktop over the local network. Every screen is real and reads live data;
there are no placeholder screens.

### Why the terminal, and not a chat

The first draft opened a terminal as a chat: the agent's transcript as bubbles,
with the terminal itself behind a segmented control. That was an imitation of
the thing rather than the thing. An agent's transcript is a *summary* the
desktop reconstructs from a session file — it lags, it drops the parts that are
not messages, and for a plain shell there is no transcript at all. The terminal
is the truth: the prompt it is parked on, the diff it is showing, the test that
is failing, the spinner that means it is still thinking.

So the terminal is now the screen. Opening a session lands in the desktop's own
xterm rendering of it, filling everything under the header, with the key bar
docked underneath. The conversation is still there — it is the record, and it
reads better than scrollback — but it is behind a **History** button, as a sheet
over the terminal, and it is the only thing on the screen that costs a request.

### The screens

- **Find your desktop** — the front door. On mount the phone looks for desktops
  itself and lists every one that answers `/api/discover`: machine name, address
  and version, with a `READ-ONLY` tag where the desktop says so. While it looks,
  a spinner and a progress line ("Scanning 192.168.2.x…") say what it is doing.
  Finding nothing gives "No desktop found on this network. On the desktop, open
  Settings → Phone and turn on phone connections." and a Scan again button. A
  muted "Enter an address instead" link at the bottom opens the typed form.
- **Approve on \<desktop\>** — tapping a desktop sends `POST /api/pair` with this
  phone's name and platform, then waits: a spinner and "Waiting for you to press
  Allow on the desktop…", with Cancel. The person approves on the desktop, the
  long poll returns the code, and the app pairs itself and goes to Projects. A
  refusal says "The desktop said no."; a request nobody answers says "Nobody
  answered on the desktop in time." with Try again; a desktop with three
  requests already waiting answers 429 and the phone says so.
- **Enter an address** (advanced) — the typed form, kept as the escape hatch for
  a desktop discovery cannot see: address, port (default 47831) and a pairing
  code that uppercases itself and inserts dashes as `XXXX-XXXX-XXXX-XXXX`.
  Connect calls `GET /api/hello`; a 401 says "That code did not match" and an
  unreachable address says "Could not reach `host:port`. Same Wi-Fi? Is phone
  access on?". The same form is reused inside Settings under Advanced.
- **Projects** (home) — header "Lina" with a connection dot and the desktop's
  machine name. First row is the pinned "Ask Lina" conversation: the brand chip,
  the Orchestrator's state, the last thing it said, and a badge with the number
  of active requests. Then, when there is anything in it, **"Waiting for you ·
  n"**: every terminal anywhere that is parked on a prompt or reported waiting,
  with its title, its project, its agent badge and the first line of what it is
  asking, in amber. Tapping one opens that terminal. Then "Projects · n" and one
  row per project: an attention or working dot, a folder icon, the name, the
  path truncated from the left, and the tally of working/done/waiting/failed
  terminals. Pull to refresh.
- **Project** — the project's terminals as rows: a status dot, the title,
  the agent badge, a status pill, the last snippet and a relative time. Waiting
  terminals sort first, then working, then the rest by recency.
- **Terminal** — the desktop's own xterm rendering of that session, live, under
  the header and above the key bar (see "The live terminal" below). The header
  carries a **History** button, which opens the conversation as a bottom sheet:
  read-only, the same bubbles as before, fifty messages at a time with "Load
  earlier" above them. A terminal the desktop has no transcript for loses the
  button. When the desktop reports that the terminal is parked on a prompt, a
  card of one-tap answers sits between the terminal and the key bar.
- **Ask Lina** — the Orchestrator conversation, with its tasks rendered inline as
  cards carrying the task text, a status chip, the terminal and project it went
  to, and the result or the error. The composer posts a new request.
- **Settings** — the connection card (desktop name, desktop id, address, version,
  last successful poll), "Find another desktop" (which drops this pairing and
  returns to discovery, since the phone holds one at a time), "Forget this
  desktop" behind an inline confirmation, an Advanced section holding the typed
  form, and an about card.

### Moving between screens

The app is one native stack, and which stack it is depends on the pairing rather
than on anything a screen pushes. `src/App.tsx` renders either the discovery
group (`Find`, `Approve`, `ManualPair`) or the paired group (`Projects`,
`Project`, `Chat`, `Lina`, `Settings`), chosen by whether `bridge.pairing` is
set. That is where the stack hygiene comes from and why no screen resets
anything by hand: approving a desktop swaps the group, so `Projects` is the root
and `Find` and `Approve` are *gone* rather than buried; "Forget this desktop"
and "Find another desktop" swap it back the same way, leaving `Find` as the root
with nothing of the session behind it.

**Back.** Hardware back, and the predictive-back gesture, are the native stack's
own: one press pops exactly one screen — `Project` → `Projects`, `Chat` → the
project it was opened from or, from the inbox, `Projects`, `Settings` → the
screen that opened it, `ManualPair` → `Find`. No screen adds a `BackHandler`
listener, because a JS listener that returns `true` races the stack's native pop
and can swallow a press instead of answering it. The two screens that *do* need
to react to leaving react to leaving, not to the button:

- `Approve` ends its pairing long poll from a `beforeRemove` listener, so the
  request is abandoned identically whether the person pressed Cancel, the header
  chevron or back, instead of being left parked on the desktop.
- Every sheet — History and the confirmations — is a React Native `Modal`, so
  Android hands the press to the sheet and `onRequestClose` closes it, leaving
  the screen underneath alone.

On the root screen (`Projects`, or `Find` before pairing) back is Android's:
it sends the task to the back. Inside Expo Go that means Expo Go's own home
screen, because the experience is a screen of Expo Go's; a standalone build goes
to the launcher. `app.json` keeps `android.predictiveBackGestureEnabled` false,
which matches: nothing in the app intercepts back, so there is nothing for a
predictive animation to run ahead of, and the setting stays off until the app
has a reason to turn it on.

**Sheets.** `src/components/Sheet.tsx` is the one bottom sheet, and everything
that is a sheet is built on it: `HistorySheet` and `ConfirmSheet`. It closes
four ways and they are all the same way — the X, a tap on the backdrop, a
downward swipe on its head, and hardware back. The swipe is a `PanResponder`
bound to the *head* rather than to the whole sheet, which is what lets the list
inside it still scroll, and is why this needs no gesture library. `ModalScreen`
applies the same rule to Settings: the header is the handle, a drag that starts
in the content belongs to the content, and because a tap is not a drag the
header's own X keeps working.

**Confirmations.** Nothing in this app raises a platform alert. The two actions
that throw the pairing away — "Forget this desktop" and "Find another desktop" —
ask through the same `ConfirmSheet`: a question, one line of consequence, Cancel
and the verb, with the destructive half in the failure colour.

**The keyboard.** `android.softwareKeyboardLayoutMode` is `resize` and every
screen with a text field wraps its content in a `KeyboardAvoidingView` with
`behavior="padding"` and no vertical offset — the view starts under the header
and measures its own frame against the keyboard, so there is nothing to correct
for. The padding comes out of the terminal, not out of the key bar: the bar and
the prompt chips stay above the keyboard and the terminal shrinks, then re-fits
itself, because the live terminal view calls `fit()` from its `onLayout`.

**Safe areas.** The header owns the top inset and, in landscape, the side ones;
the key bar and the composer own the bottom inset and the side ones; sheets own
the bottom inset. Everything between them — the lists and the scrolling content
— takes the side insets from `useSideInsets()`. No screen positions itself
against the status bar or the gesture bar by hand.

**Backgrounds.** The navigator theme, every screen's `contentStyle`, the root
view under the `NavigationContainer` and `Screen` itself are all
`colors.app`, so there is no white or grey frame between two screens at any
point in a transition. The status bar is light-on-dark everywhere.

### The look, in rules

`src/theme/tokens.ts` gained a `layout` block so that the rules are values
rather than habits: `gutter` (16dp, the side padding of every screen, row,
header, bar and sheet), `minTarget` (44dp) and `headerHeight`. A control may be
*drawn* smaller than 44dp — a 36dp icon button looks right next to a 15px title
where a 44dp one looks clumsy — but the area a finger may land on never is:
`touchArea(width, height)` computes the `hitSlop` that grows a drawn control out
to 44dp, and every icon button, key, chip and link goes through it.

Beyond that: a pressed state (a background tint, never only opacity) on every
row, button, chip and key; `SkeletonRows` — three shimmering placeholders in
`element` over `elementHover` — while a list waits for its first state, instead
of the word "Loading…"; one short line and one action in every empty state; a
slim `ConnectionBanner` under the header saying "Reconnecting to \<desktop\>…"
or "Can't reach \<desktop\>" with a Retry, which is what a coloured dot cannot
say (the dot stays); `LayoutAnimation` for the two things that come and go on
their own, the "Waiting for you" inbox and the prompt-chips card; the system UI
font everywhere except the terminal and the key bar's field, which are mono; and
`numberOfLines` on every title, path and snippet.

One small thing that is a fix rather than a rule: the Approve screen's spinner
is now `Ring`, two rounded borders and a rotation, rather than Android's
`ActivityIndicator`. Android's is an arc that is only a ring while its animator
is running, so a frame drawn before it starts — or a screenshot — is a dash.

### The live terminal

The screen is the desktop's own renderer: `GET /terminal/:id?code=<credential>`
serves a page that runs xterm with the desktop's theme and streams the session
over `GET /api/sessions/:id/stream?code=`, showing a slim "View only" strip
while input is unavailable. The app embeds it — a `react-native-webview`
`WebView` on a phone, an `<iframe>` in a browser, chosen by Metro through
`LiveTerminal.tsx` and `LiveTerminal.web.tsx` — and never reads the stream
itself.

#### Frame protocol 2, from the client's side

The stream is gzip-encoded `text/event-stream`; `EventSource` decodes it
natively, so neither the page nor the app handles compression. Its events:

- `hello {protocol: 2, cols, rows, seq, exited, control}` — the terminal's
  geometry, which is the desktop's, not the phone's.
- `scrollback {lines: [ansiRow…]}` — at most 300 lines, once, after `hello`.
- `screen {seq, rows: [[rowIndex, ansiRow]…every row], cursor: {x, y, visible}}`
  — the whole viewport. Sent after the scrollback, after a resize, and on any
  resync.
- `frame {seq, rows: [[rowIndex, ansiRow]…only the rows that moved], cursor}` —
  at most twelve a second.
- `resize {cols, rows}`, always followed by a `screen`.
- `exit {}`, and keepalive comments in between.

Rows are self-contained ANSI: each opens with `\x1b[0m` and ends with it, so a
row that arrives alone is drawn correctly whatever the row above it left behind.
A blank row is four bytes. Rendering is mechanical: scrollback lines are written
as `line + "\r\n"` each, a `screen` writes every row as `\x1b[<row+1>;1H` + row
+ `\x1b[K`, a `frame` writes only its own rows the same way, and the cursor is
placed with `\x1b[<y+1>;<x+1>H` and shown or hidden with `\x1b[?25h` /
`\x1b[?25l`.

(One detail that rule does not state: after writing the scrollback the page
writes `rows - 1` further newlines, pushing every scrollback line above the
viewport before the first `screen` paints it. Without that the paint lands on
top of the last twenty-three scrollback lines and that much history is lost.)

The xterm build is served from `/vendor/<hash>/xterm.js`,
`/vendor/<hash>/xterm.css` and `/vendor/<hash>/addon-fit.js`, where the hash is
the content of all three, under `Cache-Control: public, max-age=31536000,
immutable`. A phone downloads them once, ever, for a given desktop build. The
page no longer loads the fit addon — the stream dictates the geometry — but the
asset stays in the contract.

`GET /api/sessions/:id/transcript?limit=&before=` answers
`{ok, status, messages, total, nextBefore}`; `/api/state` may omit `statusLabel`
when it would only repeat `status` and `cwd` when it equals the project's path,
and caps `snippet` at eighty characters. All JSON may arrive gzipped, which
`fetch` handles.

#### Reading it on a phone

The terminal is as wide as the desktop says it is, and it **never scrolls
sideways**. `fit()` measures the font's glyph advance and picks the font size at
which every column fits the viewport width exactly, with a residual CSS
transform closing whatever xterm's own cell rounding left over; the drawn width
is the viewport width and can never exceed it. There is no lower bound on the
font size — a narrow phone showing a 120-column terminal gets very small text —
because zoom, not a scrollbar, is how small text is read here.

Pinch scales the container between 0.6x and 3x of that fit, anchored between the
fingers. Zooming without a finger — the key bar's `A−` and `A+`, and anything
else that calls `zoom()` or `resetZoom()` — anchors at the left edge and the
foot of the view instead, because a terminal reads from column zero and its
newest line is at the bottom: pressing `A+` twice must not leave the reader
panning back to where they already were. While it is zoomed, one finger drags
the content inside an `overflow: hidden` wrapper by a transform translate,
bounded so the content's edges never leave the viewport; a double tap returns to
the fit. When it is *not* zoomed, a drag belongs to xterm's own
vertical scrolling, as does a two-finger scroll. No scrollbar is drawn anywhere:
`.xterm-viewport` has `scrollbar-width: none`, its WebKit scrollbar is
`display: none`, and `html`, `body` and every wrapper are `overflow: hidden`.
In place of a scrollbar, a two-pixel indicator fades in on the right edge only
while the reader is scrolled away from the newest line. When the screen is
shorter than the frame it sits at the bottom of it, where a terminal's newest
line belongs.

The page exposes `window.linaTerminal` — `focus()`, `fit()`, `zoom(delta)`,
`resetZoom()`, `pan(dx, dy)`, `scrollToBottom()` — reached by `injectJavaScript`
in the WebView and by `postMessage` from the iframe. The key bar's `A−` / `A+`
step the zoom by 0.2 through it, and they stay enabled on a read-only desktop
because zoom is the page's business, not the desktop's. The app calls `fit()`
from the terminal view's `onLayout`, which is what makes a rotation re-fit; the
page also re-fits itself 200 ms and 800 ms after the first screen, because the
glyph advance is only final once the font has really loaded.

#### What the page says back

One channel: `{type:'ready'|'exit'|'error'|'stats'}` posted with
`ReactNativeWebView.postMessage` in a WebView and `parent.postMessage` in an
iframe, where only the paired desktop's origin is believed. The app draws a
spinner until `ready`, a muted "Terminal ended" over the last frame on `exit`,
and "Could not load the terminal" with a Retry on `error`; a page that has not
answered in fifteen seconds counts as an error. After the second failure the
plain-text `TerminalView` takes over, polling `/screen` every five seconds — and
it does not scroll sideways either; long lines wrap. That state machine is one
hook, `useLiveTerminal` in `src/components/liveTerminalState.ts`, so both
platforms behave identically. `stats {bytes, frames}` arrives every five seconds
and is what the Data line in Settings counts. The WebView is pinned to the
paired host with `originWhitelist`, neither scrolls nor bounces nor shows a
scroll indicator, and a tap calls `window.linaTerminal.focus()`.

#### The key bar

Docked under the terminal: **Esc** first and visually raised, Tab, the four
arrows, Enter, a sticky **Ctrl**, `^C`, `^D`, `^L`, `/`, **Paste**, `A−`, `A+`,
and a row holding a collapse chevron, a one-line field and a Send button. The
chevron folds everything but that last row away — Esc moves into it — when the
terminal needs the height.

Every key gives a light haptic tap (`expo-haptics`, skipped on web). The four
arrows repeat while held: 350 ms, then one every 80 ms. Paste reads the
clipboard with `expo-clipboard` and sends it as keys, and is disabled with the
rest of the bar on a read-only desktop. Ctrl is sticky — arm it, then type one
letter in the field and that letter is sent as its control code; the placeholder
says which letters matter, "Ctrl + a letter — c, d, l…".

Every one of them — and every
prompt chip — goes through a single function, `sendKeys` in `src/api/client.ts`,
which posts raw bytes to `POST /api/sessions/:id/keys {data}`. The bytes are a
table in `src/api/keys.js`: Esc ``, Tab `\t`, the arrows `[A` `[B`
`[D` `[C`, Enter `\r`, `^C` ``, and Ctrl+letter as
`String.fromCharCode(code & 31)`. The Send button sends the line followed by a
Return; `/` sends a slash and puts the caret back in the terminal. Interrupting
is `^C` on the bar: the app no longer calls `/input` or `/interrupt` at all,
though `src/api/client.ts` still transcribes them because they are part of the
bridge contract.

Nothing can be sent today. No desktop serves the write routes yet, so the bar is
built and disabled: it renders greyed under the read-only note. What decides is
the terminal page itself, which is the only thing that
knows whether control was granted — its `ready` message carries `control`, and
the app falls back to the pairing's `readOnly` flag when a page does not say. A
403 `control not allowed` or a 404 from `/keys` means the same thing and flips
the app through the existing `markReadOnly()` path.

### Being frugal with somebody's data

A phone on a train pays for every byte, so the app spends as few as it can.

- **The live terminal is unmounted, not hidden,** when the screen loses focus or
  the app goes to the background. Unmounting closes the `EventSource`, which is
  the single largest saving there is: a terminal nobody is looking at costs
  nothing at all.
- **`/screen` is never polled.** The live view replaced it. The plain-text
  fallback still polls, at five seconds rather than two, and only while it is
  what is on the screen — which only happens after the stream has failed twice.
- **The transcript is read when History is opened**, fifty messages, and again
  per "Load earlier". A terminal whose history nobody asks for never costs a
  transcript request.
- **Ask Lina's history is read only while that screen is focused**, as before.
- **The state long poll is unchanged**: one loop, 20-second waits, woken by the
  desktop's revision, stopped while the app is in the background.
- Settings shows a **Data** line: bytes read back since the app started, split
  into the state loop, the terminal streams and everything else. Those are
  decoded bytes — what the app parsed — because that is the number the app can
  measure; the desktop gzips both the JSON and the stream, so less than that
  crossed the network. A full walk of the UX against the mock reads about
  **3.0 kB of state, 3.7 kB of terminal and 5.8 kB of everything else**.

What the protocol saves is measurable. Against the mock's storm mode — one
session rewriting all twenty-four rows thirty times a second — three seconds of
watching sends **about 2.1 kB/s**, where a protocol that sent the whole screen
on every change would have sent **about 86 kB/s**: a ratio of **42x**, from the
twelve-frame cap and gzip together. On the ordinary demonstration terminal,
which rewrites two rows every 300 ms, a second of watching costs about 1.0 kB
against 19 kB. `npm test` prints both numbers and fails below 5x.

### Being told when something wants you

The phone posts local notifications for three things and nothing else: a
terminal whose `needsInput` **becomes** non-null, a terminal that goes **from
working** to done, exited or failed, and the Orchestrator's `lastMessageAt`
**moving**. Everything else a poll can see — a snippet changing, a spinner
turning, a terminal going idle to working — is the desktop getting on with it.

That is a comparison, not a reading, so it is written as one: `diffNotifications`
in `src/state/notifications.js` takes the snapshot the phone last saw and the one
that just arrived, and returns what the difference earns. Edge-triggered
throughout — a terminal that is *still* asking, or that has *stayed* finished,
produces nothing however often the state is polled — and with no previous
snapshot it produces nothing at all, because the first sight of a desktop is a
baseline rather than news. A terminal the phone has never seen counts as "was not
asking", so one that appears already parked on a prompt does notify; it cannot
produce a "finished", because that edge needs a previous `working`. Past four
items the rest collapse into one line saying how many there were, because a phone
that has been asleep for an hour can come back to twenty changed terminals and
twenty notifications is a wall rather than information.

The other half of the comparison is `notificationStore.ts`: one snapshot,
persisted, reduced to what a comparison reads — each session's id, status and
whether it is asking, plus `lastMessageAt`. The *words* always come from the side
that just arrived, never from the stored one, which is what keeps the stored
value inside `expo-secure-store`'s two-kilobyte comfort. Every path that can
notify goes through one serialized `recordState`, because the long poll and the
background task can both be awake and two comparisons against one stored snapshot
would notify twice for one event. The snapshot is recorded even when
notifications are switched off, so turning them back on does not bring a backlog.

`notifier.ts` is the only file that imports `expo-notifications`,
`expo-task-manager` or `expo-background-task`, and `notifier.web.ts` is the same
surface as nothing at all, so the browser build — which is how the screenshots
are taken — never loads any of it. Two Android details are written down there
because both were wrong first: a notification's **channel comes from the
trigger**, not from the content (`{channelId}` is the "deliver now, on this
channel" trigger; a plain `null` lands everything on expo-notifications' own
fallback channel), and the small icon is a **silhouette** — Android keeps its
alpha and throws its colours away, so the brand PNG arrives as a grey block.
`assets/notification-icon.png` is therefore generated separately, by
`scripts/make-notification-icon.cjs`, which rasterizes `lina-symbol.svg` — whose
two paths are three axis-aligned rectangles — as white on transparent at 96x96,
with no image library and no dependency added to the app.

Permission is asked for once, on the first launch after a pairing: before that
there is nothing to be notified about, and a permission dialog on the front door
is a dialog about nothing. A refusal is remembered as a refusal. Settings carries
the switch, on by default once the permission is granted, with a line under it
that says what this phone will actually do.

**Nothing is posted while the app is in front** — the screen already says it —
only a light haptic. Tapping a notification opens the terminal it is about,
through `src/navigation/ref.ts`: a notification is tapped by the operating
system, not by a screen, and the tap can be what started the process, so the
session id is held and answered once the container is ready and the paired stack
exists. A tap that arrives while the phone is unpaired is dropped rather than
queued.

#### What the operating system allows

- The long poll **keeps running for a minute after the app is backgrounded**
  (`BACKGROUND_GRACE_MS`), because the most likely moment for a terminal to want
  something is just after the phone was put down. It stops a poll or so past the
  minute rather than exactly on it, and it has to: **Android does not run a
  backgrounded app's JavaScript timers.** The first implementation was a
  `setTimeout`, which never fired, and the poll ran in the background
  indefinitely — measured still notifying eighty seconds after backgrounding. The
  loop reads `Date.now()` itself at the top of each iteration instead.
- After that there is only `expo-background-task`, and **fifteen minutes is
  Android's floor**. The system treats the interval as a minimum and a
  suggestion at once: it batches wakes, skips them under Doze and on a low
  battery, and runs none at all while the app is force-stopped. Each wake is one
  `/api/state?wait=0`, compared against the stored snapshot — it has a moment,
  not a connection, so it cannot long poll.
- There is no push anywhere in this: no server, no Firebase project, no Expo push
  token. Every notification was decided on the phone from something it read off
  the person's own desktop.

### Prompts a terminal is waiting on

`/api/state` sessions carry `needsInput: null | {kind, prompt, options}`. When it
is set, a card sits between the terminal and the key bar — the prompt on two
lines and one chip per option, "1 · Yes", "2 · Yes, and don't ask again",
"3 · No…" — and tapping a chip sends that key and a Return. The terminal's row in
a project shows a `NEEDS YOU` pill (`#ffc466`) instead of its status pill, the
terminal appears in the home screen's "Waiting for you" inbox, and the project's
tally counts it under waiting whatever status the desktop gave it: it may well
still be "working", but it is waiting for the person holding the phone. Reading
that field, moving the count, and picking and ordering the inbox are one pure
module, `src/state/needsInput.js`, shared with the tests; it is defensive
because the desktop parses those prompts out of a terminal screen. The inbox
also holds terminals the desktop simply calls `waiting`, with no parsed prompt —
those sort after the ones there is something to tap.

### Finding a desktop

`GET /api/discover`, `POST /api/pair` and `GET /api/pair/:requestId` carry no
code: they are how a phone earns one. Approval happens on the desktop, so the
phone never asks anyone to read a code off a screen.

`src/state/candidates.js` decides where to look, as pure data, because the right
answer differs in four places at once:

- the Metro host from `Constants.expoConfig.hostUri`, on both bridge ports —
  the machine serving the bundle is nearly always the machine running the
  desktop;
- `10.0.2.2` on Android when that dev host is loopback or absent, because inside
  an emulator `localhost` is the emulator;
- `localhost` on both ports, which is what the web build and a simulator need;
- on a phone only, every address on its own /24 from `expo-network`'s
  `getIpAddressAsync()`, port 47831, 700 ms per probe, forty in flight.

`src/state/discovery.ts` runs the seeds first and reports each answer as it
lands, so the list fills in before the sweep finishes, and dedupes on
`desktopId` so one desktop reachable at two addresses appears once. A browser
skips the sweep: it cannot scan a subnet and does not need to.

Pairing is then three calls. `POST /api/pair` sends `{deviceName, platform}` —
the name from `expo-device`, falling back to "Phone" — and gets back a request
id. `GET /api/pair/:requestId?wait=20000` parks until somebody answers on the
desktop, and the approval carries the code once. The app stores it with the
desktop's id and goes to Projects.

If the desktop later stops accepting that code — a rotation, a reset — the poll
loop sees a 401, forgets the pairing and returns to discovery with "This desktop
signed phones out; pair again."

### How data reaches the screens

One long-poll loop owns the connection. `src/state/bridge.tsx` holds the pairing,
the connection status and the last `/api/state` snapshot; it asks the desktop to
hold each request open for 20 seconds, returns as soon as the desktop's revision
moves, and backs off 1 → 2 → 5 seconds when a request fails. It stops while the
app is in the background and resumes when it comes forward. No screen polls
`/api/state` itself: they read the snapshot and select from it. Only Ask Lina
polls on a timer now, `/orchestrator/history` every three seconds and only while
it is focused. The terminal screen polls nothing at all — the live terminal is a
stream, the transcript is read on demand, and `/screen` is polled only by the
plain-text fallback, every five seconds, only while that fallback is what is on
the screen.

That loop is also where notifications are decided, which is why the small history
read behind the "Ask Lina" snippet moved into it: "Lina replied" wants the same
line and neither should pay for it twice. The loop claims the message's timestamp
as a key *before* it awaits, so nothing else fetches the same history, and
publishes what comes back. And the loop no longer stops the instant the app is
backgrounded — see "Being told when something wants you" above for the minute of
grace and why it cannot be a timer.

`src/api/client.ts` is the whole network surface: a typed fetch wrapper with an
eight-second timeout (the long poll gets its wait plus eight), the
`Authorization: Bearer` header built from the code with its dashes stripped, and
errors normalised into one shape so screens can say something specific about a
401, a 404, a 409 or a dead network. It is also where the bytes are counted: the
length of every body it parses goes into one of three buckets, and the terminal
streams add theirs from the page's `stats` messages. `src/api/types.ts` is the
contract itself.

The pairing is stored by `src/state/storage.ts`: `expo-secure-store` on a phone,
`localStorage` in a browser, and process memory if both are unavailable.

### Read-only desktops

A desktop may serve the bridge for reading only. `GET /api/hello` then reports
`readOnly: true`, and the write routes answer 404 `not found`. The app stores
that flag at pairing time and re-reads it on every reconnection; when it is set,
the key bar and the prompt chips render disabled under the note "This desktop
build only shows your terminals. Typing from the phone is not enabled yet." —
except `A−` and `A+`, which zoom the page rather than touching the desktop — the
Ask Lina composer is replaced by the same note, and reading, polling and
navigation stay live. Independently of the flag, a 403 `control not allowed` or
a 404 from any write route is treated as the same answer, so an older or newer
desktop never produces a raw error. That mapping is one pure function,
`isReadOnlyRejection` in `src/api/readOnly.js`, shared by the app and the tests;
its routes are `input`, `keys`, `interrupt` and `orchestrator-request`.

### The look

`src/theme/tokens.ts` transcribes the desktop renderer's palette, spacing, radii
and type sizes; `src/theme/agents.ts` holds every agent's label and accent
colour; `src/theme/status.ts` holds the status pill, session dot and task status
mappings. The values are literal copies, not a reinterpretation: the desktop
owns the design.

### The mock bridge

`apps/mobile/scripts/mock-bridge.cjs` is a `node:http` server
that implements the same contract over demonstration data: three projects in
three clearly separate folders, seven terminals across the agent kinds, a
transcript and screen text for each, an Orchestrator history with tasks in
different states, working long polling, and a timer that moves one terminal's
status every eight seconds so long polling visibly wakes. It answers the pairing
code `MOCK-MOCK-MOCK-MOCK`, refuses anything else with 401, and serves CORS
headers so the web build can talk to it. It listens on 47832, one port above the
desktop's 47831, so both can run at once.

Two unauthenticated test hooks stand in for a terminal doing something, the way
the approval hooks stand in for somebody pressing Allow on a desktop.
`POST /__mock/needs-input/<id>` parks a terminal on a prompt — the body may
carry `{prompt, options}` or `{clear: true}`, and an empty body gives the
demonstration prompt — and `POST /__mock/status/<id>/<status>` moves one
terminal to any status the contract has. Both bump the revision, so a parked long
poll wakes. The eight-second demonstration timer is enough to show that long
polling works and useless for driving a *particular* change at a *known* moment,
which is what checking a notification needs.

It also serves discovery and pairing, with a stable `desktopId`. A pairing
request is approved two seconds later, as if somebody pressed Allow;
`--pair=deny` refuses instead, and `--pair=manual` leaves requests pending and
prints `PAIR <requestId>` so a person or a test can answer with
`POST /__mock/approve/<requestId>`. `--pair-expiry=<ms>` shortens the timeout and
`--read-only` makes the whole bridge imitate a read-only desktop.

It serves the live terminal too, so the phone's terminal screen is exercised end
to end without a desktop, and it implements frame protocol 2 rather than
imitating it. `GET /terminal/:id?code=` is a real xterm page, not a picture of
one: `@xterm/xterm` and `@xterm/addon-fit` are mobile-owned development
dependencies, so a fresh `npm ci` in `apps/mobile` provides the preview assets
without installing the desktop app. `--xterm-dir` remains an explicit override.
The mock serves assets under their content hash at `/vendor/<hash>/*` with
immutable caching and reports missing assets on the page and stderr.

Behind the stream is a real screen model per session: twenty-four rows of
eighty columns, the scrollback above them, and a cursor, written to by a small
terminal emulator that understands `\n`, `\r`, tabs, wrapping and scrolling. The
demonstration screen is seeded into it along with thirty-odd lines of earlier
output, so the `scrollback` event has something to carry. Attaching flushes any
pending frame, then sends `hello`, the scrollback and a full `screen`; after
that only `frame`s, carrying the rows that differ from what has already been
published, at no more than twelve a second. The working Codex terminal rewrites
its last two rows every 300 ms, which is what a spinner really does and what
makes the difference between a frame and a screen visible. `bridge.resize(id,
cols, rows)` re-flows the model and sends `resize` then `screen`. The stream and
every JSON body over 512 bytes are gzipped when the client says it can take
them. The Claude session carries a `needsInput` menu — "Edit
apps/desktop/frontend/components/StatusPill.tsx?" with three answers — and every
other session carries `null`.

`--storm` is the measuring instrument: one session (the Fusion one) rewrites
every row thirty times a second, and `bridge.streamStats(id)` reports the bytes
actually written against the bytes a full-screen-per-change protocol would have
written. The test prints both and fails under 5x; it measures around 42x.

`GET /api/sessions/:id/transcript?limit=&before=` pages backwards through the
conversation and reports `total` and `nextBefore`. `/api/state` leaves out a
`statusLabel` that only repeats the status and a `cwd` that only repeats the
project's path — two of the seven demonstration sessions carry a real label, one
a real working directory — and truncates snippets at eighty characters.

`POST /api/sessions/:id/keys` is the route no desktop serves yet. By default the
mock refuses it with 403 `control not allowed` and the page it serves is
view-only, which is the state shipping today. `--control` grants it: the page
gains `send`, the key bar comes alive, and the bytes are echoed into the screen
and into the stream (`\r` as a new line, `` as `^C`), so the whole key bar
can be driven against the mock.

### Identity

- `app.json` carries the Lina Terminal identity: name `Lina Terminal`, slug
  `lina-terminal`, URL scheme `lina`, version 0.1.0, `default` orientation,
  automatic light/dark interface style, and `newArchEnabled`. The orientation is
  `default` rather than `portrait` because a terminal is wide: landscape is how
  eighty columns become legible without zooming. `App.tsx` also calls
  `ScreenOrientation.unlockAsync()` once on a device, in case something else has
  pinned the app, and the terminal view re-fits the page from its `onLayout`
  whenever the phone turns.
- Icons, the Android adaptive-icon foreground, the splash image, and the web
  favicon come from the shared brand package instead of the template art.
- The splash screen is configured through the `expo-splash-screen` config
  plugin, the SDK 57 arrangement, rather than the retired top-level `splash` key.
- Four more config plugins: `expo-secure-store`; `expo-build-properties` with
  `android.usesCleartextTraffic`; `expo-notifications` with
  `assets/notification-icon.png`, the `#FFC466` accent and the `terminals`
  default channel; and `expo-background-task`. Everything the native build needs
  is a plugin option, never a hand edit, because the native folders are outputs.
- `ios.bundleIdentifier` and `android.package` are both
  `com.linaterminal.mobile`.

### Dependencies added for notifications and the native build

`expo-notifications`, `expo-task-manager` and `expo-background-task` are the
three notifications rest on. `expo-build-properties` carries one Android option,
`usesCleartextTraffic: true`: the desktop bridge is `http://<address>:47831` on
somebody's own network and Android has refused cleartext by default since API 28,
so without it a real build reaches no desktop at all — a config plugin rather
than a hand-edited manifest, because the native folders are generated. And
`expo-system-ui` is there because `userInterfaceStyle: automatic` needs it; the
prebuild says so if it is missing. All installed with `npx expo install`.

### Dependencies added for this draft

`@react-navigation/native` and `@react-navigation/native-stack` with
`react-native-screens` and `react-native-safe-area-context` for navigation,
`expo-secure-store` for the stored pairing, `@expo/vector-icons` for the Feather
icons, `expo-constants`, `expo-network` and `expo-device` for discovery (the
Metro host, the phone's own address, the name it gives a desktop),
`react-native-webview` for the live terminal (it is part of Expo Go, so it needs
no development build), `expo-haptics` for the key bar's tap, `expo-clipboard`
for its Paste key, `expo-screen-orientation` so the app can unlock rotation, and
`react-native-web`, `react-dom` and `@expo/metro-runtime` so the app runs in a
browser. All were installed with `npx expo install` so the versions match SDK
57. There is no state-management library, no HTTP library, no terminal library
in the app itself — xterm runs in the page the desktop serves — and no test
framework.

## Build and shipping from Windows

`npm run build:mobile` runs `expo export`, which bundles JavaScript and assets
for both platforms into `apps/mobile/dist`. It is a bundle export, not a native
build: it needs no Xcode and no Android SDK, which is why CI can run it on
`ubuntu-latest`. Both platform bundles are Hermes bytecode, roughly 2.1 MB each.

### The Android development build

`npm run android:dev` (`expo run:android`) compiles the app with its own native
code and installs it as `com.linaterminal.mobile`, loading JavaScript from Metro.
Notifications are native modules and do not exist inside Expo Go, so this is
where anything past reading the UI has to be checked. It needs the Android SDK, a
JDK 21 and `ANDROID_HOME`; the first build downloads Gradle 9.3.1 and NDK
27.1.12297006 and takes minutes. `--no-bundler` reuses a Metro already on 8081,
and `--device` takes the **AVD name**, not the adb serial — `emulator-5554` is
answered with "Could not find device with name".

### The release APK

`npm run android:release` runs `apps/mobile/scripts/build-android-release.cjs`,
which produces one signed, sideloadable APK locally, with no EAS account and no
store. It synchronizes the brand assets, regenerates the notification icon, runs
`expo prebuild --platform android --clean` so the native project is written fresh
rather than carried over, patches the release signing config (Expo's template
signs `release` with the **debug** key), runs `gradlew assembleRelease`, copies
the result to `apps/mobile/.tmp/dist/LinaTerminal-<version>-android.apk`, and
prints its size and SHA-256. Then it **verifies the signature** rather than
assuming it: the APK's signer certificate must be the keystore's, or the build
fails — necessary because the patched config falls back to the debug key when the
properties are absent, which it must, or `expo run:android` would stop working on
a patched project.

The key lives in `apps/mobile/.tmp/keys` and is never committed — `.tmp/` is
gitignored and so is `*.keystore`. `.tmp/keys/README.txt` records the alias, the
algorithm, the password and the `keytool` command that made it; the password is
read from `.tmp/keys/.password` or `LINA_ANDROID_KEYSTORE_PASSWORD` and passed to
Gradle as a `-P` property, so it never reaches `gradle.properties` and is redacted
from the script's own output. It is also the app's identity: Android refuses an
update signed by a different key, so losing it means every phone with the app
installed must uninstall before it can install again, and a release APK cannot be
installed over the development build (which carries Android's debug key).

`expo prebuild` rewrites the `ios` and `android` npm scripts to `expo run:*` when
it creates a native folder. The release script puts them back, because a build
silently editing a checked-in file is only a diff to explain later.

**The native folders stay generated and gitignored.** Nothing that has to survive
a clean checkout may live in `android/` — only in `app.json` or a config plugin,
which is why cleartext HTTP and the notification icon are plugin options rather
than manifest edits. `android:release` deletes and rewrites the folder on every
run, which is what makes the output reproducible after a clean checkout.

### Store builds

Store binaries would come from EAS Build:

```powershell
npx eas-cli build --platform android
npx eas-cli build --platform ios
```

Android output goes to the Play Console internal track and iOS output to
TestFlight. None of this has been set up: there is no `eas.json`, no linked Expo
account, and no project id. The APK above is for sideloading, not for a store: a
store build wants an `.aab`, a versionCode policy and a confirmed application id.

Day-to-day development on Windows uses Metro on port 8081 with Expo Go on a
phone, or an Android emulator through `npm run android:mobile`.

## What is wired into the repository

The mobile app is separated the same way the website is. It owns its
`package.json`, `package-lock.json`, `node_modules`, `.gitignore`, `README.md`
and `AGENTS.md`, and it is not part of an npm workspace; the repository root has
no runtime dependencies.

- Root scripts forward through `scripts/run-app.cjs`, whose app whitelist now
  accepts `mobile`: `dev:mobile`, `ios:mobile`, `android:mobile`,
  `build:mobile`, `typecheck:mobile`, `test:mobile`, `setup:mobile`. `setup`,
  `build:all` and `test` include mobile.
- `scripts/sync-brand.cjs` gained a `mobile` entry that copies
  `lina-logo-1024.png` to `assets/brand/icon.png` and
  `assets/brand/splash-icon.png`, `lina-logo-adaptive-1024.png` to
  `assets/brand/adaptive-icon.png`, and `lina-logo.png` to
  `assets/brand/favicon.png`. The app's npm `prebuild` hook runs it before every
  build, exactly as the website does.
- `scripts/export-brand.cjs` now also writes `packages/brand/lina-logo-1024.png`
  (the full 1024px render) and `packages/brand/lina-logo-adaptive-1024.png` (the
  mark at 66% of a transparent 1024px canvas, inside Android's adaptive-icon
  safe zone). The existing 512px PNG and the Windows ICO are unchanged
  byte-for-byte.
- `scripts/monorepo.test.cjs` includes mobile in its per-app independence checks
  and in the brand source-to-consumer parity mappings.
- `apps/mobile/scripts/config.test.cjs` runs on the Node test runner, with no
  test framework added. It checks the app identity including the `default`
  orientation, the splash plugin options, that the packages the terminal page,
  the key bar and the notifications need are installed and declared, that every
  asset `app.json` references exists, that the icon, adaptive icon and splash
  icon are 1024x1024 PNGs by reading the PNG IHDR bytes, that the notification
  icon is 96x96 and every drawn pixel of it is white (it is a silhouette, and a
  coloured one is a grey block on a phone), that the notifications plugin points
  at it and names the same channel the app posts on, that cleartext HTTP is
  allowed for the LAN bridge, that the release build has a script which can
  reproduce it, and that no unreferenced template art is left in `assets`.
- `apps/mobile/scripts/notifications.test.cjs` pins the notification rule as pure
  data, which is the whole reason it is a pure function: the first sight of a
  desktop is a baseline rather than news; a terminal that starts asking notifies
  with the first line of its prompt; one that stops working finishes, fails or
  exits, and one that was not working cannot finish; the Orchestrator answering
  is one notification, with a truthful body when the background wake has no
  message text to hand; an unchanged state notifies nothing however often it is
  polled; a terminal that keeps asking does not ask twice, and one whose prompt
  comes back is news again; a `needsInput` with neither a prompt nor options is
  not a prompt; a wall of changes collapses into a countable number of them; and
  a snapshot stored and read back is the same baseline as the live one.
- `apps/mobile/scripts/mock-bridge.test.cjs` runs on the same runner and boots
  the mock on an ephemeral port: the pairing code and its 401, the shape of every
  contract response, a long poll that parks and then wakes on a status change,
  input echoed into the screen and the transcript, the 409 for an exited terminal,
  the whole Orchestrator request lifecycle, CORS preflight, and read-only mode.
  It covers frame protocol 2 in full: the opening `hello` with exactly its six
  fields, the `scrollback`, one `screen` carrying every row, then `frame`s that
  carry only the rows that moved and never the ones that did not; that every row
  on the wire opens and closes with a reset; that the frame rate stays inside
  twelve a second however fast the screen changes, while the underlying change
  count runs far ahead of it; that a resize is announced and then repainted in
  full; that an exited terminal streams its last screen and ends; that a Return
  at the bottom of a terminal honestly reports every row as changed, because a
  scroll changes every row. Storm mode is measured rather than asserted at: the
  test prints the bytes per second actually sent against the bytes a
  full-screen-per-change protocol would have sent, and fails under 5x. Beside
  those: that JSON worth compressing is gzipped and round-trips identically,
  that the transcript pages backwards to the beginning and reassembles exactly,
  that the state leaves out what the phone can work out, that the xterm assets
  answer under their content hash with an immutable cache header and 404 under
  any other hash, that the page's CSS really does forbid horizontal scrolling
  and draw no scrollbar, and that the page's three geometry functions — which it
  runs verbatim, injected from this module — never draw the terminal wider than
  the viewport and never let a pan leave the content's edges. Then the terminal
  page answering 200 with the code and 401 without it, the Claude session's
  `needsInput` and nobody else's, keys echoed into the screen and the next frame
  under `--control`, and keys refused with 403 without it and 404 in read-only
  mode. And it pins the pure pieces the key bar, the chips and the inbox depend
  on: the exact byte for every key, `Ctrl`+letter as a control code, a prompt
  read defensively into a card and a waiting count, and the order the "Waiting
  for you" list is built in.
  It also covers discovery and pairing: `/api/discover` answering without a code,
  an approval handing over the code exactly once and only once, a denial, a
  request nobody answers expiring, a fourth pending request refused with 429, and
  a parked poll waking the moment somebody answers. And it exercises the pure
  mappings the UI depends on — a 404 from a write route meaning "read-only", what
  the connection dot and the Orchestrator subtitle may claim before the first
  poll, and the address list discovery tries — by requiring the exact modules the
  app imports.
- `apps/mobile/scripts/capture-web.cjs` (`npm run capture`) exports the app for
  web, serves it, starts a private mock bridge, and walks the whole UX inside a
  390x844 Electron window borrowed from `apps/desktop/node_modules`, writing one
  PNG per screen into `apps/mobile/.tmp/screens`. It walks the real front door —
  discovery finds the mock, the approval screen appears, the mock approves — and
  drives `data-testid` hooks rather than visible text, so the walk does not break
  when wording changes. Its mock takes 47832, or 47831 when that is busy, because
  those are the only ports discovery looks at, and it carries a unique
  `desktopId` so a stray mock left running on the other port cannot be the
  desktop the walk pairs with. The shots are `01-discover`, `01b-approve`,
  `02-projects` (which waits for the "Waiting for you" section), `03-project`,
  `04-session` (the live terminal at its fit, filling the width exactly),
  `04b-history` (the sheet open over it), `04c-zoomed` (after three presses of
  `A+`, which is `zoom(+0.6)`, then dragged off the left edge), `05-keys`,
  `06-lina`, `07-settings` (the modal) and `08-settings-modal` (the app's one
  confirmation sheet, open over it; the walk then cancels, because it has to
  survive its own screenshot). `npm run capture -- --control` runs the same walk
  against a mock that grants control, where the bar is live and `05-keys` is
  taken with Ctrl armed. What the walk cannot photograph is what only a device
  has — the soft keyboard, a rotation, the hardware back button and the swipes
  that dismiss a sheet — and those are covered on an emulator instead.

  One thing about that is worth writing down. The live terminal is an
  out-of-process frame; this window has no GPU and is shown inactive, so
  software compositing only carries what it is told is damaged. A terminal
  parked on a prompt produces no frames, and it can be absent from the *first*
  snapshot taken of it even though its DOM is provably correct — measured
  in-page as `scale 1.013, tx 0, ty 217, font 8.2px`, the right answer,
  photographed as an empty rectangle. Asking for a frame is what composites it,
  so every shot throws the first `capturePage` away and keeps the second.
  Nothing on a phone needs this: there the compositor is awake and the stream
  keeps painting.
- `.github/workflows/mobile.yml` is a path-filtered workflow on `ubuntu-latest`
  with its own npm cache, running `npm ci`, `npm run typecheck`, `npm test` and
  `npm run build` from `apps/mobile`. Mobile changes do not trigger the desktop
  or website workflows.

The npm `prebuild` script and `npx expo prebuild` are different things. The npm
script is a lifecycle hook that only synchronizes brand assets. `expo prebuild`
generates native `ios/` and `android/` project folders; it has not been run, the
project stays managed, and both folders are ignored.

## Verified on a device, and how

The navigation and polish work was verified on an **Android emulator** — a Pixel
9 Pro XL, Android 17, 1344x2992 at 480dpi — running the app in **Expo Go**
against `scripts/mock-bridge.cjs --control`, driven over `adb`. Screenshots are
written to `apps/mobile/.tmp/emulator`, which is gitignored.

The native build and the notifications were verified on the same emulator,
against the same mock, and that is where the app stopped being an experience
inside Expo Go.

**The development build.** `expo run:android` built and installed
`com.linaterminal.mobile` (Gradle `BUILD SUCCESSFUL in 4m 10s`, 232 tasks). The
launcher shows the Lina adaptive icon and the name "Lina Terminal" next to Expo
Go rather than inside it; a cold start paints the **dark Lina splash**, not Expo
Go's white one; discovery found the mock through `adb reverse` and pairing went
straight to Projects; and hardware back on the root screen resumed
`NexusLauncherActivity` with the app's process still alive.

**Notifications.** Android raised the POST_NOTIFICATIONS dialog immediately after
pairing and `dumpsys package` then reported `granted=true`. A `terminals` channel
exists at `mImportance=4` with the vibration pattern and the `#FFC466` light. A
prompt set on a backgrounded phone posted "Checkout flow needs you" with the
prompt's first line, on `channel=terminals`, with the monochrome Lina icon; the
same change with the app in front posted nothing at all; tapping the notification
opened that terminal, prompt card and all. The **background task** was proved
separately: with the app backgrounded past the grace window and the foreground
loop provably stopped (a change went unnoticed for thirty seconds), forcing the
scheduled job with `adb shell cmd jobscheduler run -f com.linaterminal.mobile
<job>` posted "Phone bridge endpoints needs you" from the wake. The job itself
was there in `dumpsys jobscheduler`, on a `TIME=+13m38s` periodic schedule.

**The release APK.** 77.2 MB, signed by the release key (the script's own
`apksigner` check matched the keystore's SHA-256), installed with
`adb install -r` after uninstalling the development build — which Android refuses
to update across a signature change, as it should — and run with the `adb
reverse` to Metro **removed**: it opened, discovered the mock, paired, loaded
every screen and posted notifications with no bundler reachable at all. The
bundle is inside the APK (`assets/index.android.bundle`) and the package carries
no `DEBUGGABLE` flag.

Three things about that harness are worth writing down, because all three wasted
time before they were understood:

- `expo run:android --device` wants the **AVD name** (`Pixel_9_Pro_XL`), not the
  adb serial; `emulator-5554` is answered with "Could not find device with name".
- **A backgrounded Android app's JavaScript timers do not fire.** The minute of
  grace after backgrounding was first a `setTimeout`, which meant the long poll
  never stopped — it was measured still notifying eighty seconds after the phone
  was put down. The loop checks the clock itself now.
- A notification's Android channel comes from the **trigger**, not the content.
  `trigger: null` put every notification on expo-notifications' fallback channel
  while `content.channelId` was silently ignored.

- `adb shell uiautomator dump` is how a step confirms which screen it is on —
  it prints every `testID` as a `resource-id`, which is far cheaper and far more
  exact than reading a screenshot. But it **refuses to dump a window that never
  goes idle**, and then leaves the previous dump in place: a screen carrying a
  spinner, a shimmer or the live terminal reads as whatever screen was dumped
  last. Any step that uses it has to delete the file first and treat a missing
  file as "unknown", not as "unchanged".
- Synthetic input is delivered late on a loaded emulator. A screenshot taken two
  seconds after `adb shell input tap` can show the screen *before* the tap.
  Steps wait on a condition, never on a sleep.

What was seen there:

- **Back pops one screen at a time.** From the terminal screen: back → the
  project, back → the project list, back → out of the app, with the process
  still alive and no `ErrorActivity` in `dumpsys activity activities`. Before
  this change the terminal screen swallowed back entirely — several presses left
  it exactly where it was and then dropped the whole app.
- **Settings opens as a modal and closes onto what opened it.** Opened from the
  terminal screen it slides up with its X and its grab handle; back closes it
  and the terminal is underneath again, re-fitted.
- **The confirmation sheet.** "Forget this desktop" raises the sheet over the
  Settings modal — question, one line, Cancel and Forget in the failure colour —
  and back cancels it, leaving Settings open.
- **The keyboard.** Focusing the key bar's field opens the soft keyboard with
  the whole key bar and the prompt-chips card above it and the terminal shrunk
  to what is left.
- **Landscape.** `user_rotation 1`: the header clears the cut-out, the terminal
  re-fits to the wider frame — eighty columns, legibly — the chips card reflows
  to one row, and the key bar sits above the gesture bar. Rotating back re-fits
  again.
- **Skeletons, the empty state and the offline banner.** The project list shows
  three shimmering rows before the first `/api/state` lands; with the bridge
  unreachable it shows "Can't reach LINA-DESKTOP" with a Retry above "No
  projects open on the desktop." and its "Check again"; while a poll is retrying
  it shows "Reconnecting to LINA-DESKTOP…".

## Not verified

- **No real phone has run this app**, and no iOS device or simulator ever will
  from this machine. Everything below the emulator — a physical touchscreen, an
  iOS `WKWebView`, a notched device's insets — is still unexercised.
- **No gesture has ever been made with a finger.** Pinch-to-zoom, the two-finger
  scroll, the one-finger pan while zoomed, the double tap that resets, and the
  arrows' hold-to-repeat are all written against touch and pointer events and
  were exercised only in the capture's Chromium: the zoom through the key bar's
  `A+`, which is the same `zoom()` a pinch calls, and the pan through the page's
  `pan()`, which is the same one a drag calls. The `touchstart`/`touchmove`
  handlers themselves, and whether `touch-action: pan-y` lets xterm keep its own
  vertical scrolling on a real phone, have not been run. The same is true of the
  two swipes this change added — the one that dismisses a sheet and the one that
  dismisses the Settings modal: both are `PanResponder`s, and `adb` can only
  synthesize the drag, not make it.
- **The live terminal's own behaviour is still only the emulator's.** It does
  load and stream there — `react-native-webview` renders the desktop's page,
  the fit is correct in both orientations, and Settings counts the stream's
  bytes — which is the first time the `WebView` half has run at all. But the
  overlay's error path was also seen, when the page could not be reached through
  the `adb reverse` tunnel, and which of the two a real phone on a real network
  gets is not something this setup can answer.
- **The haptics cannot be tested here at all.** `expo-haptics` is a no-op the app
  skips on web, so every key's tap has been compiled and never felt. The same is
  true of `expo-clipboard`: Paste was type-checked and bundled, and no clipboard
  has ever been read.
- **Landscape has been seen on an emulator only**, by writing `user_rotation`
  rather than by turning anything: what a device's own rotation animation does
  to the terminal's fit mid-turn is unseen, and so is landscape on a phone whose
  cut-out is on the side the app has to indent past.
- The "never scrolls sideways" guarantee is proved two ways, neither of which is
  a phone: the page's sizing functions are unit-tested directly (the drawn width
  is the viewport width, at every viewport and column count tried), and the
  page's CSS is asserted to carry the overflow and scrollbar rules. That the
  rules behave as intended in an iOS `WKWebView` is unverified.
- **The app has never talked to the real desktop bridge.** Everything was proved
  against `scripts/mock-bridge.cjs`. The client and the mock were written from the
  same contract, so a disagreement between the contract and what the desktop
  actually serves would not have been caught here. The read-only behaviour was
  proved the same way, against `--read-only`.
- **The `WebView` has now run, on an emulator.** `LiveTerminal.tsx` renders the
  desktop's page in `react-native-webview` and streams it, so `originWhitelist`,
  `onMessage`, the `ready` handshake and `fit()` from `onLayout` are exercised —
  `onHttpError`, the absence of bounce, and tap-to-focus are not. Tap-to-focus in
  particular leans on `onTouchStart` firing on the `View` around a native
  WebView, which was not verified; the page also focuses itself on `pointerdown`,
  which is the path that was.
- **Frame protocol 2 exists only in the mock.** The desktop's half is being
  written in parallel; everything here — the events, the row encoding, the
  twelve-frame cap, the hashed vendor URLs, the gzip, the transcript paging, the
  slimmed state — was built from the written contract and proved against the
  mock's implementation of it, which this same change wrote. A disagreement
  between the contract and what the desktop ends up serving would not have been
  caught here. The measured savings are the mock's numbers on this machine, not
  a real PTY's.
- **The desktop serves neither `/terminal/:id` nor the stream yet.** Both were
  built from the written contract and proved against the mock's implementation of
  it, which this same change wrote. The page's `ready` message carrying
  `control` is this app's own reading of "send exists only when control is
  granted"; a desktop page that omits the field leaves the app on the pairing's
  `readOnly` flag instead.
- **Nothing has ever been typed into a terminal from the phone.** `POST /keys`
  has only ever reached `--control`, a flag on the mock. Against every real
  desktop build today the key bar renders disabled, and the 403 path that
  disables it was proved against the mock's 403, not a desktop's.
- The prompt chips and the "Waiting for you" inbox were driven only against the
  mock's own `needsInput`, which is a fixed demonstration menu. No desktop has
  yet reported that field, so how well a real prompt parses into a card, or how
  crowded a real inbox gets, is unknown. Until the terminal page has answered,
  the chips render enabled on a desktop that has not declared itself read-only; a
  refusal then disables them.
- **The History button cannot be hidden in advance.** Nothing in `/api/state`
  says whether a terminal has a transcript, and probing for one on open would
  cost a request for every session opened — the thing this change exists to
  stop. So the button is shown, and removed for the rest of the visit once a
  read has come back `unsupported` or `unavailable`; the sheet says so in the
  meantime. If the desktop ever carries the fact in `/api/state`, the button can
  be right the first time.
- `expo-secure-store` has never stored anything: the browser path uses
  `localStorage`, so the keychain and keystore code has been compiled but not run.
- **The subnet scan has never run.** A browser skips it by design, so the only
  discovery path exercised here is the seed list finding a desktop on
  `localhost`. `expo-network`'s `getIpAddressAsync`, the 254-address sweep, its
  concurrency and its 700 ms timeout, and the `10.0.2.2` emulator alias have been
  type-checked and unit-tested as address arithmetic only — never run against a
  real network, a real phone or an emulator.
- Pairing was proved only against the mock's own approval, never against a person
  pressing Allow on a desktop.
- **The background task has only ever been forced**, through the job scheduler.
  Nobody has watched Android choose to run it on its own fifteen-minute schedule,
  and nothing here says what Doze, a low battery or a manufacturer's own battery
  manager does to it on a real phone — Samsung's in particular is aggressive.
- **The whole iOS half of notifications is unrun.** The permission, the
  `BGTaskScheduler` wake `expo-background-task` uses there, and the fact that iOS
  is far stricter than Android about background work, have been compiled and
  never exercised. No iOS device or simulator will run this from this machine.
- No notification has been read on a lock screen, or heard: the emulator's
  screen was never locked and it has no speaker anybody listened to. The light
  haptic the foreground path gives instead of a banner has never been felt,
  for the same reason every other haptic in this app has not.
- The **release APK has only ever been installed on the emulator**, from a file
  on this machine. Nothing has gone onto a physical phone, so the "allow
  installing from unknown sources" flow the README describes is written from
  Android's documented behaviour and has not been walked.
- The APK is a **universal** one: 77.2 MB, carrying native libraries for all four
  ABIs. A phone uses one of them. No ABI split, no minification and no resource
  shrinking has been set up, because none of that is needed to sideload.
- **No iOS native build has been produced**, locally or in the cloud.
- EAS is not configured and no EAS command has been run; no account is linked.
- Nothing has been submitted to the App Store or Google Play.
- The bundle identifiers `com.linaterminal.mobile` are an assumption made while
  scaffolding, not a reserved or confirmed identifier on either store.
- The GitHub workflow has not run against this draft; `npm run typecheck`,
  `npm test` and `npm run build` were verified locally on Windows with Node 24,
  while CI pins Node 22.
- The app icon, the adaptive icon and the splash have now been seen **on an
  emulator's launcher and at a cold start**, which is the first time they have
  been anything but image files of the right size. On a real launcher — a
  different mask, a themed-icon setting, a different density — they are still
  unseen.
- The prompt chips and the "Waiting for you" inbox, and now the notifications,
  have still only ever been driven by the mock's own `needsInput`. No desktop has
  reported that field, so what a real prompt's first line reads like inside a
  notification is unknown.
- Nothing here has been reviewed for what a shared Wi-Fi network implies: the
  bridge is plain HTTP with a bearer code, and this app does not pin, encrypt or
  verify anything beyond that code.
