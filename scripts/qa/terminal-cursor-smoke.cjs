const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "../..");

if (!process.versions.electron) {
  const { spawn } = require("node:child_process");
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require("electron"), [__filename], {
    env, stdio: "inherit", windowsHide: true
  });
  child.on("error", error => { console.error(error); process.exitCode = 1; });
  child.on("exit", code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = require("electron");
  const ts = require("typescript");
  app.setPath("userData", path.join(root, ".tmp", `terminal-cursor-${process.pid}`));
  app.whenReady().then(async () => {
    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        offscreen: true, nodeIntegration: true, contextIsolation: false,
        backgroundThrottling: false
      }
    });
    try {
      await win.loadURL("about:blank");
      await win.webContents.insertCSS(fs.readFileSync(path.join(root, "node_modules/@xterm/xterm/css/xterm.css"), "utf8"));
      const compiled = ts.transpileModule(fs.readFileSync(path.join(root, "frontend/terminalCursor.ts"), "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
      }).outputText;
      const result = await win.webContents.executeJavaScript(`(async () => {
        const exports = {};
        ${compiled}
        const { Terminal } = require(${JSON.stringify(path.join(root, "node_modules/@xterm/xterm"))});
        const term = new Terminal({ cursorBlink: true, theme: { cursor: '#ff9f43' } });
        const host = document.createElement('div'); document.body.append(host);
        term.open(host);
        const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
        const write = data => new Promise(resolve => term.write(data, resolve));
        await write('prompt> '); await pause(100);
        // Offscreen windows cannot take OS focus. Exercise the real focused
        // DOM renderer with its focus inputs supplied explicitly.
        let focused = true;
        Object.defineProperty(term._core._coreBrowserService, 'isFocused', { get: () => focused });
        term._core.coreService.isCursorInitialized = true;
        term._core._renderService._isPaused = false;
        host.querySelector('.xterm-rows').classList.add('xterm-focus');
        const inspect = () => {
          const e = host.querySelector('.xterm-cursor');
          return { style:term.options.cursorStyle, blink:term.options.cursorBlink,
            classes:e?.className, animations:e?.getAnimations().length,
            background:e && getComputedStyle(e).backgroundColor,
            shadow:e && getComputedStyle(e).boxShadow };
        };
        await write('\\x1b[0 q'); await pause(60);
        const original = inspect();
        const handler = exports.configureCodexCursor(term);
        const samples = [];
        for (const data of ['\\x1b[0 q\\rprompt> a', '\\x1b[ q\\rprompt> ab', '\\x1b[?25l\\rworking...\\x1b[0 q\\x1b[?25h']) {
          await write(data); await pause(60); samples.push(inspect());
        }
        await pause(650); samples.push(inspect());
        focused = false; term.refresh(0, term.rows - 1); await pause(60);
        const inactive = inspect();
        await write('\\x1b[2 q');
        const explicit = { style:term.options.cursorStyle, blink:term.options.cursorBlink };
        term.reset(); await write('\\x1b[0 q');
        const reset = { style:term.options.cursorStyle, blink:term.options.cursorBlink };
        handler.dispose(); await write('\\x1b[0 q');
        const disposed = { style:term.options.cursorStyle, blink:term.options.cursorBlink };
        term.dispose();
        return { original, samples, inactive, explicit, reset, disposed };
      })()`);
      assert.equal(result.original.style, "block");
      assert.equal(result.original.blink, true);
      assert.equal(result.original.animations, 1, "control reproduces animated block");
      for (const sample of [...result.samples, result.inactive]) {
        assert.equal(sample.style, "bar");
        assert.equal(sample.blink, false);
        assert.equal(sample.animations, 0);
        assert.match(sample.classes, /xterm-cursor-bar/);
        assert.equal(sample.background, "rgba(0, 0, 0, 0)");
        assert.match(sample.shadow, /inset/, "caret remains visible");
      }
      assert.deepEqual(result.explicit, { style: "block", blink: false });
      assert.deepEqual(result.reset, { style: "bar", blink: false });
      assert.deepEqual(result.disposed, { style: "block", blink: true });
      console.log("terminal-cursor smoke: steady Codex caret survives redraws, default resets, blur and snapshot reset; explicit styles and disposal preserved");
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    } finally {
      win.destroy();
      app.quit();
    }
  });
}
