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

function policy(current) {
  let navigation, popup;
  vm.runInNewContext(source.slice(start, end), {
    URL,
    mainWindow: { webContents: {
      getURL: () => current,
      setWindowOpenHandler: (handler) => { popup = handler; },
      on: (name, handler) => { assert.equal(name, "will-navigate"); navigation = handler; }
    } }
  });
  return {
    popup,
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
    assert.equal(guard.popup().action, "deny");
  });
  test(`reject replacement documents: ${current}`, () => {
    const guard = policy(current);
    for (const target of ["https://example.com", "file:///C:/other.html",
      "http://127.0.0.1:5173/other", `${current}?replacement=1`, "javascript:alert(1)", "invalid"]) {
      assert.equal(guard.blocked(target), true, target);
    }
  });
}
