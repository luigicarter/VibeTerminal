'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..'), packaged = process.argv.includes('--packaged');
const packageDir = process.argv.find(value => value.startsWith('--package-dir='))?.slice(14) || (process.argv.includes('--package-dir') ? process.argv[process.argv.indexOf('--package-dir') + 1] : undefined);
const output = path.join(root, '.tmp/orchestrator-close-smoke', `${Date.now()}-${process.pid}`), userData = path.join(output, 'userData'), cwd = path.join(output, 'Close QA');
fs.mkdirSync(cwd, { recursive: true });
const report = { output, packaged, boundary: 'Hidden disposable application; real renderer/preload/main/native PTY. Frozen per-pane application dispatch, no model/group-intent or installed-app interaction.', checks: [] };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, timeout = 30000) { let error; for (const end = Date.now() + timeout; Date.now() < end;) { try { const value = await fn(); if (value) return value; } catch (e) { error = e; } await wait(120); } throw Error(`${label}: ${error?.message || 'timeout'}`); }
class Cdp {
  constructor(url) { this.ws = new WebSocket(url); this.pending = new Map(); this.n = 0; }
  async open() { await new Promise((resolve, reject) => { this.ws.addEventListener('open', resolve, { once: true }); this.ws.addEventListener('error', reject, { once: true }); }); this.ws.addEventListener('message', event => { const packet = JSON.parse(String(event.data)), item = this.pending.get(packet.id); if (item) { this.pending.delete(packet.id); clearTimeout(item.timer); packet.error ? item.reject(Error(packet.error.message)) : item.resolve(packet.result); } }); }
  send(method, params = {}) { return new Promise((resolve, reject) => { const id = ++this.n, timer = setTimeout(() => { this.pending.delete(id); reject(Error(`CDP timeout ${method}`)); }, 45000); this.pending.set(id, { resolve, reject, timer }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(expression) { const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails)); return result.result.value; }
  close() { for (const value of this.pending.values()) clearTimeout(value.timer); this.ws.close(); }
}
let child, cdp; const ownedRoots = [], ownedChildren = [];
const live = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
const record = (name, value) => { report.checks.push({ name, value }); console.log(name, JSON.stringify(value)); };
const dispatch = action => cdp.eval(`window.vibe.orchestrator.dispatch(${JSON.stringify(action)})`);
const inventory = () => cdp.eval("window.vibe.orchestrator.dispatch({kind:'list_sessions',limit:40}).then(()=>window.vibe.orchestrator.getState()).then(s=>s.sessions)");
const screenshot = async name => { let timer; try { const shot = await Promise.race([cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: false }), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Hidden capture unavailable')), 5000); })]); fs.writeFileSync(path.join(output, `${name}.png`), Buffer.from(shot.data, 'base64')); } catch { record(`${name}-screenshot`, 'Hidden compositor did not provide an image; functional acceptance continues.'); } finally { clearTimeout(timer); } };
(async () => { try {
  assert.equal(process.platform, 'win32');
  const port = await new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });
  const env = { ...process.env, VIBE_SCREENSHOT_MODE: '1', VIBE_SCREENSHOT_HIDDEN: '1', VIBE_INTERNAL_SCREENSHOT: '0', VIBE_SCREENSHOT_USER_DATA: userData,
    VIBE_AGENT_SHIM_BASE_DIR: path.join(output, 'shims'), CODEX_HOME: path.join(output, 'codex'), CLAUDE_CONFIG_DIR: path.join(output, 'claude'), XDG_CONFIG_HOME: path.join(output, 'config'), XDG_DATA_HOME: path.join(output, 'data') };
  for (const key of Object.keys(env)) if (/API_KEY|AUTH_TOKEN/.test(key) || ['ELECTRON_RUN_AS_NODE', 'VITE_DEV_SERVER_URL'].includes(key) || key.toLowerCase() === 'path') delete env[key];
  env.PATH = [path.join(process.env.SystemRoot, 'System32'), process.env.SystemRoot, path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0')].join(path.delimiter);
  env.VIBE_NODE_PATH = process.execPath; env.VIBE_TERMINAL_SHELL = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const executable = packaged ? path.join(packageDir || path.join(root, 'release/win-unpacked'), 'LinaTerminal.exe') : path.join(root, 'node_modules/electron/dist/electron.exe');
  child = spawn(executable, [...(packaged ? [] : ['.']), `--remote-debugging-port=${port}`, '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = fs.createWriteStream(path.join(output, 'electron.log')); child.stdout.pipe(log); child.stderr.pipe(log);
  const page = await until(async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(item => item.type === 'page' && item.url.startsWith('file:') && !item.url.includes('surface=voice')), 'renderer');
  cdp = new Cdp(page.webSocketDebuggerUrl); await cdp.open(); await cdp.send('Page.enable'); await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  await until(() => cdp.eval('Boolean(window.vibe?.orchestrator)'), 'preload');
  const dormant = Array.from({ length: 4 }, (_, i) => ({ id: `dormant-${i}`, name: `Dormant ${i + 1}`, kind: 'terminal', cwd, started: false, launchToken: 0, status: 'idle', createdAt: Date.now(), nextLaunchMode: 'new', layout: { x: (i % 2) * 50, y: Math.floor(i / 2) * 300, w: 48, h: 280, unit: 'fluid' } }));
  const workspace = { id: 'close-qa-project', name: 'Close QA', path: cwd, sessions: dormant };
  await cdp.eval(`localStorage.setItem('vibe-terminal:workspaces:v2',${JSON.stringify(JSON.stringify([workspace]))});localStorage.setItem('vibe-terminal:active-workspace:v1','close-qa-project');localStorage.setItem('vibe-terminal:active-view:v1','project');localStorage.setItem('vibe-terminal:multi-sessions:v1','[]');location.reload();void 0`);
  await until(async () => (await inventory()).filter(item => item.visiblePane && item.projectId === workspace.id).length === 4, 'four dormant inventory panes');
  for (let i = 0; i < 4; i++) {
    const result = await dispatch({ kind: 'create_session', kindOfSession: 'terminal', cwd }); assert.equal(result.ok, true, JSON.stringify(result));
    const current = await until(async () => (await inventory()).find(item => item.id === result.id && item.terminalPid > 0), 'running root'); ownedRoots.push(current.terminalPid);
    const pidFile = path.join(output, `child-${i}.txt`);
    const command = `$fixtureChild = Start-Process -FilePath '${env.VIBE_TERMINAL_SHELL.replace(/'/g, "''")}' -ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 300' -WindowStyle Hidden -PassThru; $fixtureChild.Id | Set-Content -LiteralPath '${pidFile.replace(/'/g, "''")}'`;
    // Startup output and board reflow can invalidate a read before dispatch.
    // Retry only an explicit zero-byte rejection, obtaining fresh evidence each
    // time. An accepted or uncertain submission must never be repeated.
    await until(async () => {
      const target = { id: current.id, generation: current.generation };
      const read = await dispatch({ kind: 'read_session', target });
      if (!read.ok || read.observation?.cursorVisible === false || !read.observation?.cursorLine?.beforeCursor?.trimEnd().endsWith('>')) return false;
      const sent = await dispatch({ kind: 'send_prompt', target, text: command });
      if (sent.ok === false && sent.status === 'stale-observation' && sent.delivery === 'not-dispatched') return false;
      assert.equal(sent.ok, true, JSON.stringify(sent));
      return true;
    }, 'PowerShell fixture command accepted');
    const descendant = await until(() => fs.existsSync(pidFile) && Number(fs.readFileSync(pidFile, 'utf8').replace(/^\uFEFF/, '').trim()), 'fixture child pid'); assert(descendant > 0); ownedChildren.push(descendant);
  }
  const frozen = (await inventory()).filter(item => item.visiblePane && item.projectId === workspace.id);
  assert.equal(frozen.length, 8); assert.equal(frozen.filter(item => item.started === false).length, 4); record('frozen-inventory', frozen.map(({ id, generation, launchToken, terminalPid, started }) => ({ id, generation, launchToken, terminalPid, started })));
  await screenshot('before');
  const receipts = []; let newcomer;
  for (const [index, target] of frozen.entries()) {
    const receipt = await dispatch({ kind: 'close', targetId: target.id, target: { id: target.id, generation: target.generation, launchToken: target.launchToken } });
    receipts.push(receipt); assert.equal(receipt.ok, true, JSON.stringify(receipt)); assert.equal(receipt.close.launchSettled, true); assert(['stopped', 'already-absent'].includes(receipt.close.process));
    if (index === 0) { newcomer = await dispatch({ kind: 'create_session', kindOfSession: 'terminal', cwd }); assert.equal(newcomer.ok, true); }
  }
  record('exact-close-receipts', receipts);
  await until(() => [...ownedRoots, ...ownedChildren].every(pid => !live(pid)), 'all original roots and descendants gone');
  const remaining = await until(async () => { const entries = (await inventory()).filter(item => item.visiblePane && item.projectId === workspace.id); return entries.length === 1 && entries[0].id === newcomer.id && entries; }, 'settled authoritative pane inventory');
  assert.deepEqual(remaining.map(item => item.id), [newcomer.id]);
  const uiIds = await cdp.eval('Array.from(document.querySelectorAll("[data-pane-id]"),e=>e.dataset.paneId)'); assert(frozen.every(target => !uiIds.includes(target.id)));
  await screenshot('after'); await wait(2000);
  const snapshots = await cdp.eval('window.vibe.terminal.getRuntimeSnapshots()');
  assert(dormant.every(target => !snapshots.some(item => item.id === target.id && item.processState === 'running')));
  record('verified-removal-and-process-stop', { originalPaneCount: 8, rootsStopped: ownedRoots.length, descendantsStopped: ownedChildren.length, newcomerPreserved: remaining[0].id, dormantLateStarts: 0 });
  report.pass = true;
} catch (error) { report.pass = false; report.error = error.stack; console.error(error.stack); process.exitCode = 1; }
finally {
  try { cdp?.close(); } catch {}
  if (child?.pid && child.exitCode === null) spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
  // These PIDs came exclusively from fixture-created root/child processes.
  for (const pid of [...ownedRoots, ...ownedChildren]) if (live(pid)) spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2)); console.log(`Artifacts: ${output}`);
}
})();
