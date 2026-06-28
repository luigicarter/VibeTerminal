const assert = require("assert");
const fs = require("fs");
const path = require("path");

// Regression guard for the "snapped under everything" resize bug.
//
// When you resize a pane, an adjacent neighbor follows into the freed space. If
// that neighbor is tall and a third pane sits underneath the pane you're
// dragging, the follow used to sweep the neighbor across the third pane. The
// commit-time gravity pass then saw the overlap and buried the third pane below
// the neighbor's full height — a pane the user never touched snapping to the
// bottom of the board.
//
// The fix (buildAdjacentResizeLayouts in frontend/components/TiledBoard.tsx)
// clamps every neighbor-follow to the nearest blocking pane in its
// perpendicular span, so the neighbor stops at the third pane instead of
// sweeping over it. This test pins that behavior on a faithful copy of the
// geometry, and source-tripwires the real component so the clamp can't be
// dropped.

// ---------------------------------------------------------------------------
// Faithful copy of the pure geometry from TiledBoard.tsx (kept in lockstep by
// the source tripwires at the bottom).
// ---------------------------------------------------------------------------
const BOARD_GAP = 4;
const BOARD_PADDING = 10;
const DEFAULT_MIN_W = 280;
const DEFAULT_MIN_H = 170;
const ADJACENT_RESIZE_TOLERANCE = 32;
const OVERLAP_EPSILON = 0.5;

const clamp = (v, min, max) => Math.min(Math.max(v, min), max);
const percentToPx = (v, iw) => (v / 100) * iw;
const pxToPercent = (v, iw) => (iw <= 0 ? 0 : (v / iw) * 100);
const layoutToRect = (l, iw) => ({ left: percentToPx(l.x, iw), top: l.y, width: percentToPx(l.w, iw), height: l.h });
const rectToLayout = (r, iw) => ({ x: pxToPercent(r.left, iw), y: r.top, w: pxToPercent(r.width, iw), h: r.height, unit: "fluid" });
const rectRight = (r) => r.left + r.width;
const rectBottom = (r) => r.top + r.height;
const rangeOverlap = (as, ae, bs, be) => Math.max(0, Math.min(ae, be) - Math.max(as, bs));
const rangesOverlap = (as, ae, bs, be) => rangeOverlap(as, ae, bs, be) > 0;
const itemSizing = (opts, id) => opts.get(id) ?? { minW: DEFAULT_MIN_W, minH: DEFAULT_MIN_H };

function sanitizeLayout(layout, innerWidth, minW = DEFAULT_MIN_W, minH = DEFAULT_MIN_H) {
  const minWidth = Math.min(minW, innerWidth);
  const width = clamp(percentToPx(layout.w, innerWidth), minWidth, innerWidth);
  const left = clamp(percentToPx(layout.x, innerWidth), 0, Math.max(0, innerWidth - width));
  const height = Math.max(minH, layout.h);
  return rectToLayout({ left, top: Math.max(BOARD_PADDING, layout.y), width, height }, innerWidth);
}
function rectsOverlap(a, b, gap = BOARD_GAP) {
  const g = gap - OVERLAP_EPSILON;
  return a.left < b.left + b.width + g && a.left + a.width + g > b.left && a.top < b.top + b.height + g && a.top + a.height + g > b.top;
}
function horizontalOverlap(a, b, gap = BOARD_GAP) {
  const g = gap - OVERLAP_EPSILON;
  return a.left < b.left + b.width + g && a.left + a.width + g > b.left;
}
function isLayoutWithinBounds(candidate, innerWidth, minW, minH) {
  const rect = layoutToRect(candidate, innerWidth);
  return (
    rect.left >= -OVERLAP_EPSILON &&
    rect.top >= BOARD_PADDING - OVERLAP_EPSILON &&
    rect.width >= Math.min(minW, innerWidth) - OVERLAP_EPSILON &&
    rect.height >= minH - OVERLAP_EPSILON &&
    rect.left + rect.width <= innerWidth + OVERLAP_EPSILON
  );
}
function normalizeLayouts(items, innerWidth, pinnedId) {
  const sanitized = items
    .map((item) => ({ ...item, layout: sanitizeLayout(item.layout, innerWidth, item.minW ?? DEFAULT_MIN_W, item.minH ?? DEFAULT_MIN_H) }))
    .sort((a, b) => {
      if (a.id === pinnedId && b.id !== pinnedId) return -1;
      if (b.id === pinnedId && a.id !== pinnedId) return 1;
      if (a.layout.y !== b.layout.y) return a.layout.y - b.layout.y;
      if (a.layout.x !== b.layout.x) return a.layout.x - b.layout.x;
      return a.index - b.index;
    });
  const placed = [];
  const out = {};
  sanitized.forEach((item) => {
    const rect = layoutToRect(item.layout, innerWidth);
    rect.top = placed.reduce((top, p) => (horizontalOverlap(rect, p.rect) ? Math.max(top, p.rect.top + p.rect.height + BOARD_GAP) : top), BOARD_PADDING);
    placed.push({ id: item.id, rect });
    out[item.id] = rectToLayout(rect, innerWidth);
  });
  return out;
}
function isRightResizeNeighbor(s, a, n) {
  return rangesOverlap(a.top, rectBottom(a), n.top, rectBottom(n)) && n.left >= rectRight(s) - ADJACENT_RESIZE_TOLERANCE && (n.left - rectRight(s) <= ADJACENT_RESIZE_TOLERANCE || rectRight(a) + BOARD_GAP > n.left);
}
function isLeftResizeNeighbor(s, a, n) {
  return rangesOverlap(a.top, rectBottom(a), n.top, rectBottom(n)) && rectRight(n) <= s.left + ADJACENT_RESIZE_TOLERANCE && (s.left - rectRight(n) <= ADJACENT_RESIZE_TOLERANCE || a.left < rectRight(n) + BOARD_GAP);
}
function isBelowResizeNeighbor(s, a, n) {
  return rangesOverlap(a.left, rectRight(a), n.left, rectRight(n)) && n.top >= rectBottom(s) - ADJACENT_RESIZE_TOLERANCE && (n.top - rectBottom(s) <= ADJACENT_RESIZE_TOLERANCE || rectBottom(a) + BOARD_GAP > n.top);
}
function isAboveResizeNeighbor(s, a, n) {
  return rangesOverlap(a.left, rectRight(a), n.left, rectRight(n)) && rectBottom(n) <= s.top + ADJACENT_RESIZE_TOLERANCE && (s.top - rectBottom(n) <= ADJACENT_RESIZE_TOLERANCE || a.top < rectBottom(n) + BOARD_GAP);
}
function buildResizeLayout(s, axis, dx, dy, iw, minW, minH) {
  let left = s.left, top = s.top, width = s.width, height = s.height;
  if (axis.includes("e")) width = clamp(s.width + dx, Math.min(minW, iw), iw - s.left);
  if (axis.includes("w")) { const right = s.left + s.width; left = clamp(s.left + dx, 0, Math.max(0, right - minW)); width = right - left; }
  if (axis.includes("n")) { const bottom = s.top + s.height; top = clamp(s.top + dy, BOARD_PADDING, Math.max(BOARD_PADDING, bottom - minH)); height = bottom - top; }
  if (axis.includes("s")) height = Math.max(minH, s.height + dy);
  return rectToLayout({ left, top, width, height }, iw);
}
function buildAdjacentResizeLayouts(interaction, resizedLayout, innerWidth, options) {
  const axis = interaction.axis;
  const activeOption = itemSizing(options, interaction.itemId);
  const activeMinWidth = Math.min(activeOption.minW, innerWidth);
  const startRect = interaction.startRect;
  const neighborEntries = Object.entries(interaction.layoutsAtStart)
    .filter(([id]) => id !== interaction.itemId)
    .map(([id, layout]) => {
      const option = itemSizing(options, id);
      return { id, option, rect: layoutToRect(sanitizeLayout(layout, innerWidth, option.minW, option.minH), innerWidth) };
    });
  const neighborRects = new Map(neighborEntries.map(({ id, rect }) => [id, { ...rect }]));
  const activeRect = layoutToRect(sanitizeLayout(resizedLayout, innerWidth, activeOption.minW, activeOption.minH), innerWidth);
  const blockersFor = (neighborId) => neighborEntries.filter((e) => e.id !== neighborId).map((e) => e.rect);

  if (axis.includes("e")) {
    const rightNeighbors = neighborEntries.filter(({ rect }) => isRightResizeNeighbor(startRect, activeRect, rect));
    const rightLimit = rightNeighbors.reduce((limit, { rect, option }) => Math.min(limit, rectRight(rect) - Math.min(option.minW, innerWidth) - BOARD_GAP), innerWidth);
    const activeRight = Math.min(rectRight(activeRect), rightLimit);
    activeRect.width = Math.max(activeMinWidth, activeRight - activeRect.left);
    rightNeighbors.forEach(({ id, rect }) => {
      const blockedLeft = blockersFor(id).reduce((limit, b) => (rangesOverlap(rect.top, rectBottom(rect), b.top, rectBottom(b)) && b.left < rectRight(rect) ? Math.max(limit, rectRight(b) + BOARD_GAP) : limit), -Infinity);
      const nextLeft = Math.max(rectRight(activeRect) + BOARD_GAP, blockedLeft);
      const current = neighborRects.get(id);
      if (!current) return;
      current.left = nextLeft;
      current.width = rectRight(rect) - nextLeft;
    });
  }
  if (axis.includes("w")) {
    const leftNeighbors = neighborEntries.filter(({ rect }) => isLeftResizeNeighbor(startRect, activeRect, rect));
    const leftLimit = leftNeighbors.reduce((limit, { rect, option }) => Math.max(limit, rect.left + Math.min(option.minW, innerWidth) + BOARD_GAP), 0);
    const activeRight = rectRight(activeRect);
    activeRect.left = Math.min(Math.max(activeRect.left, leftLimit), activeRight - activeMinWidth);
    activeRect.width = activeRight - activeRect.left;
    leftNeighbors.forEach(({ id, rect }) => {
      const blockedRight = blockersFor(id).reduce((limit, b) => (rangesOverlap(rect.top, rectBottom(rect), b.top, rectBottom(b)) && rectRight(b) > rect.left ? Math.min(limit, b.left - BOARD_GAP) : limit), Infinity);
      const nextRight = Math.min(activeRect.left - BOARD_GAP, blockedRight);
      const current = neighborRects.get(id);
      if (!current) return;
      current.width = nextRight - rect.left;
    });
  }
  if (axis.includes("s")) {
    const belowNeighbors = neighborEntries.filter(({ rect }) => isBelowResizeNeighbor(startRect, activeRect, rect));
    const bottomLimit = belowNeighbors.reduce((limit, { rect, option }) => Math.min(limit, rectBottom(rect) - option.minH - BOARD_GAP), Infinity);
    const activeBottom = Math.min(rectBottom(activeRect), bottomLimit);
    activeRect.height = Math.max(activeOption.minH, activeBottom - activeRect.top);
    belowNeighbors.forEach(({ id, rect }) => {
      const blockedTop = blockersFor(id).reduce((limit, b) => (rangesOverlap(rect.left, rectRight(rect), b.left, rectRight(b)) && b.top < rectBottom(rect) ? Math.max(limit, rectBottom(b) + BOARD_GAP) : limit), -Infinity);
      const nextTop = Math.max(rectBottom(activeRect) + BOARD_GAP, blockedTop);
      const current = neighborRects.get(id);
      if (!current) return;
      current.top = nextTop;
      current.height = rectBottom(rect) - nextTop;
    });
  }
  if (axis.includes("n")) {
    const aboveNeighbors = neighborEntries.filter(({ rect }) => isAboveResizeNeighbor(startRect, activeRect, rect));
    const topLimit = aboveNeighbors.reduce((limit, { rect, option }) => Math.max(limit, rect.top + option.minH + BOARD_GAP), BOARD_PADDING);
    const activeBottom = rectBottom(activeRect);
    activeRect.top = Math.min(Math.max(activeRect.top, topLimit), activeBottom - activeOption.minH);
    activeRect.height = activeBottom - activeRect.top;
    aboveNeighbors.forEach(({ id, rect }) => {
      const blockedBottom = blockersFor(id).reduce((limit, b) => (rangesOverlap(rect.left, rectRight(rect), b.left, rectRight(b)) && rectBottom(b) > rect.top ? Math.min(limit, b.top - BOARD_GAP) : limit), Infinity);
      const nextBottom = Math.min(activeRect.top - BOARD_GAP, blockedBottom);
      const current = neighborRects.get(id);
      if (!current) return;
      current.height = nextBottom - rect.top;
    });
  }

  const nextLayouts = { ...interaction.layoutsAtStart, [interaction.itemId]: rectToLayout(activeRect, innerWidth) };
  neighborRects.forEach((rect, id) => {
    const option = itemSizing(options, id);
    nextLayouts[id] = sanitizeLayout(rectToLayout(rect, innerWidth), innerWidth, option.minW, option.minH);
  });
  return nextLayouts;
}

const IW = 1200;
function L(x, y, w, h) { return { x, y, w, h, unit: "fluid" }; }
function rectOf(l) { return layoutToRect(l, IW); }
function trueOverlap(a, b) {
  return a.left < b.left + b.width - 0.5 && a.left + a.width - 0.5 > b.left && a.top < b.top + b.height - 0.5 && a.top + a.height - 0.5 > b.top;
}

// Simulate one resize interaction (drag + release) through the real pipeline:
// active resize -> adjacent-neighbor follow -> commit-time gravity compaction.
function simulateResize(items, itemId, axis, dx, dy) {
  const options = new Map(items.map((it) => [it.id, { minW: it.minW ?? DEFAULT_MIN_W, minH: it.minH ?? DEFAULT_MIN_H }]));
  const prop = normalizeLayouts(items.map((it, index) => ({ id: it.id, layout: it.layout, minW: it.minW, minH: it.minH, index })), IW);
  const opt = options.get(itemId);
  const startLayout = sanitizeLayout(prop[itemId], IW, opt.minW, opt.minH);
  const layoutsAtStart = { ...prop, [itemId]: startLayout };
  const interaction = { itemId, axis, startRect: layoutToRect(startLayout, IW), layoutsAtStart };
  const candidate = buildResizeLayout(interaction.startRect, axis, dx, dy, IW, opt.minW, opt.minH);
  if (!isLayoutWithinBounds(candidate, IW, opt.minW, opt.minH)) return { blocked: true, preview: layoutsAtStart, committed: layoutsAtStart };
  const nextLayout = sanitizeLayout(candidate, IW, opt.minW, opt.minH);
  const preview = buildAdjacentResizeLayouts(interaction, nextLayout, IW, options);
  const normItems = items.map((it, index) => ({ id: it.id, layout: preview[it.id], minW: it.minW, minH: it.minH, index })).filter((it) => it.layout);
  const committed = normalizeLayouts(normItems, IW);
  return { preview, committed };
}

// --- 1. The reported case: shrink A, tall C absorbs over B (B sits under A). ---
{
  const base = [
    { id: "A", layout: L(0, 10, 40, 230), minW: 280, minH: 170 },
    { id: "C", layout: L(42, 10, 45, 300), minW: 280, minH: 170 },
    { id: "B", layout: L(0, 246, 30, 230), minW: 280, minH: 170 }
  ];
  const res = simulateResize(base, "A", "e", -250, 0);
  const bPrev = rectOf(res.preview.B);
  const bComm = rectOf(res.committed.B);
  assert.ok(
    rectBottom(bComm) - rectBottom(bPrev) < 1,
    `B (under A) must not snap downward on release; preview bottom ${rectBottom(bPrev).toFixed(0)} -> committed ${rectBottom(bComm).toFixed(0)}`
  );
  // C must stop at B's edge rather than sweeping over it (no overlap left behind).
  assert.ok(!trueOverlap(rectOf(res.committed.C), bComm), "absorbing neighbor C must not overlap B");
}

// --- 2. The direct two-pane "absorb" must still glue (the fix can't kill it). ---
{
  const base = [
    { id: "A", layout: L(0, 10, 50, 300), minW: 280, minH: 170 },
    { id: "C", layout: L(52, 10, 48, 300), minW: 280, minH: 170 }
  ];
  const res = simulateResize(base, "A", "e", -120, 0);
  const a = rectOf(res.committed.A);
  const c = rectOf(res.committed.C);
  assert.ok(
    Math.abs(c.left - (rectRight(a) + BOARD_GAP)) < 1.5,
    `a lone neighbor must still follow the shrunk edge (stay glued); A.right=${rectRight(a).toFixed(0)} C.left=${c.left.toFixed(0)}`
  );
}

// --- 3. Battery: no non-target pane may snap downward, and no committed overlaps. ---
{
  let buries = 0;
  let overlaps = 0;
  let total = 0;
  for (const cx of [42, 50, 55]) for (const cw of [45, 50, 58]) for (const ch of [300, 470])
  for (const by of [246, 300]) for (const bw of [30, 40]) {
    const base = [
      { id: "A", layout: L(0, 10, 40, 230), minW: 280, minH: 170 },
      { id: "C", layout: L(cx, 10, cw, ch), minW: 280, minH: 170 },
      { id: "B", layout: L(0, by, bw, 230), minW: 280, minH: 170 }
    ];
    for (const tgt of ["A", "B", "C"]) for (const axis of ["w", "e", "n", "s", "nw", "ne", "sw", "se"])
    for (const dx of [-400, -250, -120, 120, 250, 400]) for (const dy of [-200, -80, 80, 200]) {
      const res = simulateResize(base, tgt, axis, dx, dy);
      if (res.blocked) continue;
      total++;
      for (const v of ["A", "B", "C"]) {
        if (v === tgt) continue;
        const pv = rectOf(res.preview[v]);
        const cm = rectOf(res.committed[v]);
        if (rectBottom(cm) - rectBottom(pv) > 60) buries++;
      }
      const ids = ["A", "B", "C"];
      for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
        if (trueOverlap(rectOf(res.committed[ids[i]]), rectOf(res.committed[ids[j]]))) overlaps++;
      }
    }
  }
  assert.strictEqual(buries, 0, `no pane should bury on release across ${total} resize scenarios; found ${buries}`);
  assert.strictEqual(overlaps, 0, `committed layouts must never overlap; found ${overlaps}`);
}

// --- 4. Source tripwires: the real component must keep the blocker clamp in all
//        four follow directions, or this whole spec is testing dead behavior. ---
{
  const source = fs.readFileSync(
    path.join(__dirname, "..", "..", "frontend", "components", "TiledBoard.tsx"),
    "utf8"
  );
  assert.ok(source.includes("const blockersFor ="), "TiledBoard must define the blockersFor clamp helper");
  for (const marker of ["blockedLeft", "blockedRight", "blockedTop", "blockedBottom"]) {
    assert.ok(
      source.includes(marker),
      `TiledBoard buildAdjacentResizeLayouts must clamp every follow direction (missing ${marker})`
    );
  }
}

console.log("tiled board resize smoke passed");
