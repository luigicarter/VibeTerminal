const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

// Execute the actual addon initialization: terminal content must use the
// validated main-process browser opener, never Electron's window.open default.
const source = fs.readFileSync('frontend/components/TerminalPane.tsx', 'utf8');
const ast = ts.createSourceFile('TerminalPane.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let initializer;
function visit(node) {
  if (ts.isNewExpression(node) && node.expression.getText(ast) === 'WebLinksAddon') initializer = node.getText(ast);
  ts.forEachChild(node, visit);
}
visit(ast);
assert(initializer, 'TerminalPane must configure its link addon');
let handler;
const opened = [];
vm.runInNewContext(ts.transpileModule(initializer, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, {
  WebLinksAddon: class { constructor(callback) { handler = callback; } },
  window: {
    open() { assert.fail('Terminal links must not create renderer windows'); },
    vibe: { openFusionChat: { openExternal(url) { opened.push(url); return Promise.resolve({ ok: true }); } } },
  },
});
assert.equal(typeof handler, 'function');
handler({}, 'https://example.com/docs?q=terminal#setup');
assert.deepEqual(opened, ['https://example.com/docs?q=terminal#setup']);
console.log('Terminal link test passed: actual addon routes URL to validated external-browser IPC.');
