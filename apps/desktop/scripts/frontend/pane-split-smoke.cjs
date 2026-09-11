const assert = require("assert");
const fs = require("fs");
const Module = require("module");
const path = require("path");
const ts = require("typescript");

// Regression guard for split tiles.
//
// Like tiled-board-resize-smoke, this transpiles and executes the real
// production module in memory, so every fixture below exercises the same
// functions the board uses. splitTree.ts is deliberately React-free so it can
// be driven this way.
const splitTreePath = path.join(
  __dirname,
  "..",
  "..",
  "frontend",
  "components",
  "splitTree.ts"
);
const paneSplitPath = path.join(
  __dirname,
  "..",
  "..",
  "frontend",
  "components",
  "PaneSplit.tsx"
);
const appPath = path.join(__dirname, "..", "..", "frontend", "App.tsx");
const terminalPanePath = path.join(
  __dirname,
  "..",
  "..",
  "frontend",
  "components",
  "TerminalPane.tsx"
);
const tiledBoardPath = path.join(
  __dirname,
  "..",
  "..",
  "frontend",
  "components",
  "TiledBoard.tsx"
);
const stylesPath = path.join(__dirname, "..", "..", "frontend", "styles.css");

const splitTreeSource = fs.readFileSync(splitTreePath, "utf8");
const compiled = ts.transpileModule(splitTreeSource, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022
  },
  fileName: splitTreePath
}).outputText;
const splitTreeModule = new Module(splitTreePath, module);
splitTreeModule.filename = splitTreePath;
splitTreeModule.paths = Module._nodeModulePaths(path.dirname(splitTreePath));
splitTreeModule._compile(compiled, splitTreePath);

const {
  MAX_SPLIT_RATIO,
  MIN_SPLIT_RATIO,
  buildBoardTiles,
  clampSplitRatio,
  detachSessionFromTile,
  effectiveTileId,
  isTileAnchor,
  leafIds,
  normalizeSplitNode,
  reconcileTiles,
  removeLeaf,
  setRatioAtPath,
  splitLeaf,
  subtreeMin
} = splitTreeModule.exports;

function box(y) {
  return { x: 0, y, w: 49, h: 260, unit: "fluid" };
}

// ---------------------------------------------------------------------------
// Tree structure
// ---------------------------------------------------------------------------

// Splitting replaces a leaf with a divider over the original pane and the new
// one, so the partition stays complete by construction.
const soloTree = { id: "a" };
const twoUp = splitLeaf(soloTree, "a", "row", "b");
assert.deepStrictEqual(twoUp, {
  dir: "row",
  ratio: 0.5,
  a: { id: "a" },
  b: { id: "b" }
});
assert.deepStrictEqual(leafIds(twoUp), ["a", "b"]);

// The shape the user drew: two side by side on top, one full width below.
const drawn = splitLeaf(twoUp, "a", "col", "c");
assert.deepStrictEqual(leafIds(drawn), ["a", "c", "b"]);
// Splitting a leaf that is not in the tree is a no-op.
assert.strictEqual(splitLeaf(twoUp, "missing", "row", "z"), twoUp);

// Removing a leaf collapses its parent into the surviving sibling.
assert.deepStrictEqual(removeLeaf(twoUp, "b"), { id: "a" });
assert.deepStrictEqual(removeLeaf(drawn, "c"), twoUp);
assert.strictEqual(removeLeaf({ id: "a" }, "a"), undefined);
assert.strictEqual(removeLeaf(twoUp, "missing"), twoUp);

// Ratios live on the divider node addressed by a path.
const reRatioed = setRatioAtPath(drawn, [], 0.7);
assert.strictEqual(reRatioed.ratio, 0.7);
assert.strictEqual(setRatioAtPath(drawn, ["a"], 0.2).a.ratio, 0.2);
assert.strictEqual(setRatioAtPath(drawn, [], 5).ratio, MAX_SPLIT_RATIO);
assert.strictEqual(setRatioAtPath(drawn, [], -5).ratio, MIN_SPLIT_RATIO);
assert.strictEqual(clampSplitRatio(Number.NaN), 0.5);
assert.strictEqual(clampSplitRatio("nope"), 0.5);

// ---------------------------------------------------------------------------
// subtreeMin: what a tile must advertise to TiledBoard
// ---------------------------------------------------------------------------

const LEAF_W = 280;
const LEAF_H = 170;
const DIVIDER = 6;
assert.deepStrictEqual(subtreeMin({ id: "a" }, LEAF_W, LEAF_H, DIVIDER), {
  minW: LEAF_W,
  minH: LEAF_H
});
// row: widths add (plus the divider), heights take the max.
assert.deepStrictEqual(subtreeMin(twoUp, LEAF_W, LEAF_H, DIVIDER), {
  minW: LEAF_W * 2 + DIVIDER,
  minH: LEAF_H
});
// The drawn tree is a col of (row of two) over one: width from the inner row,
// height from both rows plus both dividers.
assert.deepStrictEqual(subtreeMin(drawn, LEAF_W, LEAF_H, DIVIDER), {
  minW: LEAF_W * 2 + DIVIDER,
  minH: LEAF_H * 2 + DIVIDER
});

// A divider can never be dragged into producing a pane below its subtree
// minimum: that is what the clamp in PaneSplit is computed from, so verify the
// arithmetic holds at every tile size a user could produce.
for (const totalPx of [200, 400, 600, 1200, 4000]) {
  const usable = totalPx - DIVIDER;
  const aMin = subtreeMin(twoUp.a, LEAF_W, LEAF_H, DIVIDER).minW;
  const bMin = subtreeMin(twoUp.b, LEAF_W, LEAF_H, DIVIDER).minW;
  if (aMin + bMin > usable) {
    // Undersized tile: the drag is refused outright rather than picking a
    // winner, so there is no ratio to check.
    continue;
  }
  const minRatio = Math.max(MIN_SPLIT_RATIO, aMin / usable);
  const maxRatio = Math.min(MAX_SPLIT_RATIO, 1 - bMin / usable);
  assert(minRatio <= maxRatio, `clamp range collapsed at ${totalPx}px`);
  assert(minRatio * usable >= aMin - 1e-9, `pane a below min at ${totalPx}px`);
  assert(
    (1 - maxRatio) * usable >= bMin - 1e-9,
    `pane b below min at ${totalPx}px`
  );
  assert(minRatio > 0 && maxRatio < 1, `ratio reached an edge at ${totalPx}px`);
}

// ---------------------------------------------------------------------------
// normalizeSplitNode: localStorage is user-editable
// ---------------------------------------------------------------------------

assert.strictEqual(normalizeSplitNode(undefined), undefined);
assert.strictEqual(normalizeSplitNode({ dir: "diagonal", a: {}, b: {} }), undefined);
assert.deepStrictEqual(normalizeSplitNode({ id: "a" }), { id: "a" });
// A NaN ratio falls back rather than poisoning the layout.
assert.strictEqual(
  normalizeSplitNode({ dir: "row", ratio: Number.NaN, a: { id: "a" }, b: { id: "b" } })
    .ratio,
  0.5
);
// A branch with one unusable child collapses into the other.
assert.deepStrictEqual(
  normalizeSplitNode({ dir: "row", a: { id: "a" }, b: { nonsense: true } }),
  { id: "a" }
);
// Duplicate leaves are dropped: two tiles must never claim one session.
assert.deepStrictEqual(
  leafIds(
    normalizeSplitNode({ dir: "row", a: { id: "a" }, b: { id: "a" } })
  ),
  ["a"]
);
// A cyclic hand-edited object terminates on the depth cap instead of hanging.
const cyclic = { dir: "row", ratio: 0.5, a: { id: "a" } };
cyclic.b = cyclic;
assert.strictEqual(leafIds(normalizeSplitNode(cyclic)).length, 1);
// The leaf cap bounds a pathological tree.
let deep = { id: "leaf-0" };
for (let i = 1; i < 40; i += 1) {
  deep = { dir: "row", ratio: 0.5, a: deep, b: { id: `leaf-${i}` } };
}
assert(leafIds(normalizeSplitNode(deep)).length <= 8, "leaf cap should bound the tree");

// ---------------------------------------------------------------------------
// Tile membership
// ---------------------------------------------------------------------------

function tiledFixture() {
  return [
    { id: "a", tileId: "a", splitTree: drawn, layout: box(10) },
    { id: "c", tileId: "a", layout: box(999) },
    { id: "b", tileId: "a", layout: box(998) },
    { id: "solo", layout: box(300) }
  ];
}

assert.strictEqual(effectiveTileId({ id: "solo" }), "solo");
assert.strictEqual(effectiveTileId({ id: "c", tileId: "a" }), "a");
assert.strictEqual(isTileAnchor({ id: "a", tileId: "a" }), true);
assert.strictEqual(isTileAnchor({ id: "c", tileId: "a" }), false);

// Detaching a non-anchor leaves the anchor in place.
const withoutC = detachSessionFromTile(tiledFixture(), "c");
assert.deepStrictEqual(leafIds(withoutC.find((s) => s.id === "a").splitTree), [
  "a",
  "b"
]);
const detachedC = withoutC.find((s) => s.id === "c");
assert.strictEqual(detachedC.tileId, undefined);
assert.strictEqual(detachedC.splitTree, undefined);
// The detached pane keeps its own (dead-data) layout for the caller to place.
assert.deepStrictEqual(detachedC.layout, box(999));

// Detaching the ANCHOR re-anchors on the first surviving member in list order,
// and that new anchor inherits the tile's board box.
const withoutAnchor = detachSessionFromTile(tiledFixture(), "a");
const newAnchor = withoutAnchor.find((s) => s.splitTree);
assert.strictEqual(newAnchor.id, "c", "should re-anchor in session-list order");
assert.strictEqual(newAnchor.tileId, "c");
assert.deepStrictEqual(newAnchor.layout, box(10), "tile keeps its board box");
assert.deepStrictEqual(leafIds(newAnchor.splitTree), ["c", "b"]);
assert.strictEqual(withoutAnchor.find((s) => s.id === "b").tileId, "c");
assert.strictEqual(withoutAnchor.find((s) => s.id === "a").tileId, undefined);

// Down to one member the tile dissolves entirely, and the survivor inherits the
// board box so it lands exactly where the tile was.
const twoMemberTile = [
  { id: "a", tileId: "a", splitTree: twoUp, layout: box(10) },
  { id: "b", tileId: "a", layout: box(999) }
];
const dissolved = detachSessionFromTile(twoMemberTile, "a");
const survivor = dissolved.find((s) => s.id === "b");
assert.strictEqual(survivor.tileId, undefined);
assert.strictEqual(survivor.splitTree, undefined);
assert.deepStrictEqual(survivor.layout, box(10));

// Detaching an ungrouped session, or an unknown id, changes nothing.
const soloOnly = [{ id: "solo", layout: box(10) }];
assert.strictEqual(detachSessionFromTile(soloOnly, "solo"), soloOnly);
assert.strictEqual(detachSessionFromTile(soloOnly, "ghost"), soloOnly);

// ---------------------------------------------------------------------------
// reconcileTiles: cross-session repair, and it never drops a session
// ---------------------------------------------------------------------------

function assertRepairKeepsEveryone(input, message) {
  const repaired = reconcileTiles(input);
  assert.deepStrictEqual(
    repaired.map((s) => s.id).sort(),
    input.map((s) => s.id).sort(),
    `${message}: no session may be dropped`
  );
  assert.deepStrictEqual(
    reconcileTiles(repaired),
    repaired,
    `${message}: repair should be idempotent`
  );
  return repaired;
}

const healthy = assertRepairKeepsEveryone(tiledFixture(), "healthy tile");
assert.deepStrictEqual(leafIds(healthy.find((s) => s.id === "a").splitTree), [
  "a",
  "c",
  "b"
]);
assert.strictEqual(healthy.find((s) => s.id === "solo").tileId, undefined);

// A tree naming a session that no longer exists drops that leaf.
const missingMember = assertRepairKeepsEveryone(
  [
    { id: "a", tileId: "a", splitTree: twoUp, layout: box(10) },
    { id: "ghosted", tileId: "a", layout: box(20) }
  ],
  "tree naming a missing session"
);
// Only one real member remains, so the tile dissolves.
assert.strictEqual(missingMember.find((s) => s.id === "a").tileId, undefined);
assert.strictEqual(missingMember.find((s) => s.id === "a").splitTree, undefined);
assert.strictEqual(missingMember.find((s) => s.id === "ghosted").tileId, undefined);

// A tileId pointing at a session that is not an anchor is cleared, and the
// session comes back as an ordinary solo tile with its stored layout.
const orphaned = assertRepairKeepsEveryone(
  [
    { id: "a", layout: box(10) },
    { id: "b", tileId: "a", layout: box(20) }
  ],
  "orphaned tileId"
);
assert.strictEqual(orphaned.find((s) => s.id === "b").tileId, undefined);
assert.deepStrictEqual(orphaned.find((s) => s.id === "b").layout, box(20));

// A stray splitTree on a NON-anchor is discarded rather than creating a tile.
const strayTree = assertRepairKeepsEveryone(
  [
    { id: "a", tileId: "a", splitTree: twoUp, layout: box(10) },
    { id: "b", tileId: "a", splitTree: drawn, layout: box(20) }
  ],
  "stray splitTree on a member"
);
assert.strictEqual(strayTree.find((s) => s.id === "b").splitTree, undefined);
assert.deepStrictEqual(leafIds(strayTree.find((s) => s.id === "a").splitTree), [
  "a",
  "b"
]);

// An anchor missing from its own tree is re-anchored rather than dissolved.
const selfless = assertRepairKeepsEveryone(
  [
    { id: "a", tileId: "a", splitTree: { dir: "row", ratio: 0.5, a: { id: "b" }, b: { id: "c" } }, layout: box(10) },
    { id: "b", tileId: "a", layout: box(20) },
    { id: "c", tileId: "a", layout: box(30) }
  ],
  "anchor missing from its own tree"
);
assert.strictEqual(selfless.find((s) => s.splitTree).id, "b");
assert.deepStrictEqual(selfless.find((s) => s.splitTree).layout, box(10));
assert.strictEqual(selfless.find((s) => s.id === "a").tileId, undefined);

// Two anchors claiming the same member: the first wins, the second cannot end
// up with a one-member tile, and nobody is lost.
const contested = assertRepairKeepsEveryone(
  [
    { id: "a", tileId: "a", splitTree: twoUp, layout: box(10) },
    { id: "b", tileId: "a", layout: box(20) },
    { id: "z", tileId: "z", splitTree: { dir: "row", ratio: 0.5, a: { id: "z" }, b: { id: "b" } }, layout: box(30) }
  ],
  "two tiles claiming one member"
);
assert.deepStrictEqual(leafIds(contested.find((s) => s.id === "a").splitTree), [
  "a",
  "b"
]);
assert.strictEqual(contested.find((s) => s.id === "z").tileId, undefined);
assert.strictEqual(contested.find((s) => s.id === "z").splitTree, undefined);

// A corrupt tree degrades to solo tiles with every session still present.
assertRepairKeepsEveryone(
  [
    { id: "a", tileId: "a", splitTree: { dir: "sideways", a: 3, b: null }, layout: box(10) },
    { id: "b", tileId: "a", layout: box(20) }
  ],
  "corrupt tree"
);

// ---------------------------------------------------------------------------
// buildBoardTiles: what the board actually renders
// ---------------------------------------------------------------------------

const tiles = buildBoardTiles(tiledFixture());
assert.strictEqual(tiles.length, 2, "a 3-pane tile plus a solo pane = 2 tiles");
assert.strictEqual(tiles[0].id, "a");
assert.deepStrictEqual(
  tiles[0].members.map((member) => member.id),
  ["a", "c", "b"]
);
assert.strictEqual(tiles[1].id, "solo");
assert.strictEqual(tiles[1].tree, undefined);
// Every tile id is a real session id, which is what keeps persistLayout's
// existing `nextLayouts[session.id]` lookup landing on the anchor.
const ids = new Set(tiledFixture().map((s) => s.id));
for (const tile of tiles) {
  assert(ids.has(tile.id), `tile id ${tile.id} should be a session id`);
}

// ---------------------------------------------------------------------------
// Wiring contracts
// ---------------------------------------------------------------------------

const appSource = fs.readFileSync(appPath, "utf8");
// Only anchors occupy board space; a grouped member's stale layout must not
// reserve a slot nothing renders.
const findNextIndex = appSource.indexOf("function findNextFluidLayout");
assert(
  findNextIndex > 0 &&
    appSource.slice(findNextIndex, findNextIndex + 900).includes("buildBoardTiles(sessions).map((tile) =>") &&
    appSource.slice(findNextIndex, findNextIndex + 900).includes("tile.anchor.layout"),
  "findNextFluidLayout should only consider tile anchors"
);
// Membership is repaired wherever sessions become a set.
assert(
  (appSource.match(/reconcileTiles\(/g) || []).length >= 2,
  "reconcileTiles should run for both workspace and multi-session loads"
);
assert(
  appSource.includes("splitTree: normalizeSplitNode(session.splitTree)"),
  "restoreSession should shape-validate a persisted tree"
);
// Closing a sub-pane collapses the tile before the session disappears.
assert(
  appSource.includes("detachSessionFromTile(sessions, sessionId).filter"),
  "closeSession should detach from its tile before removing the session"
);
// Maximize acts on the tile: maximizing one pane of a split would hide its
// siblings, and a hidden pane cannot measure itself.
assert(
  appSource.includes("effectiveTileId(session) === maximizedTileId"),
  "maximize should filter by tile, not by session"
);
assert(
  appSource.includes("onArrangeChange={setIsArranging}") &&
    appSource.includes("onRatioChange={(path, ratio) =>"),
  "PaneSplit should share the board's arranging flag and commit ratios"
);

const paneSplitSource = fs.readFileSync(paneSplitPath, "utf8");
assert(
  paneSplitSource.includes("setPointerCapture") &&
    paneSplitSource.includes("subtreeMin(branch.a") &&
    paneSplitSource.includes("subtreeMin(branch.b") &&
    paneSplitSource.includes("event.preventDefault()") &&
    paneSplitSource.includes("event.stopPropagation()"),
  "the divider drag should capture the pointer, clamp on both subtrees, and not start a board drag"
);
assert(
  paneSplitSource.includes("flexGrow: current.ratio") &&
    paneSplitSource.includes("flexGrow: 1 - current.ratio"),
  "ratios should drive flex-grow, so a tile resize reflows for free"
);

const tiledBoardSource = fs.readFileSync(tiledBoardPath, "utf8");
assert(
  tiledBoardSource.includes(".pane-split-divider"),
  "a divider press must not start a board drag"
);
assert(
  tiledBoardSource.includes("data-tile-id={item.id}"),
  "the frame should expose its tile id"
);

const terminalPaneSource = fs.readFileSync(terminalPanePath, "utf8");
assert(
  terminalPaneSource.includes("data-pane-id={session.id}") &&
    !/data-session-id\s*=/.test(terminalPaneSource),
  "the pane must not shadow the frame's data-session-id (tooling resolves the frame with closest())"
);
assert(
  terminalPaneSource.includes("if (autoFocusRef.current) {"),
  "focus on mount should be gated by the autoFocus prop"
);
// New panes now select themselves. Reattachment must not let every solo pane
// steal focus; the first visible pane is the initial null-selection fallback.
assert(
  appSource.includes("session.id === selectedSessionId || (!selectedSessionId && session.id === visibleSessionIds[0])") &&
    appSource.includes("setSelectedSessionId(created.id)"),
  "new panes select themselves and remount focus follows selection"
);
assert(
  terminalPaneSource.includes("suppressFrameTransition(paneFrame)") &&
    terminalPaneSource.includes("releaseFrameTransition(paneFrame)") &&
    terminalPaneSource.includes("frameTransitionSuppressions"),
  "several panes sharing one frame should refcount the transition suppression"
);
// The redesigned header puts split/pop-out in its accessible action menu;
// pop-out remains conditional on membership in a split tile.
assert(
  terminalPaneSource.includes("onSplit: (dir: \"row\" | \"col\") => void;") &&
    terminalPaneSource.includes("isGrouped ?") &&
    terminalPaneSource.includes("run:onPopOut") &&
    terminalPaneSource.includes('onSplit("row")') && terminalPaneSource.includes('onSplit("col")'),
  "split/pop-out should stay wired, with pop-out shown only when grouped"
);

const stylesSource = fs.readFileSync(stylesPath, "utf8");
assert(
  stylesSource.includes(".pane-split-root") &&
    stylesSource.includes(".pane-split-divider") &&
    stylesSource.includes("min-width: 120px"),
  "styles.css should floor split leaves so a pane can never reach a zero box"
);

console.log("pane split smoke passed");
