# Lina Terminal mobile app

An Expo (SDK 57) React Native app in TypeScript, targeting iOS and Android from one codebase. This app lives inside the Lina repository at apps/mobile; its siblings are ../desktop and ../website. Shared branding is owned by ../../packages/brand.

It is a companion remote for the desktop app. Projects are the top-level list; a project opens into its terminals; **a terminal opens into the terminal itself**; a pinned "Ask Lina" chat talks to the Orchestrator; Settings pairs the phone with a desktop over the local network. Engineering notes live in `../../docs/mobile-app.md`.

## The terminal on the phone

Opening a session lands in the desktop's own xterm rendering of it, not a copy of its text and not a chat about it: the desktop serves `GET /terminal/:id?code=` and the app embeds it — a `WebView` on a phone, an `<iframe>` in a browser — while the page streams the session. The earlier draft showed the agent's transcript as bubbles with the terminal behind a toggle; that was an imitation of the thing. The transcript is a summary the desktop reconstructs, it lags, and for a plain shell there is none at all. The terminal is what is actually happening, so the terminal is the screen.

The conversation is still there, behind **History** in the header: a bottom sheet, read-only, fifty messages at a time with "Load earlier" above them. It is also the only thing on the screen that costs a request, and only when you open it.

The terminal **never scrolls sideways**. Every column the desktop has is fitted into the width — the page measures the font and picks a size, however small — and zoom is how you read it: pinch between 0.6x and 3x, drag with one finger while zoomed, double-tap to go back. No scrollbars anywhere; a two-pixel mark fades in on the right edge when you are scrolled away from the newest line. `A−` and `A+` on the key bar do the same zoom without a pinch — anchored at the left edge and the bottom, so column zero stays put and the newest lines stay in sight — and they work even on a desktop that will not take input. The app is `default` orientation, because a terminal is wide and landscape is how eighty columns become legible.

Under it is the **key bar**, for the keys a phone keyboard does not have: **Esc** (first, and raised), Tab, the four arrows (hold one to repeat), Enter, a sticky **Ctrl** (arm it, then type one letter and that letter is sent as its control code), `^C`, `^D`, `^L`, `/`, **Paste**, the two zoom keys, and a one-line field that sends what you type followed by a Return. A chevron folds it to a single row when the terminal needs the height. Every key taps back with a light haptic. When the desktop says a terminal is waiting on a prompt, a card of one-tap answers appears above the bar, that terminal's row is marked **NEEDS YOU**, and it shows up in **Waiting for you** at the top of the home screen.

**None of it can send anything yet.** No desktop build serves the write route the key bar posts to, so the bar is shown disabled with a note saying so. It comes alive on its own the moment a desktop grants control. To see it working now, run the mock with `--control`.

## Getting around

One native stack, and which stack it is depends on the pairing: either **Find your desktop → Approve → Enter an address**, or **Projects → Project → Terminal**, with **Ask Lina** and **Settings** alongside. Pairing a desktop swaps one for the other, so after an approval Projects is the root with nothing behind it, and forgetting a desktop leaves Find the root the same way.

**Back** — the button or the gesture — pops exactly one screen, and nothing in the app intercepts it: Project goes to Projects, a terminal goes back to wherever you opened it from (the project, or Projects if you came from the Waiting-for-you inbox), Settings closes onto the screen that opened it, and the pairing screen abandons the request it was waiting on. A sheet that is open takes the press instead and closes. On the first screen back leaves the app, as any Android app does — inside Expo Go that is Expo Go's own home screen.

**Sheets** — History, and the two confirmations — close four ways, and they are the same four everywhere: the X, a tap outside, a downward swipe on the sheet's head, and back. Settings is a modal and behaves the same: it slides up, and its header is the handle you pull down to dismiss it.

Nothing here raises an Android alert. **Forget this desktop** and **Find another desktop** both ask the same way: a question, one line saying what actually happens, Cancel and the verb.

**The keyboard** never covers the key bar. Focusing the key bar's field takes the height out of the terminal, which re-fits itself to what is left, and gives it back when the keyboard closes. The same is true of Ask Lina's composer and the typed pairing form.

## How it is drawn

`src/theme/tokens.ts` carries the rules as values: a 16dp gutter on every screen, row, header, bar and sheet; a 44dp minimum for anything a thumb has to hit; one header height. Controls are *drawn* at the size that looks right — a 36dp icon button, a 34dp key — and `touchArea()` gives each one the `hitSlop` that brings its touch area up to 44dp.

Everything that can be pressed tints when it is. A list that is waiting for its first state shows three shimmering placeholder rows rather than the word "Loading…". Every empty state is one short line and one thing to do. When the desktop stops answering, a slim banner under the header says "Reconnecting to \<desktop\>…", or "Can't reach \<desktop\>" with a Retry, which is more than a coloured dot can say — the dot is still there. The inbox and the prompt-chips card slide in and out rather than appearing. Safe areas are owned by the header, the bars and the sheets, so the app is correct in landscape and under a gesture bar without any screen thinking about it.

## Frugal with your data

A phone on a train pays for every byte. The live terminal is **unmounted** — not hidden — when the screen loses focus or the app goes to the background, which closes the stream; `/screen` is never polled any more; the transcript is read only when History is opened; Ask Lina's history only while that screen is up. The state long poll is the one thing that always runs.

The stream itself sends only the rows that changed, at most twelve times a second, gzipped. Against the mock's `--storm` (one terminal rewriting all twenty-four rows thirty times a second) that is about **2 kB/s** where sending the whole screen every time would be about **86 kB/s** — a ratio of **42x**, which `npm test` prints and enforces.

Settings shows a **Data** line with what this session has read back, split into the state loop, the terminals and everything else. Those are decoded bytes; the desktop gzips what it sends, so less crossed the network.

## Notifications

The phone tells you about three things, and nothing else: a terminal that
**starts asking you something**, a terminal that **finishes or fails**, and the
**Orchestrator answering**. A snippet changing, a spinner turning, a terminal
going from idle to working — that is the desktop getting on with it, and it is
not worth a phone buzzing in a pocket.

Android asks for permission once, on the first launch after you pair a desktop —
before that there is nothing to be notified about. Settings has the switch,
**Notify me when a terminal needs me or finishes**, on by default once the
permission is granted, and the line under it always says what this phone will
actually do. Notifications land on their own channel, **Terminals**, so Android's
own settings can silence them without silencing the app; the small icon is the
Lina mark as a white silhouette, which is the only thing Android will draw.

**Nothing is posted while you are looking at the app** — the screen already says
it — you get a light haptic instead. Tapping a notification opens the terminal
it is about.

### What the operating system allows, honestly

- For about **a minute after you put the phone down**, the long poll keeps
  running and you are told the moment something happens. (It stops a poll or so
  past the minute rather than exactly on it: a backgrounded app's JavaScript
  timers do not fire on Android, so the loop checks the clock itself each time
  round rather than setting a timeout.)
- After that there is only a **background task**, and **fifteen minutes is the
  floor Android will schedule** — `expo-background-task` asks for fifteen and
  the system treats that as a minimum and a suggestion at once. It batches wakes
  with other apps', it skips them in Doze, it skips them on a low battery, and
  it will not run at all while the app is force-stopped or the phone is offline.
  So a terminal that starts asking something twenty minutes after you left can
  take another fifteen to reach you, and there is no way to make that shorter
  from inside an app.
- Each wake is **one request** — `/api/state?wait=0` — compared against the
  snapshot the phone stored last time and nothing else. It cannot long poll: it
  has a moment, not a connection.
- Nothing here uses push. There is no server, no Firebase project and no Expo
  push token; every notification this app posts was decided on the phone from
  something it read off your own desktop.

## Pairing with a desktop

On the desktop, open **Settings → Phone** and turn on phone connections.

On the phone there is nothing to type. The app opens on **Find your desktop**,
looks for every desktop that answers on this network, and lists what it finds.
Tap one, and a prompt naming your phone appears on that desktop; press **Allow**
there and the phone pairs itself and goes straight to your projects.

If discovery cannot see the desktop — another subnet, a browser, a tunnel — the
muted **Enter an address instead** link at the bottom opens the old form, where
the address, the port and the pairing code from that same desktop panel can be
typed by hand. It also lives in Settings under Advanced.

The pairing is stored in the device keychain (`expo-secure-store`), or in
`localStorage` when the app runs in a browser. Settings can look for another
desktop or forget this one, and if a desktop ever stops accepting the stored
code the app says so and returns to discovery.

## Local development

Requires Node.js 22+ and npm. From this folder:

```powershell
npm ci
npm run dev
```

Metro starts on port 8081 and prints a QR code. Scan it with Expo Go on a phone on the same network to load the app. `npm run android` opens the project on a connected Android device or a running Android emulator, which is the path available on Windows. `npm run ios` requires macOS with Xcode, or an EAS build installed on the device; it cannot run on this Windows machine.

Root equivalents are `npm run dev:mobile`, `npm run android:mobile`, and `npm run ios:mobile`.

### The development build

Notifications are native modules, so they do not exist inside Expo Go. Anything
past reading the UI needs a **development build** — the app compiled with its own
native code, installed as `com.linaterminal.mobile`, loading its JavaScript from
Metro:

```powershell
npm run android:dev          # expo run:android
npm run android:dev -- --device Pixel_9_Pro_XL --no-bundler
```

It needs the Android SDK, a JDK 21, and `ANDROID_HOME` pointing at the SDK; the
first build downloads Gradle and the NDK and takes several minutes, and later
ones are minutes faster. `--no-bundler` reuses a Metro already running on 8081
rather than starting a second one, and `--device` takes the **AVD name** for an
emulator (`Pixel_9_Pro_XL`), not the adb serial.

This is where it stops being an experience inside Expo Go and becomes an app: the
launcher shows the Lina mark and the name Lina Terminal, the splash is the dark
Lina one, and back on the first screen goes to the launcher rather than to Expo
Go's own home screen.

`expo run:android` generates `android/` from `app.json`. That folder is
**gitignored and stays that way** — this project is managed, the native project
is an output, and anything that has to survive a clean checkout belongs in
`app.json` or in a config plugin. It also rewrites the `ios` and `android` npm
scripts to `expo run:*` when it creates the folder; the scripts here are the
Metro ones, and `android:dev` is the native build.

An emulator reaches Metro and a desktop bridge on the host through
`adb reverse tcp:8081 tcp:8081` and `adb reverse tcp:47832 tcp:47832`, which are
lost on every reboot.

### Developing without the desktop

`npm run mock` starts a Node HTTP stand-in for the desktop's HTTP bridge with demonstration data — three projects, seven terminals across the agent kinds, transcripts and screen text for each, an Orchestrator history, working long polling, and a terminal whose status changes every eight seconds so live updates are visible:

```powershell
npm run mock
# MOCK http://127.0.0.1:47832 code MOCK-MOCK-MOCK-MOCK
```

It listens on **47832**, one port above the real bridge, so both can run at the same time — and discovery looks at both ports, so the app finds it without being told.

It also answers discovery and pairing. A pairing request is approved two seconds later, as if somebody pressed Allow on the desktop. `--pair=deny` refuses instead, `--pair=manual` leaves requests pending and prints `PAIR <requestId>` so you can answer one yourself with `curl -X POST http://127.0.0.1:47832/__mock/approve/<requestId>`, and `--pair-expiry=<ms>` shortens the timeout. `--read-only` imitates a desktop that serves the bridge for reading only, and `--port`, `--host` and `--code` override the defaults.

It serves the live terminal as well, and it implements frame protocol 2 rather than imitating it: a real screen model per session, `hello` / `scrollback` / one full `screen` on attach, then `frame`s carrying only the rows that moved, capped at twelve a second and gzipped. `/terminal/:id?code=` is a real xterm page; the mock serves mobile-owned `@xterm/xterm` and `@xterm/addon-fit` development dependencies under their content hash with an immutable cache header. Run `npm ci` in this app to install them. `--xterm-dir <folder>` remains an explicit override; a desktop installation is not required.

```powershell
npm run mock -- --storm
# MOCK http://127.0.0.1:47832 code MOCK-MOCK-MOCK-MOCK view-only storm:s-fusion
```

`--storm` makes one terminal rewrite every row thirty times a second, which is what the frame budget exists for. `npm test` attaches to it and prints the bytes actually sent against the bytes a full-screen-per-change protocol would have sent.

```powershell
npm run mock -- --control
# MOCK http://127.0.0.1:47832 code MOCK-MOCK-MOCK-MOCK control
```

`--control` is the only way to use the key bar today: it serves the `keys` route the phone posts to and echoes the bytes into the screen and the stream. Without it the page is view-only and that route answers 403 `control not allowed`, which is what every real desktop build does now.

To drive the app against it in a browser, run `npm run web` in a second terminal and open `http://localhost:8081`: the Find your desktop screen discovers the mock on `localhost` by itself, and tapping it pairs two seconds later. The typed fallback still works with `localhost`, `47832`, `MOCK-MOCK-MOCK-MOCK`. Set the browser to a phone-sized viewport (390x844 is what the screens are designed against).

## Screenshots without a device

```powershell
npm run capture
```

`scripts/capture-web.cjs` exports the app for web, serves it locally, starts its own mock bridge on a bridge port, and walks the whole UX inside a 390x844 Electron window borrowed from `../desktop/node_modules` — discovery, the approval screen, Projects with its Waiting-for-you inbox, a project, the live terminal, the History sheet, the terminal zoomed and panned, the key bar, Ask Lina, Settings. Each screen is written to `.tmp/screens` and printed as a `CAPTURED <file>` line; any step that stalls for more than 20 seconds fails the run. `04c-zoomed.png` is taken after three presses of `A+` — which is `zoom(+0.6)` — and a drag off the left edge.

Every shot throws its first frame away and keeps the second. The embedded terminal is an out-of-process frame and this window has no GPU, so a terminal that is parked and producing nothing can be missing from the first snapshot taken of it even though its DOM is correct; asking for a frame is what composites it. A phone never needs that — the compositor is awake and the stream keeps painting.

The walk ends on Settings, which is a modal (`07-settings.png`), and on the app's one confirmation sheet open over it (`08-settings-modal.png`) — which it then cancels, because it has to survive its own screenshot. `npm run capture -- --control` runs the same walk against a mock that grants control, so `05-keys.png` shows the key bar live with Ctrl armed instead of disabled. `npm run capture -- --host 192.168.1.20 --port 47831 --code XXXX-XXXX-XXXX-XXXX` points it at a real desktop instead, walking the typed fallback rather than discovery, and `-- --read-only` captures the read-only state.

It needs `apps/desktop` to have its dependencies installed: that is where Electron comes from, and where the mock's xterm comes from. Nothing is installed into this app for either.

A mock left running from an earlier session takes one of the two bridge ports, so the capture's own mock ends up on the other one. That is fine — the capture's mock carries a unique desktop id and the walk pairs with that row specifically — but the stray one is still worth stopping.

## The release APK

```powershell
npm run android:release
```

One signed APK you can put on your own phone, built locally, with no EAS account
and no store involved. `scripts/build-android-release.cjs` does the whole thing
from `app.json` every time:

1. synchronizes the brand assets and regenerates the notification icon;
2. `expo prebuild --platform android --clean`, so the native project is written
   fresh rather than carried over;
3. patches the one thing a generated project gets wrong for a real release —
   Expo's template signs `release` with the **debug** key, which is right for a
   template and wrong for a phone — replacing it with a signing config fed from
   Gradle properties;
4. `gradlew assembleRelease`;
5. copies the result to `.tmp/dist/LinaTerminal-<version>-android.apk` and prints
   its size and SHA-256.

Then it **checks the signature** rather than assuming it: the finished APK's
signer certificate has to be the one in the keystore, or the build fails. That
matters because the patched config falls back to the debug key when the
properties are missing — it has to, or `expo run:android` would stop working on a
patched project — and a debug-signed "release" is exactly the mistake worth
catching.

The key lives in `.tmp/keys` (`lina-release.keystore`, alias `lina-release`),
which is gitignored twice over: `.tmp/` is ignored and so is `*.keystore`.
`.tmp/keys/README.txt` records the alias, the algorithm, the password and the
`keytool` command that made it. The password is read from `.tmp/keys/.password`
or `LINA_ANDROID_KEYSTORE_PASSWORD` and passed to Gradle as a `-P` property, so
it is never written into `gradle.properties` and never printed into a log.

**Back the keystore up somewhere that is not this machine.** It is the app's
identity: Android refuses an update signed by a different key, so losing it means
every phone with the app installed has to uninstall before it can install again.

`--no-prebuild` reuses the existing `android/` folder, which is faster and is the
only reason to skip step 2.

### Putting it on a phone

1. Copy the APK from `.tmp/dist` to the phone (cable, Drive, whatever you use).
2. Open it. Android will say the app came from an unknown source; allow it for
   whatever app is doing the installing — Files, or Chrome — in **Settings →
   Apps → Special app access → Install unknown apps**. This is a one-off.
3. Put the phone on **the same Wi-Fi as the desktop**.
4. On the desktop, **Settings → Phone**, turn on phone connections.
5. Open Lina Terminal. It looks for desktops by itself; tap yours, press
   **Allow** on the desktop, and it pairs. There is no code to type.
6. Allow notifications when it asks, or turn them on later in Settings.

An APK signed with this key cannot be installed over one signed with another —
including the development build, which carries Android's debug key — and the same
is true the other way round, so switching a device between the two means
`adb uninstall com.linaterminal.mobile` first. That is what
`INSTALL_FAILED_UPDATE_INCOMPATIBLE` means when the installer refuses.

## Store builds

Store binaries would come from EAS Build in Expo's cloud, which is also the only
way an iOS build is possible from Windows:

```powershell
npx eas-cli build --platform android
npx eas-cli build --platform ios
```

Android artifacts go to the Play Console internal track; iOS artifacts go to TestFlight. Neither has been done: no EAS project is configured, no `eas.json` exists, no account is linked, and no store build or submission has been run. The APK above is for sideloading onto your own phone, not for a store: a store build wants an `.aab`, a versionCode policy and a confirmed application id.

`npm run build` is not a native build either. It runs `expo export`, which bundles the JavaScript and assets for both platforms into `dist/`. That is what CI checks; it needs no Xcode and no Android SDK.

## Configuration

`app.json` holds the Expo config: name `Lina Terminal`, slug `lina-terminal`, URL scheme `lina`, `default` orientation (a terminal is wide — landscape matters here), automatic light/dark interface style, and the new React Native architecture. Icons and the splash image come from `assets/brand`, which `scripts/sync-brand.cjs` fills from `packages/brand`; do not edit those files by hand. The Android adaptive-icon and splash background use `#111216`, the darker stop of the brand mark's surface gradient.

`assets/notification-icon.png` is the exception to "do not edit by hand", because it is not edited by hand either: `scripts/make-notification-icon.cjs` rasterizes it from `packages/brand/lina-symbol.svg`, whose two paths are rectilinear and so are three axis-aligned rectangles that can be drawn exactly with no image library and no dependency. Android keeps a small icon's alpha and throws its colours away, so it has to be white on transparent — the brand PNG would arrive as a grey block.

Four config plugins beyond the splash: `expo-secure-store`, `expo-build-properties` with `android.usesCleartextTraffic` (the desktop bridge is plain HTTP on a LAN, and Android has refused cleartext by default since API 28, so without this a release build reaches no desktop at all), `expo-notifications` with that icon, the `#FFC466` accent and the `terminals` default channel, and `expo-background-task`. `expo-system-ui` is installed because `userInterfaceStyle: automatic` needs it; the prebuild says so if it is missing.

The bundle identifiers `com.linaterminal.mobile` (iOS `bundleIdentifier` and Android `package`) are an assumption made when scaffolding this app. Confirm or change them before the first store build; changing them afterwards means a new app record on both stores.

The `prebuild` script in package.json is npm's lifecycle hook: npm runs it automatically before `npm run build`, and it only regenerates assets — the brand copies and the notification icon. It is unrelated to `npx expo prebuild`, which generates the native `ios/` and `android/` folders. Those folders are **generated output, and both stay gitignored**: `npm run android:dev` and `npm run android:release` write `android/` from `app.json` whenever they need it, and `android:release` deletes and rewrites it every time. The project stays managed — nothing that has to survive a clean checkout may live in a native folder, only in `app.json` or a config plugin.

## Source layout

```
src/api/      the bridge contract, the fetch client, the key bytes, the read-only mapping
src/state/    discovery, pairing storage, the long-poll bridge context, selectors, prompts, notifications
src/theme/    the desktop's palette, agent labels and status colours
src/components/  rows, bubbles, pills, dots, the live terminal, the key bar, the History sheet
src/screens/  FindDesktop, Approve, ManualPair, Projects, Project, Chat, Lina, Settings
src/navigation/  the stack's parameter list, and the ref a notification tap navigates through
```

Notifications are four files and they are split by what they can be tested
against. `state/notifications.js` is the rule — two snapshots in, notifications
out, no native module, no clock, nothing to mock — and it is what `npm test`
exercises. `state/notificationStore.ts` is the memory it compares against, one
persisted snapshot, serialized so the long poll and the background wake cannot
both notify for one event. `state/notifyPoll.ts` is one pass of the background
check, with the poster passed in so the module stays free of native imports.
`state/notifier.ts` is the only file that touches `expo-notifications`,
`expo-task-manager` and `expo-background-task`, and `notifier.web.ts` is the same
surface as nothing at all, so the browser build never loads any of it.

`ChatScreen.tsx` is the terminal screen; the name is the route's.

`LiveTerminal.tsx` and `LiveTerminal.web.tsx` are the two shells for the same embedded page — Metro picks by platform — and they share one state machine in `liveTerminalState.ts`. The pure modules that both the app and `node --test` use are plain CommonJS: `api/keys.js`, `api/readOnly.js`, `state/needsInput.js`, `state/presence.js`, `state/candidates.js`, `state/notifications.js`.

One long-poll loop in `src/state/bridge.tsx` owns the connection; screens read its snapshot instead of polling `/api/state` themselves. Only Ask Lina polls on a timer, and only while focused. That loop is also where notifications are decided, which is why the small history read behind the "Ask Lina" snippet lives there now too: "Lina replied" wants the same line, and neither should pay for it twice.

## Validation

```powershell
npm run typecheck
npm test
npm run build
npm run capture
```

`npm run typecheck` runs `tsc --noEmit`. `npm test` runs every `scripts/*.test.cjs` on the Node test runner, with no test framework added: `config.test.cjs` checks the app identity, the brand assets, that the native packages the terminal page, the key bar and the notifications need are installed, that the notification icon is a 96x96 white-on-transparent silhouette, that cleartext HTTP is allowed for the LAN bridge, and that the release build has a script that can reproduce it; `notifications.test.cjs` exercises the notification rule as pure data — that the first sight of a desktop is a baseline rather than news, that a terminal which starts asking notifies with the first line of its prompt, that one which stops working finishes or fails, that the Orchestrator answering is one notification, that an unchanged state notifies nothing however often it is polled, that a terminal which keeps asking does not ask twice and one whose prompt comes back is news again, that a wall of changes collapses into a countable number, and that a snapshot stored and read back is the same baseline; `mock-bridge.test.cjs` boots the mock bridge on an ephemeral port and checks the whole contract — discovery, the pairing handshake with its approval, denial, expiry and 429, pairing codes, the state shape and what it leaves out, a long poll that parks and wakes, gzip round-tripping, transcript paging, input, interrupt, the Orchestrator request lifecycle, CORS, read-only mode, the keys route in all three of its states — and frame protocol 2 in particular: that unchanged rows never ship, that frames stay inside twelve a second, that a resize repaints in full, that the xterm assets are content-addressed and immutably cached, that the page's CSS forbids horizontal scrolling and draws no scrollbar, and that the page's own sizing and panning functions (which it runs verbatim) can never draw wider than the viewport. Storm mode is measured rather than asserted at: the run prints the bytes per second sent against a naive full-screen protocol's and fails under 5x. The asset tests run in CI against the mobile app's own xterm installation. `npm run build` exports the iOS and Android JavaScript bundles into `dist/`. The first three run in the `Mobile checks` GitHub workflow; `npm run capture` is local only, because CI has no Electron. Root equivalents are `npm run typecheck:mobile`, `npm run test:mobile`, and `npm run build:mobile`.

### On a device

The navigation and polish work was checked on an **Android emulator** (Pixel 9 Pro XL, Android 17) in Expo Go, against `npm run mock -- --control`, driven over `adb`; the screenshots are in `.tmp/emulator`, which is gitignored. What was seen there: back popping one screen at a time out of the terminal and out of the app; Settings opening as a modal and closing onto whatever opened it; the confirmation sheet, and back cancelling it; the soft keyboard with the whole key bar and the chips above it; landscape, with the terminal re-fitted to eighty legible columns; the loading skeletons, the empty state, and both connection banners.

The **development build and the notifications** were checked on the same emulator, against the same mock, and that is where the app stopped being an experience inside Expo Go: `com.linaterminal.mobile` installs, the launcher shows the Lina mark and the name, the splash is the dark Lina one, discovery finds the mock through `adb reverse`, pairing goes straight to Projects, Android asks for POST_NOTIFICATIONS immediately afterwards, and back on the root screen resumes the launcher with the process still alive. Then: a `terminals` channel at importance HIGH with the monochrome icon; a prompt appearing on a backgrounded phone posting "Checkout flow needs you" with the prompt's first line; the same change while the app is in front posting nothing at all; tapping the notification opening that terminal; and the background task, forced through `adb shell cmd jobscheduler run -f com.linaterminal.mobile <job>`, posting from a wake with the foreground loop long since stopped.

The release APK was installed from `.tmp/dist` with `adb install -r` and opened with Metro still running but never asked for a bundle.

Three things about driving an emulator are worth knowing if you pick this up. `adb shell uiautomator dump` is much cheaper than reading screenshots — it prints every `testID` — but it refuses to dump a window that never goes idle (a spinner, a shimmer, the live terminal) and leaves the *previous* dump in place, so delete the file first. Synthetic taps arrive late, so wait on a condition rather than on a sleep. And `expo run:android --device` wants the **AVD name**, not the adb serial: `emulator-5554` is answered with "Could not find device with name".

The one that cost the most: **a backgrounded Android app's JavaScript timers do not fire.** The minute of grace after backgrounding was first written as a `setTimeout`, which meant the long poll kept running indefinitely in the background — it was still notifying eighty seconds after the phone was put down. The loop checks `Date.now()` itself each time round instead.

### What has not been checked

No real phone, and no iOS anything. Every gesture made with a finger — pinch, the two-finger scroll, the one-finger pan, the double tap, hold-to-repeat, and the two swipes that dismiss a sheet and the Settings modal — is still unexercised: `adb` can synthesize a tap but not a drag. The haptics cannot be tested here at all: `expo-haptics` is skipped on web, so every key's tap has been compiled and never felt, and no clipboard has ever been read. And frame protocol 2 exists only in the mock so far; the desktop's half is being written in parallel.

Notifications specifically: the background task has only ever been **forced**, through the job scheduler. Nobody has watched Android choose to run it on its own fifteen-minute schedule, and nothing here says what Doze, a low battery or a manufacturer's own battery manager does to it on a real phone. The iOS half — the permission, the `BGTaskScheduler` wake that `expo-background-task` uses there, and the fact that iOS is far stricter than Android about all of it — has been compiled and never run. And no notification has been read on a lock screen, or heard.
