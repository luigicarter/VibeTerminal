const assert = require("assert");
const fs = require("fs");
const Module = require("module");
const path = require("path");
const ts = require("typescript");

// Regression guard for tiled-board resize and drop geometry.
//
// This smoke transpiles and executes the real production geometry module in
// memory, so every fixture below exercises the same functions TiledBoard uses.
const geometryPath = path.join(
  __dirname,
  "..",
  "..",
  "frontend",
  "components",
  "tiledBoardGeometry.ts"
);
const tiledBoardPath = path.join(
  __dirname,
  "..",
  "..",
  "frontend",
  "components",
  "TiledBoard.tsx"
);
const geometrySource = fs.readFileSync(geometryPath, "utf8");
const compiledGeometry = ts.transpileModule(geometrySource, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022
  },
  fileName: geometryPath
}).outputText;
const geometryModule = new Module(geometryPath, module);
geometryModule.filename = geometryPath;
geometryModule.paths = Module._nodeModulePaths(path.dirname(geometryPath));
geometryModule._compile(compiledGeometry, geometryPath);

const {
  BOARD_GAP,
  BOARD_PADDING,
  DEFAULT_MIN_H,
  DEFAULT_MIN_W,
  OVERLAP_EPSILON,
  buildAdjacentResizeLayouts,
  buildMoveDropRect,
  buildResizeLayout,
  changedLayoutEntries,
  committedLayoutsOverlap,
  findSwapTargetId,
  isLayoutWithinBounds,
  layoutToRect,
  normalizeLayouts,
  pxToPercent,
  rectBottom,
  rectRight,
  rectToLayout,
  resolveDropLayout,
  sanitizeLayout,
  settleLayouts
} = geometryModule.exports;

const IW = 1200;
function L(x, y, w, h) { return { x, y, w, h, unit: "fluid" }; }
function LP(left, top, width, height) { return rectToLayout({ left, top, width, height }, IW); }
function rectOf(l) { return layoutToRect(l, IW); }
function normalizedRect(items, id) {
  const layouts = normalizeLayouts(items.map((it, index) => ({ id: it.id, layout: it.layout, minW: it.minW, minH: it.minH, index })), IW);
  return rectOf(layouts[id]);
}
function trueOverlap(a, b) {
  return a.left < b.left + b.width - 0.5 && a.left + a.width - 0.5 > b.left && a.top < b.top + b.height - 0.5 && a.top + a.height - 0.5 > b.top;
}
function assertNoOverlaps(layouts, label) {
  const ids = Object.keys(layouts);
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    assert.ok(!trueOverlap(rectOf(layouts[ids[i]]), rectOf(layouts[ids[j]])), `${label}: ${ids[i]} must not overlap ${ids[j]}`);
  }
}

// Simulate one resize interaction (drag + release) through the real pipeline:
// active resize -> directional neighbor push -> conditional commit compaction.
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
  const committed = committedLayoutsOverlap(preview, IW)
    ? normalizeLayouts(items.map((it, index) => ({ id: it.id, layout: preview[it.id], minW: it.minW, minH: it.minH, index })).filter((it) => it.layout), IW)
    : preview;
  return { preview, committed };
}

// --- 1. The reported case: shrink A away from tall C (B sits under A). ---
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
  const cPrev = rectOf(res.preview.C);
  const cComm = rectOf(res.committed.C);
  assert.ok(
    Math.abs(cComm.left - cPrev.left) < 1,
    `C must stay fixed while A shrinks away; preview left ${cPrev.left.toFixed(0)} -> committed ${cComm.left.toFixed(0)}`
  );
  assert.ok(!trueOverlap(cComm, bComm), "fixed neighbor C must not overlap B");
}

// --- 2. Direct two-pane resize: drag away detaches; drag toward still split-resizes. ---
{
  const gapPercent = pxToPercent(BOARD_GAP, IW);
  const cases = [
    {
      name: "east",
      axis: "e",
      base: [
        { id: "A", layout: L(0, 10, 50, 300), minW: 280, minH: 170 },
        { id: "C", layout: L(50 + gapPercent, 10, 50 - gapPercent, 300), minW: 280, minH: 170 }
      ],
      detach: { dx: -120, dy: 0 },
      push: { dx: 120, dy: 0 },
      gap: (a, c) => c.left - rectRight(a),
      fixedAnchor: (c) => c.left,
      pushed: (detachedC, pushedC) => pushedC.left > detachedC.left
    },
    {
      name: "west",
      axis: "w",
      base: [
        { id: "C", layout: L(0, 10, 50 - gapPercent, 300), minW: 280, minH: 170 },
        { id: "A", layout: L(50, 10, 50, 300), minW: 280, minH: 170 }
      ],
      detach: { dx: 120, dy: 0 },
      push: { dx: -120, dy: 0 },
      gap: (a, c) => a.left - rectRight(c),
      fixedAnchor: (c) => c.left,
      pushed: (detachedC, pushedC) => rectRight(pushedC) < rectRight(detachedC)
    },
    {
      name: "south",
      axis: "s",
      base: [
        { id: "A", layout: L(0, 10, 50, 300), minW: 280, minH: 170 },
        { id: "C", layout: L(0, 314, 50, 300), minW: 280, minH: 170 }
      ],
      detach: { dx: 0, dy: -120 },
      push: { dx: 0, dy: 120 },
      gap: (a, c) => c.top - rectBottom(a),
      fixedAnchor: (c) => c.top,
      pushed: (detachedC, pushedC) => pushedC.top > detachedC.top
    },
    {
      name: "north",
      axis: "n",
      base: [
        { id: "C", layout: L(0, 10, 50, 300), minW: 280, minH: 170 },
        { id: "A", layout: L(0, 314, 50, 300), minW: 280, minH: 170 }
      ],
      detach: { dx: 0, dy: 120 },
      push: { dx: 0, dy: -120 },
      gap: (a, c) => a.top - rectBottom(c),
      fixedAnchor: (c) => c.top,
      pushed: (detachedC, pushedC) => rectBottom(pushedC) < rectBottom(detachedC)
    }
  ];

  for (const test of cases) {
    const startNeighbor = normalizedRect(test.base, "C");
    const detached = simulateResize(test.base, "A", test.axis, test.detach.dx, test.detach.dy);
    const detachedA = rectOf(detached.committed.A);
    const detachedC = rectOf(detached.committed.C);
    assert.ok(
      test.gap(detachedA, detachedC) > BOARD_GAP + 80,
      `${test.name}: shrinking away from a touching neighbor must create a gap`
    );
    assert.ok(
      Math.abs(test.fixedAnchor(detachedC) - test.fixedAnchor(startNeighbor)) < 1.5,
      `${test.name}: detached neighbor should keep its far anchor`
    );

    const pushed = simulateResize(test.base, "A", test.axis, test.push.dx, test.push.dy);
    const pushedA = rectOf(pushed.committed.A);
    const pushedC = rectOf(pushed.committed.C);
    assert.ok(
      Math.abs(test.gap(pushedA, pushedC) - BOARD_GAP) < 1.5,
      `${test.name}: growing toward a touching neighbor must still split-resize`
    );
    assert.ok(
      test.pushed(detachedC, pushedC),
      `${test.name}: the pushed neighbor should shrink only when the active edge grows into it`
    );
  }
}

// --- 3. Multi-neighbor grow: only the nearest neighbor should absorb the push. ---
{
  const cases = [
    {
      name: "east",
      axis: "e",
      drag: { dx: 700, dy: 0 },
      base: [
        { id: "A", layout: LP(0, 10, 360, 300), minW: 280, minH: 170 },
        { id: "C", layout: LP(364, 10, 300, 300), minW: 280, minH: 170 },
        { id: "D", layout: LP(668, 10, 300, 300), minW: 280, minH: 170 }
      ],
      gap: (a, c) => c.left - rectRight(a)
    },
    {
      name: "west",
      axis: "w",
      drag: { dx: -700, dy: 0 },
      base: [
        { id: "D", layout: LP(232, 10, 300, 300), minW: 280, minH: 170 },
        { id: "C", layout: LP(536, 10, 300, 300), minW: 280, minH: 170 },
        { id: "A", layout: LP(840, 10, 360, 300), minW: 280, minH: 170 }
      ],
      gap: (a, c) => a.left - rectRight(c)
    },
    {
      name: "south",
      axis: "s",
      drag: { dx: 0, dy: 700 },
      base: [
        { id: "A", layout: LP(0, 10, 360, 300), minW: 280, minH: 170 },
        { id: "C", layout: LP(0, 314, 360, 300), minW: 280, minH: 170 },
        { id: "D", layout: LP(0, 618, 360, 300), minW: 280, minH: 170 }
      ],
      gap: (a, c) => c.top - rectBottom(a)
    },
    {
      name: "north",
      axis: "n",
      drag: { dx: 0, dy: -700 },
      base: [
        { id: "D", layout: LP(0, 10, 360, 300), minW: 280, minH: 170 },
        { id: "C", layout: LP(0, 314, 360, 300), minW: 280, minH: 170 },
        { id: "A", layout: LP(0, 618, 360, 300), minW: 280, minH: 170 }
      ],
      gap: (a, c) => a.top - rectBottom(c)
    }
  ];

  for (const test of cases) {
    const startD = normalizedRect(test.base, "D");
    const res = simulateResize(test.base, "A", test.axis, test.drag.dx, test.drag.dy);
    const a = rectOf(res.committed.A);
    const c = rectOf(res.committed.C);
    const d = rectOf(res.committed.D);
    assert.ok(
      Math.abs(test.gap(a, c) - BOARD_GAP) < 1.5,
      `${test.name}: nearest neighbor C should absorb the push`
    );
    assert.ok(
      Math.abs(d.left - startD.left) + Math.abs(d.top - startD.top) < 1.5,
      `${test.name}: farther neighbor D should stay fixed after active edge is clamped`
    );
    assertNoOverlaps(res.committed, `${test.name} multi-neighbor grow`);
  }
}

// --- 4. Battery: no non-target pane may snap downward, and no committed overlaps. ---
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

// --- 5. Narrow boards clamp panes to the available width. ---
{
  const innerWidth = 200;
  const sanitized = sanitizeLayout(
    { x: 75, y: 0, w: 20, h: 100, unit: "fluid" },
    innerWidth,
    280,
    170
  );
  const rect = layoutToRect(sanitized, innerWidth);

  assert.strictEqual(rect.left, 0, "narrow sanitize should clamp x to zero");
  assert.strictEqual(rect.width, innerWidth, "narrow sanitize should use the full board width");
  assert.strictEqual(rect.top, BOARD_PADDING, "narrow sanitize should retain board padding");
  assert.strictEqual(rect.height, 170, "narrow sanitize should retain the pane minimum height");
}

// --- 6. Adjacent resize honors a heterogeneous neighbor minimum. ---
{
  const base = [
    { id: "A", layout: LP(0, 10, 360, 300), minW: 280, minH: 170 },
    { id: "C", layout: LP(364, 10, 500, 300), minW: 420, minH: 170 }
  ];
  const res = simulateResize(base, "A", "e", 500, 0);
  const active = rectOf(res.committed.A);
  const neighbor = rectOf(res.committed.C);

  assert.ok(Math.abs(neighbor.width - 420) < 0.001, "east neighbor must stop at its own 420px minimum");
  assert.ok(Math.abs(rectRight(neighbor) - 864) < 0.001, "east neighbor must keep its far edge anchored");
  assert.ok(Math.abs(neighbor.left - rectRight(active) - BOARD_GAP) < 0.001, "heterogeneous resize must retain the board gap");
}

// --- 7. Exact BOARD_GAP survives percent round-trips without stacking. ---
{
  const left = rectToLayout({ left: 0, top: 10, width: 400, height: 200 }, IW);
  const right = rectToLayout({ left: 404, top: 10, width: 400, height: 200 }, IW);
  const roundTripped = {
    A: rectToLayout(layoutToRect(left, IW), IW),
    B: rectToLayout(layoutToRect(right, IW), IW)
  };

  assert.strictEqual(
    committedLayoutsOverlap(roundTripped, IW),
    false,
    "an exact BOARD_GAP must not report as overlapping after a round-trip"
  );
  const normalized = normalizeLayouts([
    { id: "A", layout: roundTripped.A, minW: 280, minH: 170, index: 0 },
    { id: "B", layout: roundTripped.B, minW: 280, minH: 170, index: 1 }
  ], IW);
  assert.ok(
    Math.abs(rectOf(normalized.B).top - 10) <= OVERLAP_EPSILON,
    "gravity must not stack an exact-gap neighbor"
  );
}

// --- 8. Collision repair preserves unrelated, valid manual positions. ---
{
  // A pushes B down; C's existing position remains valid and must not move.
  const normalized = normalizeLayouts([
    { id: "A", layout: LP(0, 10, 400, 300), minW: 280, minH: 170, index: 0 },
    { id: "B", layout: LP(300, 10, 400, 170), minW: 280, minH: 170, index: 1 },
    { id: "C", layout: LP(600, 500, 400, 170), minW: 280, minH: 170, index: 2 }
  ], IW);
  const b = rectOf(normalized.B);
  const c = rectOf(normalized.C);

  assert.ok(Math.abs(b.top - 314) < 0.001, "B should land below A");
  assert.ok(Math.abs(c.top - 500) < 0.001, "C should retain its valid manually positioned location");

  const colliding = normalizeLayouts([
    { id: "A", layout: LP(0, 10, 400, 300), minW: 280, minH: 170, index: 0 },
    { id: "B", layout: LP(300, 10, 400, 170), minW: 280, minH: 170, index: 1 },
    { id: "C", layout: LP(600, 330, 400, 170), minW: 280, minH: 170, index: 2 }
  ], IW);
  assert.ok(Math.abs(rectOf(colliding.C).top - BOARD_PADDING) < 0.001, "a colliding C should use the higher free hole");
}

// --- 9. A colliding drop with no visible fit grows below the lowest pane. ---
{
  const desired = LP(0, 10, IW, 200);
  const fixed = LP(0, 10, IW, 300);
  const layoutsAtStart = { A: desired, B: fixed };
  const options = new Map([
    ["A", { minW: 280, minH: 170 }],
    ["B", { minW: 280, minH: 170 }]
  ]);
  const resolved = resolveDropLayout(
    "A",
    desired,
    layoutsAtStart,
    IW,
    300,
    options
  );
  const resolvedRect = rectOf(resolved);
  const fixedRect = rectOf(fixed);

  assert.ok(
    Math.abs(resolvedRect.top - (rectBottom(fixedRect) + BOARD_GAP)) < 0.001,
    "no-visible-fit fallback should place the drop below the lowest pane"
  );
  assert.ok(Number.isFinite(resolvedRect.left) && Number.isFinite(resolvedRect.top), "fallback coordinates must stay finite");
}

// --- 10. Sparse layout diffs include only exact per-entry changes. ---
{
  const base = {
    A: L(0, 10, 40, 230),
    B: L(50, 300, 40, 230)
  };

  assert.deepStrictEqual(
    changedLayoutEntries(base, { ...base }),
    {},
    "identical layout records should produce an empty sparse commit"
  );

  const movedB = L(50, 480, 40, 230);
  assert.deepStrictEqual(
    changedLayoutEntries(base, { ...base, B: movedB }),
    { B: movedB },
    "only the moved pane should be included"
  );

  const addedC = L(5, 720, 30, 200);
  assert.deepStrictEqual(
    changedLayoutEntries(base, { ...base, C: addedC }),
    { C: addedC },
    "an entry absent from before should be included"
  );

  const exactFloat = 100 / 3;
  const floatLayout = L(exactFloat, 10, exactFloat, 230);
  assert.deepStrictEqual(
    changedLayoutEntries({ A: floatLayout }, { A: { ...floatLayout } }),
    {},
    "bit-identical floating-point values should be excluded"
  );
}

// --- 11. Non-colliding free-form layouts retain deliberate vertical gaps. ---
{
  const items = [
    { id: "A", layout: LP(0, 10, 400, 220), minW: 280, minH: 170, index: 0 },
    { id: "B", layout: LP(0, 620, 400, 220), minW: 280, minH: 170, index: 1 }
  ];
  const expected = Object.fromEntries(
    items.map((item) => [
      item.id,
      sanitizeLayout(item.layout, IW, item.minW, item.minH)
    ])
  );
  const settled = settleLayouts(items, IW);

  assert.deepStrictEqual(settled, expected, "non-overlapping layouts should only be sanitized");
  assert.ok(
    Math.abs(rectOf(settled.B).top - 620) < 0.001,
    "the pane below a deliberate vertical gap must not be pulled upward"
  );
}

// --- 12. Colliding prop layouts still use the existing gravity pass. ---
{
  const items = [
    { id: "A", layout: LP(0, 10, 500, 260), minW: 280, minH: 170, index: 0 },
    { id: "B", layout: LP(300, 100, 500, 220), minW: 280, minH: 170, index: 1 }
  ];

  assert.deepStrictEqual(
    settleLayouts(items, IW),
    normalizeLayouts(items, IW),
    "overlapping layouts should settle through normalizeLayouts"
  );
}

// --- 13. Narrow-board projections stack panes after min-width sanitization. ---
{
  const innerWidth = 200;
  const items = [
    { id: "A", layout: L(0, 10, 45, 200), minW: 280, minH: 170, index: 0 },
    { id: "B", layout: L(55, 10, 45, 200), minW: 280, minH: 170, index: 1 }
  ];
  const settled = settleLayouts(items, innerWidth);
  const a = layoutToRect(settled.A, innerWidth);
  const b = layoutToRect(settled.B, innerWidth);

  assert.strictEqual(a.width, innerWidth, "the first narrow pane should become full-width");
  assert.strictEqual(b.width, innerWidth, "the second narrow pane should become full-width");
  assert.ok(
    Math.abs(b.top - (rectBottom(a) + BOARD_GAP)) < 0.001,
    "overlapping narrow projections should be stacked by gravity"
  );
  assert.strictEqual(
    committedLayoutsOverlap(settled, innerWidth),
    false,
    "the stacked narrow projection must not overlap"
  );
}

// --- 14. A no-move gesture cannot persist a transient narrow projection. ---
{
  const wideItems = [
    { id: "A", layout: LP(0, 10, 500, 240), minW: 280, minH: 170, index: 0 },
    { id: "B", layout: LP(600, 10, 500, 240), minW: 280, minH: 170, index: 1 }
  ];
  const wideLayouts = settleLayouts(wideItems, IW);
  const narrowWidth = 200;
  const narrowItems = wideItems.map((item) => ({
    ...item,
    layout: wideLayouts[item.id]
  }));
  const narrowProjection = settleLayouts(narrowItems, narrowWidth);
  const narrowA = layoutToRect(narrowProjection.A, narrowWidth);
  const narrowB = layoutToRect(narrowProjection.B, narrowWidth);

  assert.ok(
    Math.abs(narrowB.top - (rectBottom(narrowA) + BOARD_GAP)) < 0.001,
    "the transient narrow projection should stack"
  );
  assert.notDeepStrictEqual(
    narrowProjection,
    wideLayouts,
    "the narrow projection should differ from canonical wide geometry"
  );
  assert.deepStrictEqual(
    Object.keys(changedLayoutEntries(wideLayouts, narrowProjection)).sort(),
    ["A", "B"],
    "persisting the old full snapshot would poison both canonical wide layouts"
  );

  // finishInteraction diffs the full on-screen result against layoutsAtStart.
  // Resolve the active pane through the real zero-delta drop path. The full
  // result still matches the transient start projection, so no pane—including
  // untouched panes—is sent to persistence.
  const layoutsAtStart = { ...narrowProjection };
  const options = new Map(wideItems.map((item) => [
    item.id,
    { minW: item.minW, minH: item.minH }
  ]));
  const startRect = layoutToRect(layoutsAtStart.A, narrowWidth);
  const committedLayout = resolveDropLayout(
    "A",
    layoutsAtStart.A,
    layoutsAtStart,
    narrowWidth,
    500,
    options,
    buildMoveDropRect(startRect, 0, 0)
  );
  const committedLayouts = {
    ...layoutsAtStart,
    A: committedLayout
  };
  assert.deepStrictEqual(
    changedLayoutEntries(layoutsAtStart, committedLayouts),
    {},
    "a no-move release must not persist the transient projection"
  );
}

// --- 15. Swap selection keeps score ordering and stable tie behavior. ---
{
  const dragged = LP(300, 100, 400, 300);
  const scoredCandidates = {
    A: dragged,
    B: LP(500, 100, 400, 300),
    C: LP(320, 100, 400, 300)
  };
  assert.strictEqual(
    findSwapTargetId("A", dragged, scoredCandidates, IW),
    "C",
    "the higher-scoring overlapping candidate should win"
  );

  const tiedTarget = LP(320, 100, 400, 300);
  const tiedCandidates = {
    A: dragged,
    B: tiedTarget,
    C: { ...tiedTarget }
  };
  assert.strictEqual(
    findSwapTargetId("A", dragged, tiedCandidates, IW),
    "B",
    "equal scores should retain the earlier Object.entries candidate"
  );
}

// --- 16. Wiring guard: the component consumes the extracted engine. ---
{
  const tiledBoardSource = fs.readFileSync(tiledBoardPath, "utf8");
  assert.ok(
    tiledBoardSource.includes('from "./tiledBoardGeometry"'),
    "TiledBoard must import the production geometry module"
  );
}

console.log("tiled board resize smoke passed (executed real tiledBoardGeometry.ts module)");


// Empty-region behavior used by both the live pointer preview and release.
{
  const {resolveMoveLayouts,findAvailablePlacement,snapCoordinate,boardPointerDelta}=geometryModule.exports;
  const width=1000;
  const R=(left,top,w,h)=>rectToLayout({left,top,width:w,height:h},width);
  const rect=layout=>layoutToRect(layout,width);
  const options=new Map();
  const make=(layouts)=>({itemId:"A",startLayout:layouts.A,startRect:rect(layouts.A),layoutsAtStart:layouts});
  const layouts={A:R(0,800,500,400),B:R(0,10,650,400)};
  const desired={left:600,top:10,width:500,height:400};
  const normal=resolveMoveLayouts(make(layouts),desired,width,{top:0,bottom:600},options);
  assert(normal);
  assert.deepStrictEqual(normal.B,layouts.B,"ordinary drop leaves the occupied pane untouched");
  assert.equal(rect(normal.A).left,654,"ordinary drop targets the right empty region instead of swapping");
  assert.ok(Math.abs(rect(normal.A).width-346)<0.001);
  const swapped=resolveMoveLayouts(make(layouts),{...desired,left:300},width,{top:0,bottom:600},options,true);
  assert(swapped);
  assert.deepStrictEqual(swapped.A,layouts.B,"Shift preview uses the final swapped target geometry");
  assert.deepStrictEqual(swapped.B,layouts.A);
  assert.deepStrictEqual(resolveMoveLayouts(make(layouts),desired,width,{top:0,bottom:600},options),normal,"same resolver gives identical preview and release");

  const heightOnly={A:R(0,604,500,220),B:R(0,214,1000,386)};
  const fitted=resolveMoveLayouts(make(heightOnly),{left:0,top:10,width:500,height:220},width,{top:0,bottom:600},options);
  assert(fitted);
  assert.equal(rect(fitted.A).left,0,"height fitting must not shift a valid x=0 anchor sideways to x=220");
  assert.equal(rect(fitted.A).height,200);
  assert.deepStrictEqual(fitted.B,heightOnly.B);

  const full={A:R(0,800,500,260),B:R(0,10,1000,590)};
  assert.equal(resolveMoveLayouts(make(full),{left:0,top:10,width:500,height:260},width,{top:0,bottom:600},options),null,"impossible visible drop rejects instead of appending or moving neighbors");
  const hole=[{id:"B",layout:R(0,10,1000,196)},{id:"C",layout:R(0,480,1000,324)}];
  assert.equal(rect(findAvailablePlacement(hole,width,{top:0,bottom:900})).top,210,"new pane uses y=210 gap instead of y=808 append");
  const scrolled=findAvailablePlacement(hole,width,{top:810,bottom:1400});
  assert.equal(rect(scrolled).top,810,"visible scrolled space ranks ahead of an offscreen hole");
  const offscreen=findAvailablePlacement(hole,width,{top:500,bottom:700});
  assert.equal(rect(offscreen).top,210,"offscreen usable hole ranks ahead of append when viewport is full");
  assert.deepStrictEqual(boardPointerDelta({x:20,y:50},{x:20,y:50},{left:10,top:0},{left:10,top:-200}),{dx:0,dy:200},"board scroll contributes to drag coordinates even with a stationary pointer");
  assert.equal(snapCoordinate(111,[100]),100);
  assert.equal(snapCoordinate(117,[100],100),100,"snap holds through the 18px release radius");
  assert.equal(snapCoordinate(119,[100],100),119);
  const compact=resolveMoveLayouts(make({A:R(0,800,280,170)}),{left:0,top:10,width:280,height:170},width,{top:0,bottom:700},options);
  assert.ok(Math.abs(rect(compact.A).width-560)<0.001);
  assert.equal(rect(compact.A).height,320);
  const splitOptions=new Map([["A",{minW:700,minH:400}]]);
  const split=resolveMoveLayouts(make({A:R(0,800,700,400)}),{left:0,top:10,width:700,height:400},width,{top:0,bottom:700},splitOptions);
  assert.equal(rect(split.A).width,700,"split minimum overrides compact width cap");
  assert.equal(rect(split.A).height,400);
}
console.log("empty-region placement, explicit swap, scroll, snap and compact sizing regressions passed");

{
  const { boardInnerWidth } = geometryModule.exports;
  assert.equal(boardInnerWidth(1198,[{minW:280}])+2*BOARD_PADDING,1198,"vertical scrollbar must not create horizontal overflow");
  assert.equal(boardInnerWidth(1198,[{minW:1300}])+2*BOARD_PADDING,1320,"a real split minimum may expand the scrollable board");
}
