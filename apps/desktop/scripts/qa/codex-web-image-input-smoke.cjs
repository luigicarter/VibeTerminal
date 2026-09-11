'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('electron'), [__filename], { env, windowsHide: true, stdio: 'inherit' });
  child.on('exit', code => { process.exitCode = code || 0; });
} else {
  const { app, BrowserWindow, ipcMain, nativeImage } = require('electron'), pty = require('node-pty'), ts = require('typescript');
  const output = fs.mkdtempSync(path.join(root, '.tmp/codex-web-image-input-')); app.setPath('userData', output);
  let terminal, win, host, raw = '', finished = false, terminalExited = false;
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const finish = async error => { if (finished) return; finished = true; if (terminal && !terminalExited) { terminal.write('\x04'); await pause(700); if (!terminalExited) { try { process.kill(terminal.pid); } catch {} } } await host?.shutdown(); win?.destroy(); if (error) console.error(error.stack); app.exit(error ? 1 : 0); };
  app.whenReady().then(async () => {
    const image = nativeImage.createFromBitmap(Buffer.alloc(64 * 64 * 4, 180), { width: 64, height: 64 });
    const file = path.join(output, 'dropped image.png'); fs.writeFileSync(file, image.toPNG());
    host = require('../../backend/codexWebHost.cjs').createCodexWebHost({ app, shell: {}, clipboard: { readImage: () => image }, broadcast() {}, resolveCodexBin() { throw new Error('No browser or model should start for attachments.'); }, globalCodexHome: path.join(output, 'unused') });
    await host.action({ id: 'fixture', launchToken: 1, action: 'start', cwd: output });
    ipcMain.handle('fixture:image', (_event, payload) => host.action(payload));
    ipcMain.on('fixture:input', (_event, data) => terminal.write(data));
    const home = path.join(output, 'native'); fs.mkdirSync(home);
    const templateFile = path.join(root, 'vendor/codex-official/codex-rs/models-manager/models.json');
    const source = JSON.parse(fs.readFileSync(templateFile)), template = (source.models || source).find(model => model.visibility === 'list');
    const catalog = path.join(home, 'catalog.json'), model = 'chatgpt-web/image-input-fixture';
    fs.writeFileSync(catalog, JSON.stringify({ models: [{ ...template, slug: model, display_name: 'Image fixture', input_modalities: ['text', 'image'], supported_in_api: true }] }));
    fs.writeFileSync(path.join(home, 'config.toml'), require('@iarna/toml').stringify({ features: { apps: false, plugins: false }, projects: { [output]: { trust_level: 'trusted' } } }));
    win = new BrowserWindow({ show: false, width: 1150, height: 680, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false, offscreen: true } });
    win.webContents.on('console-message', event => { if (/Error|ENOENT|SyntaxError|ReferenceError/.test(event.message)) console.error(event.message); });
    await win.loadURL('about:blank');
    const moduleCode = ts.transpileModule(fs.readFileSync(path.join(root, 'frontend/terminalImages.ts'), 'utf8'), { compilerOptions: { module: 1, target: 9 } }).outputText;
    await win.webContents.executeJavaScript(`(() => {
      const { ipcRenderer } = require('electron');
      const { Terminal } = require(${JSON.stringify(require.resolve('@xterm/xterm'))});
      document.body.style.background = '#17181c';
      const style = document.createElement('style'); style.textContent = require('fs').readFileSync(${JSON.stringify(path.join(path.dirname(require.resolve('@xterm/xterm')), '../css/xterm.css'))}, 'utf8'); document.head.append(style);
      const el = document.createElement('div'); document.body.append(el);
      window.term = new Terminal({ cols: 110, rows: 34, theme: { background: '#17181c' } }); term.open(el); term.onData(data => ipcRenderer.send('fixture:input', data));
      ipcRenderer.on('fixture:data', (_event, data) => term.write(data));
      const exports = {}; new Function('exports', ${JSON.stringify(moduleCode)})(exports);
      window.attach = paths => exports.attachTerminalImages({ pane: { id: 'fixture', launchToken: 1 }, paths, action: payload => ipcRenderer.invoke('fixture:image', payload), isCurrent: () => true, paste: text => term.paste(text), onError: message => { throw new Error(message); } });
      exports.bindTerminalImageDrop(el, { enabled: () => true, filePath: () => ${JSON.stringify(file)}, drop: paths => { window.dropResult = attach(paths); } });
      window.dropImage = async () => {
        const dataTransfer = new DataTransfer(); dataTransfer.items.add(new File(['fixture'], 'dropped image.png', { type: 'image/png' }));
        const event = new DragEvent('drop', { dataTransfer, bubbles: true, cancelable: true }); el.dispatchEvent(event);
        if (!event.defaultPrevented) throw new Error('File drop was not handled'); await window.dropResult;
      };
      window.screenText = () => Array.from({length: term.buffer.active.length}, (_, i) => term.buffer.active.getLine(i)?.translateToString(true) || '').join('\\n');
    })()`);
    const { nativeArgs, privateNativeEnv, resolveNativeBinary } = require('../../backend/codexWebNative.cjs');
    terminal = pty.spawn(resolveNativeBinary({ root }), nativeArgs({ route: 'http://127.0.0.1:1/v1', catalogPath: catalog, model }, ['-c', 'cli_auth_credentials_store="ephemeral"']), { cwd: output, name: 'xterm-256color', cols: 110, rows: 34, env: privateNativeEnv({ ...process.env, CODEX_HOME: home }) });
    terminal.onData(data => { raw += data; win.webContents.send('fixture:data', data); });
    terminal.onExit(() => { terminalExited = true; });
    const deadline = Date.now() + 20000; while (!/model:/.test(raw.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ''))) { if (Date.now() > deadline) throw new Error('Native TUI did not become ready'); await pause(100); }
    while (!await win.webContents.executeJavaScript('term.modes.bracketedPasteMode')) { if (Date.now() > deadline) throw new Error('Native TUI did not enable bracketed paste'); await pause(100); }
    while (!await win.webContents.executeJavaScript('screenText().includes("›")')) { if (Date.now() > deadline) throw new Error('Native image composer did not become ready'); await pause(100); }
    // Let the CLI finish initial capability discovery after drawing its header.
    await pause(1000);
    await win.webContents.executeJavaScript('attach()'); await pause(400);
    await win.webContents.executeJavaScript('dropImage()'); await pause(800);
    const screen = await win.webContents.executeJavaScript('screenText()');
    fs.writeFileSync(path.join(output, 'terminal.txt'), screen);
    assert.match(screen, /\[Image #1\]/); assert.match(screen, /\[Image #2\]/);
    assert.ok(!screen.includes('Failed to paste image'));
    await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    fs.writeFileSync(path.join(output, 'terminal.png'), (await win.webContents.capturePage()).toPNG());
    console.log(JSON.stringify({ passed: true, output, nativeCli: '0.154.0', clipboardImage: true, fileDrop: true, sentModelRequest: false, modifiedSystemClipboard: false }));
    await finish();
  }).catch(finish);
  setTimeout(() => void finish(new Error('Image input smoke timed out')), 35000);
}
