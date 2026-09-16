'use strict';
// Dedicated Electron process/profile. Never starts Lina's normal main module.
const { app, BrowserWindow, safeStorage, ipcMain } = require('electron');
const fs = require('node:fs/promises'),
  path = require('node:path'),
  { pathToFileURL } = require('node:url'),
  assert = require('node:assert/strict'),
  crypto = require('node:crypto');
const {
  createSessionStore,
} = require('../../backend/account-prepared/session-store.cjs');
const {
  createAccountTransport,
} = require('../../backend/account-prepared/transport.cjs');
const {
  createAccessPolicy,
} = require('../../backend/account-prepared/access.cjs');
const {
  createAccountController,
} = require('../../backend/account-prepared/controller.cjs');
const { installAccountIpc } = require('../../backend/account-prepared/ipc.cjs');
const config = JSON.parse(
  require('node:fs').readFileSync(
    process.env.LINA_ACCOUNT_PREPARED_CONFIG,
    'utf8',
  ),
);
const expected =
  path.resolve(__dirname, '../../.tmp/account-prepared-smoke') + path.sep;
if (!path.resolve(config.profile).startsWith(expected))
  throw Error('Isolated profile required');
app.setPath('userData', config.profile);
app.commandLine.appendSwitch('disable-gpu');
const stage =
  process.argv.find((a) => a.startsWith('--stage='))?.slice(8) || 'create';
const until = async (fn) => {
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw Error('Prepared smoke timeout');
};
function totpCode(secret) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of secret.toUpperCase().replace(/=+$/, ''))
    bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  const key = Buffer.from(
      bits.match(/.{8}/g).map((value) => parseInt(value, 2)),
    ),
    counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const digest = crypto.createHmac('sha1', key).update(counter).digest(),
    offset = digest[19] & 15;
  return ((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000)
    .toString()
    .padStart(6, '0');
}
async function fixture(route, method = 'GET') {
  const r = await fetch(config.origin + '/_fixture/' + route, {
    method,
    headers: { 'x-fixture-token': config.token },
  });
  assert(r.ok, 'fixture request failed');
  return r.json();
}
let browser, window, controller, uninstall;
const checks = [];
app
  .whenReady()
  .then(async () => {
    assert(
      safeStorage.isEncryptionAvailable(),
      'Windows secure storage unavailable',
    );
    const state = await fixture('state');
    const file = path.join(config.profile, 'lina-account-session'),
      store = createSessionStore({ file, secureStorage: safeStorage });
    browser = new BrowserWindow({
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        partition: 'prepared-browser-' + stage,
      },
    });
    browser.webContents.session.webRequest.onBeforeRequest((details, done) => {
      const url = new URL(details.url);
      done({
        cancel: !(url.protocol === 'http:' && url.hostname === '127.0.0.1'),
      });
    });
    const read = (source) => browser.webContents.executeJavaScript(source);
    async function page() {
      await browser.loadURL(config.origin + '/account');
      await until(() => read('Boolean(window.__preparedAccount)'));
    }
    const transport = createAccountTransport({
      origin: config.origin,
      fetch: async (url, options) => {
        assert.equal(new URL(url).origin, config.origin);
        return fetch(url, options);
      },
      allowLoopback: true,
    });
    const policy = createAccessPolicy({
      issuer: config.origin,
      publicKeys: { 'fixture-v1': state.publicKey },
    });
    controller = createAccountController({
      transport,
      store,
      policy,
      openBrowser: async (url) => {
        assert.equal(new URL(url).origin, config.origin);
        await browser.loadURL(url);
        await until(() => read('Boolean(window.__preparedAccount)'));
      },
      installationId: config.installationId,
      platform: 'windows',
      appVersion: '0.1.123',
    });
    if (stage === 'create') {
      await page();
      const challenge = await read(
        `window.__preparedAccount.client.login(${JSON.stringify(state.admin.email)},${JSON.stringify(state.admin.password)})`,
      );
      assert(challenge.twoFactorRedirect);
      await read(
        `window.__preparedAccount.client.verifyMfa(${JSON.stringify(totpCode(state.admin.totpSecret))})`,
      );
      assert(
        (await read('window.__preparedAccount.client.adminUsers()')).users
          .length >= 2,
      );
      assert(!(await read('document.cookie')).includes('session_token'));
      await read('window.__preparedAccount.client.logout()');
      checks.push(
        'browser MFA authorizes web-only administration with HTTP-only cookies',
      );
      await read(
        `window.__preparedAccount.client.login(${JSON.stringify(state.user.email)},${JSON.stringify(state.user.password)})`,
      );
      assert.equal(
        (await read('window.__preparedAccount.client.me()')).access
          .accountStatus,
        'pending',
      );
      await read(
        "window.__preparedAccount.billing.checkout('orchestrator','month')",
      );
      await fixture('payment', 'POST');
      assert.equal(
        (await read('window.__preparedAccount.client.me()')).access.tier,
        'orchestrator',
      );
      checks.push('browser cookie login and paid activation');
      await controller.startLogin();
      const attempt = new URL(browser.webContents.getURL()).searchParams.get(
        'attempt',
      );
      await read(
        `window.__preparedAccount.approval.approve(${JSON.stringify(attempt)})`,
      ).catch(() => {});
      await until(() => controller.snapshot().access.allowed);
      policy.assert('orchestrator.start');
      const persisted = await fs.readFile(file);
      assert(!persisted.includes(Buffer.from(transport.cookie())));
      checks.push('PKCE loopback exchange and Windows DPAPI persistence');
      const html = path.join(config.profile, 'ipc-test.html'),
        preload = path.join(config.profile, 'ipc-test.cjs');
      await fs.writeFile(
        html,
        '<!doctype html><title>Isolated account IPC</title>',
      );
      await fs.writeFile(
        preload,
        "const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('account',{status:()=>ipcRenderer.invoke('account-prepared:status')});",
      );
      window = new BrowserWindow({
        show: false,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          preload,
        },
      });
      const url = pathToFileURL(html).href;
      uninstall = installAccountIpc({
        ipcMain,
        controller,
        getWindow: () => window,
        trustedRendererUrl: url,
      });
      await window.loadURL(url);
      const visible = await window.webContents.executeJavaScript(
        'window.account.status()',
      );
      assert(visible.access.allowed);
      assert(!JSON.stringify(visible).includes(transport.cookie()));
      checks.push(
        'real context-isolated renderer receives no session credential',
      );
    } else {
      await controller.initialize();
      assert(controller.snapshot().access.allowed);
      policy.assert('terminal.input');
      checks.push('new Electron process decrypts and resumes saved session');
      await fixture('restart', 'POST');
      await controller.refresh();
      assert(controller.snapshot().access.allowed);
      checks.push(
        'prepared HTTP service reconstruction preserves native session',
      );
      await fixture('suspend', 'POST');
      await controller.refresh();
      assert(!controller.snapshot().access.allowed);
      assert.throws(() => policy.assert('terminal.input'));
      policy.assert('stop');
      policy.assert('view');
      checks.push('server suspension blocks input while view/stop survive');
      const result = await controller.logout();
      assert(result.serverRevoked);
      await assert.rejects(fs.access(file));
      checks.push('logout revokes server session and clears encrypted file');
    }
    await fs.writeFile(
      path.join(config.profile, stage + '-results.json'),
      JSON.stringify({ stage, checks, passed: true }, null, 2),
    );
    console.log(JSON.stringify({ stage, checks, passed: true }));
  })
  .catch(async (error) => {
    console.error(
      'Prepared Electron smoke failed:',
      error.code || error.message,
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    uninstall?.();
    await controller?.dispose();
    window?.destroy();
    browser?.destroy();
    app.exit(process.exitCode || 0);
  });
