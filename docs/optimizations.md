# Optimizations

Performance findings and the outstanding optimization backlog for the renderer.

Status legend: **confirmed** = traced to specific code; **hypothesis** = plausible
from code but not yet measured with a profile; **refuted** = investigated and ruled out.

## Symptom: jank at the start of an interaction

The UI is janky only at the **start** of an interaction — the first frames of
dragging/resizing a pane, and the first keystrokes when typing — then it smooths
out and stays smooth. This is **first-frame / cold-path jank**: a one-time burst
of synchronous work on the first event of an interaction (a full React re-render
plus a forced layout), after which updates switch to RAF-batched steady state.

It is **not** a continuous-animation cost. The infinite `box-shadow` pulse
animations (`.terminal-pane-attention`, `styles.css:1081`) and the uncommitted
working-tree diff were investigated and are **not** the cause of this symptom —
they would produce continuous cost, not a start-of-interaction spike.

### Cause 1 — Drag/resize start does a cold re-render of the whole board (confirmed)

Starting a drag re-renders the entire board and every pane, because there are no
memo boundaries:

1. `handleFramePointerDown` -> `setActiveInteraction(...)` + `onArrangeChange(true)`
   (`frontend/components/TiledBoard.tsx:1408`).
2. That calls `setIsArranging(true)` in `App`, and `App` rebuilds the whole
   `items` array **inline** (`visibleSessions.map(...)`,
   `frontend/App.tsx:2527`), reconstructing every pane's `content` element.
3. `TiledBoard`, `TerminalPane`, and `FusionChatPane` are **not** wrapped in
   `React.memo` (`frontend/components/TiledBoard.tsx:1044`,
   `frontend/components/TerminalPane.tsx:95`,
   `frontend/components/FusionChatPane.tsx:735`) — so all panes re-render on that
   one event.
4. The new `items` array reference makes TiledBoard's `[items]` memos recompute
   `normalizeLayouts` — a sort + skyline-packing pass over every pane
   (`frontend/components/TiledBoard.tsx:147`).
5. CSS amplifies it: every `.pane-frame` carries **permanent**
   `will-change: transform, width, height` and transitions on `width`/`height`
   (`frontend/styles.css:871`). `width`/`height` are not compositable (they force
   layout), and permanent `will-change` keeps every pane on its own GPU layer, so
   the layout shift re-rasterizes the large `box-shadow`s
   (`frontend/styles.css:1069`, `frontend/styles.css:896`) as layers reshuffle.

Live pointer-moves are RAF-batched with transitions suppressed
(`frontend/components/TiledBoard.tsx:1419`), so it smooths out after the first
frame.

**Refuted sub-theory:** "the first move runs on the eased width/height path." The
transition-suppression classes (`pane-frame-moving`/`pane-frame-resizing`) land
on the React commit before the first handled pointer-move
(`frontend/components/TiledBoard.tsx:1483`), and live layout updates are not made
during pointer-down. The start jank is the cold commit, not 1-2 eased frames.

### Cause 2 — Fusion composer typing forces a synchronous reflow per keystroke (confirmed)

The composer is a controlled input, so every keystroke re-renders the whole chat
pane and does a forced synchronous reflow:

- `onChange` -> `setInput` (`frontend/components/FusionChatPane.tsx:2160`)
  re-renders the pane, recomputing `buildSlashMenu(input)`, `messages.filter(...)`,
  and `visibleMessages.map(...)` over the entire un-virtualized message list each
  keystroke (`frontend/components/FusionChatPane.tsx:806`, `:814`, `:1987`).
- The autosize effect on `[input]` writes `height="auto"`, reads `scrollHeight`
  (forces layout), writes height again, **and recreates a `ResizeObserver` every
  keystroke** (`frontend/components/FusionChatPane.tsx:852`). That write -> read
  -> write is the textbook typing-jank pattern, worst on the first key after idle
  when style/layout is cold.

### Cause 3 — Pane CSS layer/paint cost (confirmed ingredients, hypothesis on magnitude)

Permanent `will-change: transform, width, height` on every pane plus width/height
transitions (`frontend/styles.css:871`) is a credible compositor/layer-memory
cost that re-rasterizes large shadows on layout change. The ingredients are
confirmed in code; the exact GPU cost still needs a trace. No `backdrop-filter`
or `filter:` usages were found.

### Not a factor — Terminal typing (mostly refuted)

xterm handles input outside React (`frontend/components/TerminalPane.tsx:469`);
only the **first** key into an unselected/unread pane triggers an app render via
`onSelect`. Repeated keys into the focused pane do not, because
`clearUnreadAttention` returns the same session when nothing is unread
(`frontend/attention.ts:193`) and `updateAnySession` bails when unchanged
(`frontend/App.tsx:1129`).

### Narrow caveat — first xterm fit near interaction start (hypothesis)

`isArrangingRef` is updated in a passive `useEffect`, not during render
(`frontend/components/TerminalPane.tsx`). A `ResizeObserver` callback that fires
before that effect could see the previous value and fit once near interaction
start. Supported by code as a narrow hypothesis, not a confirmed trace.

## Recommended fixes (ranked)

1. **Add `React.memo` to `TerminalPane`/`FusionChatPane`** and stabilize the
   `items` array + `content` with `useMemo`/`useCallback`, so `setIsArranging(true)`
   does not rebuild every pane subtree. Biggest win for drag/resize. Consider
   splitting the `isArranging` flag so it does not invalidate pane children.
2. **Fix the composer autosize**: keep a single stable `ResizeObserver` instead of
   recreating it per keystroke, and batch/avoid the forced reflow (hidden mirror
   element, `field-sizing: content`, or a rows-based measure) so typing does not
   write -> read -> write layout each key.
3. **Drop `will-change: width, height`** (uncompositable) and prefer driving drag
   by `transform` only; reconsider the `width`/`height` transitions on
   `.pane-frame`.

## Continuous-cost items (separate from the start-of-interaction jank)

These do not cause the start jank but are worth revisiting for idle CPU:

- Infinite `box-shadow` pulse animations (`pane-attention-pulse`,
  `frontend/styles.css:1081`; `fusion-background-breathe`,
  `frontend/styles.css:1418`) animate non-composited `box-shadow` (blur +
  `color-mix`) and re-rasterize each frame while active. Prefer animating a cheap
  composited property (opacity of a pseudo-element with a pre-baked shadow, or a
  `transform`) and cap how many panes pulse at once.
- `getCodeChanges` polling every 7.5s (`CODE_CHANGE_REFRESH_MS`,
  `frontend/App.tsx:88`, `:1067`) spawns a git process per workspace on a fixed
  interval regardless of activity; periodic spikes that scale with workspace
  count. Consider gating on activity or backing off when idle.
