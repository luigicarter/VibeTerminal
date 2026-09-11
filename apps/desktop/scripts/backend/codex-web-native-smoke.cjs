'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { Rpc } = require('./codex-web-test-rpc.cjs');
const root = path.resolve(__dirname, '../..');
const home = path.join(root, '.tmp', 'codex-web-native-' + Date.now());
fs.mkdirSync(home, { recursive: true });
const binary = require('../../backend/codexWebNative.cjs').resolveNativeBinary({ root });
(async () => {
  const rpc = new Rpc(binary, home, root);
  try {
    await rpc.ready;
    const result = await rpc.call('account/read', { refreshToken: false });
    assert.equal(result.account, null, 'An isolated Codex Web home must not reuse the global Codex login.');
    await rpc.call('account/logout', {});
    assert.equal(fs.existsSync(path.join(home, 'auth.json')), false);
    console.log('Embedded Codex stdio handshake and isolated account/logout passed; no model request sent.');
  } finally { await rpc.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
