const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const root = path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(root, 'frontend/terminalLinks.ts'), 'utf8');
let handler;
const opened = [];
const exportsForTest = {};
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
  exports: exportsForTest,
  require(id) {
    assert.equal(id, '@xterm/addon-web-links');
    return { WebLinksAddon: class { constructor(callback) { handler = callback; } } };
  },
  window: {
    open() { assert.fail('Terminal links must not create renderer windows'); },
    vibe: { openFusionChat: { openExternal(url) { opened.push(url); return Promise.resolve({ ok: true }); } } },
  },
});
const terminal = { options: {}, loadAddon() {} };
exportsForTest.configureTerminalLinks(terminal);
assert.equal(typeof handler, 'function');
let prevented = 0;
const event = { preventDefault() { prevented++; } };
handler(event, 'https://example.com/docs?q=terminal#setup');
terminal.options.linkHandler.activate(event, 'http://localhost:3000/embedded');
assert.deepEqual(opened, ['https://example.com/docs?q=terminal#setup', 'http://localhost:3000/embedded']);
assert.equal(prevented, 2);
assert.notEqual(terminal.options.linkHandler.allowNonHttpProtocols, true);
const pane = fs.readFileSync(path.join(root, 'frontend/components/TerminalPane.tsx'), 'utf8');
assert.match(pane, /configureTerminalLinks\(terminal\s*[,)]/);
console.log('Terminal link test passed: plain and OSC 8 links use external-browser IPC.');
