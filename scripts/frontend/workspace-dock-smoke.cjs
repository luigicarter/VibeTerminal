const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");

const sourcePath = path.resolve(__dirname, "../../frontend/components/workspaceDockResize.ts");
const compiled = ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const loaded = new Module(sourcePath, module);
loaded._compile(compiled, sourcePath);
const { dockBounds, clampDockHeight, defaultDockHeight, parseDockHeight, draggedDockHeight, keyboardDockHeight } = loaded.exports;

const normal = dockBounds(860, 52);
assert.deepEqual(normal, { min: 0, max: 568 });
assert.equal(860 - 52 - normal.max, 240, "Maximum dock preserves useful board space");
assert.equal(defaultDockHeight(960), 288);
assert.equal(draggedDockHeight(288, 600, 500, normal), 388, "Dragging upward grows dock");
assert.equal(draggedDockHeight(288, 600, 700, normal), 188, "Dragging down can shrink below the old minimum");
assert.equal(draggedDockHeight(288, 600, 1000, normal), 0, "Dragging all the way down reaches the collapsed tab bar");
assert.equal(draggedDockHeight(0, 900, 860, normal), 40, "Pulling up from collapsed grows continuously");
assert.equal(draggedDockHeight(0, 900, 630, normal), 270, "Collapsed dock can be pulled open");
assert.equal(draggedDockHeight(288, 600, -1000, normal), 568);
assert.equal(keyboardDockHeight("ArrowUp", 288, normal), 304);
assert.equal(keyboardDockHeight("ArrowDown", 288, normal, true), 224);
assert.equal(keyboardDockHeight("Home", 300, normal), normal.min);
assert.equal(keyboardDockHeight("End", 300, normal), normal.max);
assert.equal(keyboardDockHeight("Tab", 300, normal), null);
assert.equal(keyboardDockHeight("ArrowDown", 8, normal), 0, "Keyboard can also collapse fully");

for (const available of [0, 80, 200, 340, 480, 860, 1400]) {
  const bounds = dockBounds(available);
  assert.ok(bounds.min >= 0 && bounds.min <= bounds.max);
  assert.ok(bounds.max <= Math.max(0, available - 52));
  for (const height of [-100, 0, 220, 400, 10000, NaN, Infinity]) {
    const clamped = clampDockHeight(height, bounds);
    assert.ok(Number.isFinite(clamped) && clamped >= bounds.min && clamped <= bounds.max);
  }
}

for (const raw of [null, "", " ", "NaN", "Infinity", "-1", "10001", "{}", '"280"']) assert.equal(parseDockHeight(raw), null);
assert.equal(parseDockHeight("388"), 388);
assert.equal(parseDockHeight("288.6"), 289);
const preference = parseDockHeight("520");
assert.equal(clampDockHeight(preference, dockBounds(500)), 273);
assert.equal(clampDockHeight(preference, normal), 520, "Window expansion restores original preference, not its temporary clamp");
assert.equal(parseDockHeight(String(preference)), preference, "Numeric localStorage preference round-trips");
console.log("workspace dock geometry, keyboard, and preference smoke passed");
