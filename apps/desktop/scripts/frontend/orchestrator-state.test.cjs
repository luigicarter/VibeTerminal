const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const filename = path.resolve(__dirname, '../../frontend/orchestratorState.ts');
const loaded = new Module(filename, module);
loaded._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, filename);
const { mergeRelayActivity } = loaded.exports;

test('activity racing initial state preserves transcript references and ignores older inventory', () => {
  const full = Object.freeze({ publicationRevision: 1, sessions: [{ id: 'old' }], activeTargets: [], messages: [{ text: 'history' }], receipts: [], tasks: [] });
  const activity = { publicationRevision: 3, sessions: [{ id: 'current' }], activeTargets: [{ id: 'current' }], messages: ['must not replace history'] };
  const merged = mergeRelayActivity(full, activity);
  assert.equal(merged.sessions, activity.sessions);
  for (const key of ['messages', 'receipts', 'tasks']) assert.equal(merged[key], full[key]);
  assert.equal(mergeRelayActivity(merged, { ...activity, publicationRevision: 2 }), merged);
  assert.equal(mergeRelayActivity(merged, activity), merged);
  assert.equal(full.sessions[0].id, 'old');
  const newerFull = { ...full, publicationRevision: 4, messages: [] };
  assert.equal(mergeRelayActivity(newerFull, activity), newerFull);
});
