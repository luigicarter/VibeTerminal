const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const file = path.join(root, 'frontend/account/model.ts');
const loaded = new Module(file, module);
loaded._compile(
  ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText,
  file,
);
const { initialAccount, scenes, accessSummary } = loaded.exports;
test('desktop presentation distinguishes Full Access from Orchestrator', () => {
  assert.equal(
    accessSummary('account', { ...initialAccount, tier: 'full_access' })
      .terminals,
    true,
  );
  assert.equal(
    accessSummary('account', { ...initialAccount, tier: 'full_access' })
      .orchestrator,
    false,
  );
  assert.equal(accessSummary('account', initialAccount).orchestrator, true);
  assert.equal(
    accessSummary('account', { ...initialAccount, verified: false }).terminals,
    false,
  );
  assert.equal(
    accessSummary('account', {
      ...initialAccount,
      offline: true,
      graceEndsAt: null,
    }).terminals,
    false,
  );
});
test('blocked preview states preserve the running-work message', () => {
  for (const screen of ['suspended', 'expired', 'offline-expired']) {
    const presentation = accessSummary(screen, initialAccount);
    assert.equal(presentation.terminals, false);
    assert.equal(presentation.preserveRunningWork, true);
  }
  assert.equal(
    accessSummary('welcome', initialAccount).preserveRunningWork,
    false,
  );
});
test('desktop scenarios contain only personal account states', () => {
  assert.ok(Object.keys(scenes).length >= 10);
  const source = fs.readFileSync(
    path.join(root, 'frontend/account/AccountView.tsx'),
    'utf8',
  );
  assert.doesNotMatch(source, /admin|Administration|Manage users|owner/i);
});
test('account views remain outside startup, IPC and persistent state', () => {
  for (const name of fs.readdirSync(path.join(root, 'frontend/account'))) {
    if (!/\.tsx?$/.test(name)) continue;
    const source = fs.readFileSync(
      path.join(root, 'frontend/account', name),
      'utf8',
    );
    assert.doesNotMatch(
      source,
      /\bfetch\s*\(|XMLHttpRequest|sendBeacon|localStorage|sessionStorage|ipcRenderer|window\.vibe|window\.open/,
    );
  }
  for (const name of [
    'frontend/main.tsx',
    'frontend/App.tsx',
    'preload/preload.cjs',
    'backend/main.cjs',
  ]) {
    const source = fs.readFileSync(path.join(root, name), 'utf8');
    assert.doesNotMatch(source, /(?:from|require\()\s*['"][^'"]*\/account\//);
  }
});
