'use strict';
// Build first, then: node scripts/qa/session-resume-smoke.cjs
// Real renderer/preload + disk localStorage across two clean Electron exits.
// Provider starts and thread confirmation are fixtures: no live account/CLI required.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const storageKey = 'vibe-terminal:workspaces:v2';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) { if (await fn()) return; await wait(100); }
  throw Error(`Timeout: ${label}`);
}

function fixture(cwd) {
  const kinds = ['claude', 'codex', 'cursor', 'gemini', 'grok', 'opencode', 'kimi', 'kimi-custom', 'qwen'];
  const declared = Object.entries(require('../../shared/providerCapabilities.json')).filter(([, c]) => c.threaded).map(([k]) => k);
  assert.deepEqual([...kinds].sort(), declared.sort(), 'Add resume expectations for any new threaded provider');
  const specs = kinds.map(kind => ({ id: kind, kind }));
  specs.push({ id: 'codex-twin', kind: 'codex' },
    { id: 'fusion-claude', kind: 'claude', fusion: true, fusionPlannerFamily: 'claude', fusionExecutorFamily: 'codex' },
    { id: 'fusion-codex', kind: 'claude', fusion: true, fusionPlannerFamily: 'codex', fusionExecutorFamily: 'claude' },
    { id: 'openfusion', kind: 'opencode', openFusion: true, openFusionPlannerModel: 'fixture/brain', openFusionExecutorModel: 'fixture/executor' });
  // Every kind also has a deliberately paused pane that must never be launched.
  specs.push(...specs.map(s => ({ ...s, id: `${s.id}-paused`, paused: true })));
  return specs.map((spec, index) => ({
    ...spec, name: spec.id, cwd, command: spec.kind, createdAt: 1700000000000,
    started: !spec.paused, status: index % 2 ? 'done' : 'waiting', launchToken: 3,
    nextLaunchMode: 'new', // Saved launch intent is stale; the current ID is authoritative.
    threadRef: { provider: spec.fusionPlannerFamily || spec.kind, id: `current-${spec.id}`, createdAt: 1700000000000, updatedAt: 1700000000001 },
    resumeRef: { provider: spec.fusionPlannerFamily || spec.kind, id: `older-${spec.id}`, createdAt: 1690000000000, updatedAt: 1690000000001 },
    layout: { x: (index % 3) * 33, y: Math.floor(index / 3) * 320, w: 33, h: 300, unit: 'fluid' }
  }));
}

function verify(sessions, persisted, calls) {
  const prefixes = { claude: 'claude --resume', codex: 'codex resume', cursor: 'cursor-agent --resume', gemini: 'gemini --resume', grok: 'grok --resume', opencode: 'opencode --session', kimi: 'kimi --session', 'kimi-custom': 'kimi-custom --session', qwen: 'qwen --resume' };
  for (const session of sessions) {
    const saved = persisted.flatMap(w => w.sessions).find(s => s.id === session.id);
    assert(saved, `${session.id}: persisted pane`);
    const starts = calls.filter(c => c.payload.id === session.id && ['terminal:create', 'fusion-chat:start', 'openfusion-chat:start'].includes(c.channel));
    if (session.paused) { assert.equal(starts.length, 0, `${session.id}: no paused launch`); continue; }
    assert.equal(saved.threadRef?.id, session.threadRef.id, `${session.id}: current ID survives`);
    assert.equal(saved.resumeRef?.id, session.resumeRef.id, `${session.id}: older history stays separate`);
    assert(starts.length > 0, `${session.id}: launched`);
    for (const start of starts) {
      if (session.fusion || session.openFusion) {
        assert.equal(start.channel, session.fusion ? 'fusion-chat:start' : 'openfusion-chat:start');
        assert.equal(start.payload.resumeId, session.threadRef.id, `${session.id}: exact native resume ID`);
        if (session.fusion) assert.equal(start.payload.plannerFamily, session.fusionPlannerFamily);
      } else {
        assert.equal(start.channel, 'terminal:create');
        assert.equal(start.payload.command, `${prefixes[session.kind]} ${session.threadRef.id}${session.kind === 'opencode' ? ' --auto' : ''}`, `${session.id}: exact CLI resume command`);
      }
    }
    if (session.fusionPlannerFamily !== 'codex') {
      assert(calls.some(c => c.channel === 'agent-thread:latest' && c.payload.confirmId === session.threadRef.id), `${session.id}: exact thread confirmation`);
    }
  }
}

if (!process.versions.electron) {
  const { spawn } = require('node:child_process');
  const output = path.join(root, '.tmp', 'session-resume-smoke', `${Date.now()}-${process.pid}`);
  fs.mkdirSync(output, { recursive: true });
  const env = { ...process.env, VIBE_SCREENSHOT_MODE: '1', VIBE_INTERNAL_SCREENSHOT: '0', VIBE_SCREENSHOT_USER_DATA: path.join(output, 'userData'), VIBE_AGENT_SHIM_BASE_DIR: path.join(output, 'shims') };
  for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GEMINI_CLI_HOME', 'QWEN_HOME', 'KIMI_CODE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME']) env[key] = path.join(output, key.toLowerCase());
  for (const key of Object.keys(env)) if (/API_KEY|AUTH_TOKEN/.test(key) || ['ELECTRON_RUN_AS_NODE', 'VITE_DEV_SERVER_URL'].includes(key)) delete env[key];
  (async () => {
    const sessions = fixture(output); // Fail provider-coverage assertions in Node, before spawning Electron.
    assert(fs.existsSync(path.join(root, 'dist/index.html')), 'Build renderer first: npm run build');
    for (const phase of ['seed', 'reopen']) {
      await new Promise((resolve, reject) => {
        const child = spawn(require('electron'), [__filename, phase, output, '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        const log = fs.createWriteStream(path.join(output, `${phase}.log`));
        child.stdout.pipe(log); child.stderr.pipe(log);
        const timer = setTimeout(() => { child.kill(); reject(Error(`${phase}: Electron timeout; see ${output}`)); }, 60000);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(Error(`${phase}: exit ${code}; see ${output}`)); });
      });
    }
    console.log(JSON.stringify({ ok: true, output, processes: 2, panes: sessions.length, liveProviderVerified: false }, null, 2));
  })().catch(error => { console.error(error); process.exitCode = 1; });
} else {
  const [phase, output] = process.argv.slice(2);
  const electron = require('electron');
  const { app, ipcMain, BrowserWindow } = electron;
  process.on('uncaughtException', error => { console.error(error); app.exit(1); });
  const Module = require('node:module');
  const originalLoad = Module._load;
  const facade = Object.create(electron);
  const sessions = fixture(output);
  const calls = [];
  let seeded = false, testing = false;
  async function inspect(win) {
    if (testing || win.webContents.getURL().includes('surface=')) return;
    testing = true;
    try {
      await until(() => win.webContents.executeJavaScript('Boolean(window.vibe && document.querySelector("#root")?.childElementCount)'), 'renderer ready');
      if (phase === 'seed' && !seeded) {
        seeded = true;
        const workspaces = [{ id: 'resume-qa', name: 'Resume QA', path: output, sessions }];
        await win.webContents.executeJavaScript(`localStorage.setItem(${JSON.stringify(storageKey)}, ${JSON.stringify(JSON.stringify(workspaces))}); localStorage.setItem('vibe-terminal:active-workspace:v1', 'resume-qa'); localStorage.setItem('vibe-terminal:active-view:v1', 'project');`);
        calls.length = 0; testing = false; win.reload(); return;
      }
      await until(() => sessions.filter(s => !s.paused).every(s => calls.some(c => c.payload.id === s.id && ['terminal:create', 'fusion-chat:start', 'openfusion-chat:start'].includes(c.channel))), 'all restored launch boundaries');
      await wait(500);
      const persisted = await win.webContents.executeJavaScript(`JSON.parse(localStorage.getItem(${JSON.stringify(storageKey)}))`);
      verify(sessions, persisted, calls);
      fs.writeFileSync(path.join(output, `${phase}.json`), JSON.stringify({ ok: true, calls, persisted }, null, 2));
      await win.webContents.session.flushStorageData();
      app.quit();
    } catch (error) {
      fs.writeFileSync(path.join(output, `${phase}.failure.json`), JSON.stringify({ error: error.stack, calls }, null, 2));
      console.error(error); app.exit(1);
    }
  }
  Object.defineProperty(facade, 'BrowserWindow', { value: class extends BrowserWindow {
    constructor(options) { super({ ...options, show: false }); this.webContents.on('did-finish-load', () => void inspect(this)); }
    show() {} showInactive() {} maximize() {} restore() {} focus() {}
  } });
  Module._load = function(name, ...args) { return name === 'electron' ? facade : originalLoad.call(this, name, ...args); };
  const handle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, listener) => handle(channel, async (event, payload = {}) => {
    if (['terminal:create', 'fusion-chat:start', 'openfusion-chat:start', 'agent-thread:latest'].includes(channel)) {
      calls.push({ channel, payload });
      if (channel === 'agent-thread:latest') return payload.confirmId ? { status: 'found', thread: { provider: payload.provider, id: payload.confirmId, createdAt: 1700000000000, updatedAt: 1700000000001 } } : { status: 'missing' };
      return { ok: true, generation: `fixture-${payload.id}`, launchToken: payload.launchToken };
    }
    if (channel === 'fusion-model-catalog:list') return { ok: true, family: payload.family, models: [] };
    if (channel === 'openfusion-chat:providers') return { ok: true, providers: [], connected: [] };
    if (channel === 'agent-thread:list') return { threads: [] };
    return listener(event, payload);
  });
  globalThis.fetch = async () => { throw Error('Session resume fixture blocks external network'); };
  require('../../backend/main.cjs');
}
