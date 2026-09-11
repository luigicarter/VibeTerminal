const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");
const filename = path.resolve(__dirname, "../../frontend/sessionRecency.ts");
const compiled = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText;
const loaded = new Module(filename, module);
loaded.filename = filename;
loaded.paths = Module._nodeModulePaths(path.dirname(filename));
loaded._compile(compiled, filename);
const { RECENCY_STORAGE_KEY, loadSessionRecency, recordSessionRecency } = loaded.exports;
const now = 1_000_000;
const load = raw => loadSessionRecency({ getItem: key => {
  assert.equal(key, RECENCY_STORAGE_KEY);
  return raw;
} }, now);

for (const raw of [null, "", "{", "null", "[]", "42", '"text"']) {
  assert.deepEqual(Object.keys(load(raw)), []);
}
assert.deepEqual(Object.keys(loadSessionRecency({ getItem() { throw new Error("denied"); } }, now)), []);
assert.deepEqual(Object.keys(load(' '.repeat(65536) + '{}')), []);
// UTF-8 bytes, not merely JavaScript string length, enforce the bound.
assert.deepEqual(Object.keys(load(JSON.stringify({ valid: now, ["é".repeat(33000)]: now }))), []);

const sanitized = load('{"good":900000,"skew":1004999,"future":1005001,"zero":0,"negative":-1,"nan":"NaN","infinite":1e999,"nested":{},"bad id":1,"__proto__":1,"constructor":2,"prototype":3}');
assert.equal(Object.getPrototypeOf(sanitized), null);
assert.deepEqual(Object.keys(sanitized).sort(), ["good", "skew"]);
assert.equal(sanitized.good, 900000);
assert.equal({}.polluted, undefined);
assert.deepEqual(Object.keys(load(JSON.stringify({ ["x".repeat(129)]: now }))), []);

const many = Object.fromEntries(Array.from({ length: 250 }, (_, i) => [`session-${i}`, now - i]));
const pruned = load(JSON.stringify(many));
assert.equal(Object.keys(pruned).length, 200);
assert.equal(pruned["session-0"], now);
assert.equal(pruned["session-199"], now - 199);
assert.equal(pruned["session-200"], undefined);

Object.freeze(pruned);
const selected = recordSessionRecency(pruned, "session-249", now + 100);
assert.notEqual(selected, pruned);
assert.equal(Object.keys(selected).length, 200);
assert.equal(selected["session-249"], now + 100);
assert.equal(selected["session-199"], undefined);
assert.equal(pruned["session-249"], undefined);
assert.equal(recordSessionRecency(selected, "session-249", now + 50)["session-249"], now + 100);
assert.equal(recordSessionRecency(selected, "session-249", now + 200)["session-249"], now + 200);
for (const bad of [NaN, Infinity, -1, 0]) assert.equal(recordSessionRecency(selected, "valid", bad), selected);
for (const bad of ["", "__proto__", "constructor", "prototype", "bad id"]) {
  assert.equal(recordSessionRecency(selected, bad, now), selected);
}
const inherited = Object.create({ inherited: now });
inherited.own = now - 10;
const safe = recordSessionRecency(inherited, "new", now);
assert.equal(Object.getPrototypeOf(safe), null);
assert.deepEqual(Object.keys(safe).sort(), ["new", "own"]);
assert.deepEqual({ ...load(JSON.stringify(selected)) }, { ...selected });
console.log("session recency smoke passed");
