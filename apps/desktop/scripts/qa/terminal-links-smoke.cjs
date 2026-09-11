'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../..');

if (!process.versions.electron) {
  const { spawn } = require('node:child_process');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename], { env, stdio: 'inherit', windowsHide: true });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, ipcMain } = require('electron');
  const ts = require('typescript');
  app.setPath('userData', path.join(root, '.tmp', `terminal-links-${process.pid}`));
  app.whenReady().then(async () => {
    const win = new BrowserWindow({ show: false, webPreferences: {
      offscreen: true, nodeIntegration: true, contextIsolation: false, backgroundThrottling: false
    } });
    const timeout = setTimeout(() => { console.error('Terminal links smoke timed out'); app.exit(1); }, 20000);
    try {
      await win.loadURL('about:blank');
      const source = fs.readFileSync(path.join(root, 'backend/main.cjs'), 'utf8');
      const policyStart = source.indexOf('  mainWindow.webContents.setWindowOpenHandler(');
      const policyEnd = source.indexOf('  installApplicationMenu(mainWindow);', policyStart);
      const openerStart = source.indexOf('async function openExternalUrl(');
      const openerEnd = source.indexOf('\nipcMain.handle("openfusion-chat:auth-remove"', openerStart);
      assert(policyStart >= 0 && policyEnd > policyStart && openerStart >= 0 && openerEnd > openerStart);
      const opened = [];
      vm.runInNewContext(source.slice(openerStart, openerEnd) + source.slice(policyStart, policyEnd), {
        URL, ipcMain, mainWindow: win,
        // Exercise real Electron navigation/IPC while recording the OS handoff.
        shell: { openExternal: async url => { opened.push(url); } }
      });
      const compiled = ts.transpileModule(fs.readFileSync(path.join(root, 'frontend/terminalLinks.ts'), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
      }).outputText;
      const result = await win.webContents.executeJavaScript(`(async () => {
        const assert = require('node:assert/strict');
        const { ipcRenderer } = require('electron');
        const exports = {};
        new Function('require', 'exports', ${JSON.stringify(compiled)})(
          id => require(${JSON.stringify(path.join(root, 'node_modules'))} + '/' + id), exports);
        const { Terminal } = require(${JSON.stringify(path.join(root, 'node_modules/@xterm/xterm'))});
        const pending = [];
        window.vibe = { openFusionChat: { openExternal: url => {
          const result = ipcRenderer.invoke('app:open-external', { url }); pending.push(result); return result;
        } } };
        let popups = 0;
        const originalOpen = window.open;
        const originalConfirm = window.confirm;
        window.confirm = () => true;
        window.open = () => { popups++; return { location: {} }; };
        const term = new Terminal({ cols: 100, rows: 10 });
        const host = document.createElement('div'); document.body.append(host); term.open(host);
        const write = text => new Promise(resolve => term.write(text, resolve));
        const links = async row => (await Promise.all(term._core._linkProviderService.linkProviders.map(
          provider => new Promise(resolve => provider.provideLinks(row, value => resolve(value || [])))
        ))).flat();
        const oscUrl = 'https://example.com/login?state=fixture#return';
        const plainUrl = 'http://localhost:3000/preview';
        const hyperlink = url => '\\x1b]8;;' + url + '\\x1b\\\\Visit website\\x1b]8;;\\x1b\\\\';
        await write(hyperlink(oscUrl) + '\\r\\n' + plainUrl + '\\r\\n' + hyperlink('file:///C:/private.txt'));
        const originalLink = (await links(1))[0];
        assert(originalLink, 'real xterm OSC 8 provider must discover the labeled hyperlink');
        originalLink.activate(new MouseEvent('click'), originalLink.text);
        assert.equal(popups, 1, 'control reproduces xterm default window.open');
        exports.configureTerminalLinks(term);
        for (const [row, url] of [[1, oscUrl], [2, plainUrl]]) {
          const found = (await links(row)).filter(link => link.text === url);
          assert.equal(found.length, 1);
          const event = new MouseEvent('click', { cancelable: true });
          found[0].activate(event, found[0].text);
          assert.equal(event.defaultPrevented, true);
        }
        assert.equal((await links(3)).length, 0, 'file hyperlinks stay disabled');
        const results = await Promise.all(pending);
        assert(results.every(result => result.ok));
        assert.equal(popups, 1, 'fixed plain and OSC 8 links never call window.open');
        const imageName = 'image-0123456789abcdef0123.png', imageOpens = [];
        await write('\\r\\n界 ' + imageName);
        assert.equal((await links(4)).length, 0, 'ordinary terminals do not gain generated-image actions');
        exports.configureTerminalLinks(term, name => imageOpens.push(name));
        const imageLink = (await links(4)).find(link => link.text === imageName);
        assert(imageLink, 'generated image filename is clickable in a Codex Web terminal');
        assert.equal(imageLink.range.start.x, 4, 'link columns account for wide characters');
        assert.equal(imageOpens.length, 0, 'generating output never opens an external app automatically');
        imageLink.activate(new MouseEvent('click'), imageName);
        assert.deepEqual(imageOpens, [imageName]);
        term.dispose(); host.remove();
        window.open = originalOpen; window.confirm = originalConfirm;
        return { oscUrl, plainUrl };
      })()`);
      assert.deepEqual(opened, [result.oscUrl, result.plainUrl]);
      await win.webContents.executeJavaScript("window.open('https://example.com/popup', '_blank'); true;", true);
      assert.deepEqual(opened, [result.oscUrl, result.plainUrl, 'https://example.com/popup']);
      const navigated = new Promise(resolve => win.webContents.once('will-navigate', resolve));
      await win.webContents.executeJavaScript("location.href = 'https://example.com/navigation'; true;");
      await navigated;
      assert.equal(opened.at(-1), 'https://example.com/navigation');
      assert.equal(win.webContents.getURL(), 'about:blank');
      assert.equal(BrowserWindow.getAllWindows().length, 1);
      console.log('Terminal links smoke passed: real OSC 8/plain URLs, IPC, popup and navigation route to browser; no extra Electron windows. OS browser launch was stubbed.');
    } catch (error) {
      console.error(error); process.exitCode = 1;
    } finally {
      clearTimeout(timeout);
      win.destroy(); app.exit(process.exitCode || 0);
    }
  });
}
