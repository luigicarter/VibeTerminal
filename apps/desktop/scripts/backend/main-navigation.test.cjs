"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "../../backend/main.cjs"), "utf8");
const start = source.indexOf('  mainWindow.webContents.setWindowOpenHandler(');
const end = source.indexOf('  installApplicationMenu(mainWindow);', start);
assert(start >= 0 && end > start);
const openerStart = source.indexOf('async function openExternalUrl(');
const openerEnd = source.indexOf('\nipcMain.handle("openfusion-chat:auth-remove"', openerStart);
assert(openerStart >= 0 && openerEnd > openerStart);

function policy(current, open = async () => {}) {
  let navigation, popup;
  let ipcOpen;
  const opened = [];
  const context = {
    URL,
    shell: { openExternal: async (url) => { opened.push(url); await open(url); } },
    ipcMain: { handle: (channel, handler) => {
      assert.equal(channel, 'app:open-external'); ipcOpen = handler;
    } }
  };
  vm.createContext(context);
  vm.runInContext(source.slice(openerStart, openerEnd), context);
  context.mainWindow = { webContents: {
    getURL: () => current,
    setWindowOpenHandler: (handler) => { popup = handler; },
    on: (name, handler) => { assert.equal(name, "will-navigate"); navigation = handler; }
  } };
  vm.runInContext(source.slice(start, end), context);
  return {
    popup,
    opened,
    ipcOpen: (url) => ipcOpen({}, { url }),
    blocked(target) {
      let blocked = false;
      navigation({ preventDefault() { blocked = true; } }, target);
      return blocked;
    }
  };
}

for (const current of ["file:///C:/vibe/dist/index.html", "http://127.0.0.1:5173/"]) {
  test(`allow app reload and hash navigation: ${current}`, () => {
    const guard = policy(`${current}#before`);
    assert.equal(guard.blocked(current), false);
    assert.equal(guard.blocked(`${current}#after`), false);
    assert.equal(guard.popup({ url: 'about:blank' }).action, "deny");
    assert.deepEqual(guard.opened, []);
  });
  test(`reject replacement documents: ${current}`, () => {
    const guard = policy(current);
    for (const target of ["https://example.com", "file:///C:/other.html",
      "http://127.0.0.1:5173/other", `${current}?replacement=1`, "javascript:alert(1)", "invalid"]) {
      assert.equal(guard.blocked(target), true, target);
    }
  });
  test(`open web links in the browser without replacing Lina: ${current}`, async () => {
    const guard = policy(current);
    const popupUrl = 'https://example.com/docs?q=terminal#setup';
    const navigationUrl = 'http://localhost:3000/preview';
    assert.equal(guard.popup({ url: popupUrl }).action, 'deny');
    assert.equal(guard.blocked(navigationUrl), true);
    assert.equal((await guard.ipcOpen('  HTTPS://EXAMPLE.COM/auth?code=fixture#done  ')).ok, true);
    assert.deepEqual(guard.opened, [popupUrl, navigationUrl, 'https://example.com/auth?code=fixture#done']);
  });
}

test('reject unsafe and invalid URLs through every link entry point', async () => {
  const guard = policy('file:///C:/vibe/dist/index.html');
  for (const url of ['about:blank', 'file:///C:/other.html', 'javascript:alert(1)',
    'data:text/html,hello', 'ms-settings:privacy', 'mailto:test@example.com', 'invalid', '', undefined, {}]) {
    assert.equal(guard.popup({ url }).action, 'deny');
    assert.equal(guard.blocked(url), true);
    assert.equal((await guard.ipcOpen(url)).ok, false);
  }
  assert.deepEqual(guard.opened, []);
});

test('report browser launch failures and contain fallback rejections', async () => {
  const guard = policy('file:///C:/vibe/dist/index.html', async () => { throw new Error('failed'); });
  const result = await guard.ipcOpen('https://example.com');
  assert.equal(result.ok, false);
  assert.match(result.error, /default browser/);
  assert.equal(guard.popup({ url: 'https://example.com' }).action, 'deny');
  assert.equal(guard.blocked('https://example.com'), true);
  await new Promise(resolve => setImmediate(resolve));
});
