'use strict';
// Run with: node scripts/diag/performance-memory-audit-electron.cjs
// The fixture owns a hidden blank window and a disposable profile only.
if (!process.versions.electron) {
  const { spawn } = require('node:child_process');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename], { env, windowsHide: true, stdio: 'inherit' });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), { performance } = require('node:perf_hooks');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, '.tmp/performance-memory-audit', `electron-${Date.now()}-${process.pid}`);
fs.mkdirSync(output, { recursive: true }); app.setPath('userData', output);
const { createTerminalObservation } = require('../../backend/terminalObservation.cjs');
const { createTerminalHistory } = require('../../backend/terminalHistory.cjs');
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
  await window.loadURL('data:text/html,<html><body>Offline performance fixture</body></html>');
  const results = [];
  for (const count of [500, 2000]) {
    const observer = createTerminalObservation(), history = createTerminalHistory(100, 28);
    try {
      await observer.ingest({ type: 'created', id: 'pane', generation: 'g', cols: 100, rows: 28 });
      const chunks = Array.from({ length: count }, (_, i) => `\x1b[Hframe-${i} ${'x'.repeat(72)}`);
      let pending; const start = performance.now();
      for (let i = 0; i < count; i++) pending = observer.ingest({ type: 'data', id: 'pane', generation: 'g', data: chunks[i], sequence: i + 1 });
      await pending; const observationDrainMs = performance.now() - start;
      const fastStart = performance.now();
      for (const chunk of chunks) history.write(chunk);
      await new Promise(resolve => history.snapshot(resolve));
      results.push({ chunks: count, bytes: Buffer.byteLength(chunks.join('')), observationDrainMs, coalescingHistoryDrainMs: performance.now() - fastStart });
    } finally { observer.dispose(); history.dispose(); }
  }
  const report = { electron: process.versions.electron, node: process.versions.node, results,
    boundary: 'Isolated Electron main process with a hidden blank window and disposable profile. Real production decoders; synthetic output; no PTY or provider.', output };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report)); app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
}
