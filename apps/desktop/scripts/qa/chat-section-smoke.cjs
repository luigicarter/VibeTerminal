'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) { const end = Date.now() + 30000; while (Date.now() < end) { if (await fn()) return; await wait(100); } throw new Error('Timeout: ' + label); }
if (!process.versions.electron) {
  const { spawn } = require('node:child_process');
  const output = path.join(root, '.tmp', 'chat-section-smoke', Date.now() + '-' + process.pid);
  fs.mkdirSync(output, { recursive: true });
  const env = { ...process.env, VIBE_SCREENSHOT_MODE: '1', VIBE_INTERNAL_SCREENSHOT: '0', VIBE_SCREENSHOT_HIDDEN: '1', VIBE_SCREENSHOT_USER_DATA: path.join(output, 'userData'), VIBE_AGENT_SHIM_BASE_DIR: path.join(output, 'shims'), VIBE_SCREENSHOT_PTY_DEBUG: path.join(output, 'pty-events.jsonl') };
  for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GEMINI_CLI_HOME', 'QWEN_HOME', 'KIMI_CODE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME']) env[key] = path.join(output, key.toLowerCase());
  for (const key of Object.keys(env)) if (/API_KEY|AUTH_TOKEN/.test(key) || ['ELECTRON_RUN_AS_NODE', 'VITE_DEV_SERVER_URL', 'LINA_USER_DATA_DIR'].includes(key)) delete env[key];
  (async () => {
    for (const phase of ['seed', 'crash', 'recover']) {
      await new Promise((resolve, reject) => {
        const child = spawn(require('electron'), [__filename, phase, output, '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        const log = fs.createWriteStream(path.join(output, phase + '.log')); child.stdout.pipe(log); child.stderr.pipe(log);
        const timer = setTimeout(() => { child.kill(); reject(new Error('Electron fixture timeout: ' + output)); }, 60000);
        child.on('error', reject);
        child.on('exit', code => { clearTimeout(timer); code === (phase === 'crash' ? 17 : 0) ? resolve() : reject(new Error(phase + ': exit ' + code + '; see ' + output)); });
      });
      if (phase === 'crash') {
        const pid = Number(fs.readFileSync(path.join(output, 'fixture.pid'), 'utf8'));
        await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, 'crashed app retires its owned foreground process');
      }
    }
    console.log(JSON.stringify({ ok: true, output, processes: 3, realPty: true, liveProviderVerified: false }, null, 2));
  })().catch(error => { console.error(error); process.exitCode = 1; });
} else {
  const [phase, output] = process.argv.slice(2);
  const electron = require('electron'), { app, BrowserWindow, ipcMain } = electron;
  const Module = require('node:module'), originalLoad = Module._load;
  const facade = Object.create(electron), calls = [], fixtureWindows = [];
  let testing = false;
  const id = 'chat-fixture-A';
  const session = { id: 'saved-terminal', name: 'Terminal recovery conversation', kind: 'codex', command: 'codex', cwd: output, createdAt: 1, started: false, launchToken: 1, nextLaunchMode: 'resume', status: 'idle', threadRef: { provider: 'codex', id, title: 'Terminal recovery conversation', createdAt: 1, updatedAt: 2 } };
  const workspace = { workspaces: [{ id: 'chat-project', name: 'Chat project', path: output, sessions: [session] }], multiSessions: [], activeWorkspaceId: 'chat-project', activeView: 'project' };
  const home = process.env.CODEX_HOME, dir = path.join(home, 'sessions', '2026', '09', '13'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `rollout-${id}.jsonl`), [
    { type: 'session_meta', payload: { id, cwd: output, timestamp: '2026-09-13T00:00:00Z', source: 'cli' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Keep this conversation in terminal format.' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'This is the saved conversation, with its original native identity.' }] } }
  ].map(value => JSON.stringify(value)).join('\n') + '\n');
  const terminal = path.join(output, 'fixture-terminal.cjs');
  fs.writeFileSync(terminal, `require('node:fs').writeFileSync(${JSON.stringify(path.join(output, 'fixture.pid'))},String(process.pid));process.stdout.write('\\x1b[36mRecovered terminal chat\\x1b[0m\\r\\nNative conversation: ${id}\\r\\nSaved messages remain available after restart.\\r\\n> ');if(process.stdin.isTTY)process.stdin.setRawMode(true);process.stdin.on('data',data=>{if(data.includes(3))process.exit(0);process.stdout.write(data)});setInterval(()=>{},1000);`);
  async function inspect(win) {
    if (testing || win.webContents.getURL().includes('surface=')) return;
    testing = true;
    const evaluate = code => win.webContents.executeJavaScript(code, true);
    try {
      await until(() => evaluate('Boolean(document.querySelector(".chats-section"))'), 'Chats rendered');
      await wait(500);
      if (phase === 'seed') {
        await evaluate(`window.vibe.chats.checkpoint({clientId:'fixture-seed',sequence:1,workspace:${JSON.stringify(workspace)}})`);
        // Migration/restore now reads the database rather than an arbitrary localStorage rewrite.
        testing = false; phaseSeeded = true; win.reload(); return;
      }
      await exercise(win, evaluate);
    } catch (error) { fs.writeFileSync(path.join(output, phase + '.failure.txt'), error.stack); console.error(error); app.exit(1); }
  }
  let phaseSeeded = false;
  async function exercise(win, evaluate) {
    await until(async () => (await evaluate('window.vibe.chats.list()')).chats.some(row => row.conversation?.id === id), 'durable native chat');
    let data = await evaluate('window.vibe.chats.list()'); const chat = data.chats.find(row => row.conversation?.id === id);
    const owner = 'native:' + chat.nativeKey;
    if (phase === 'seed') {
      await evaluate(`document.querySelector('.chat-actions summary').click();Array.from(document.querySelectorAll('.chat-actions button')).find(button=>button.textContent==='Rename').click();`);
      await until(() => evaluate(`Boolean(document.querySelector('input[aria-label="Chat title"]'))`), 'rename form');
      await evaluate(`(()=>{const input=document.querySelector('input[aria-label="Chat title"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'Terminal recovery conversation');input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
      const current = (await evaluate('window.vibe.chats.list()')).chats[0];
      await evaluate(`window.vibe.chats.update({chatId:${JSON.stringify(chat.chatId)},revision:${current.revision},title:'Changed while editing'})`);
      await until(() => evaluate(`document.querySelector('.chat-title').textContent==='Changed while editing'`), 'metadata revision while editing');
      await evaluate(`document.querySelector('.chat-rename').requestSubmit()`);
      await until(() => evaluate(`!document.querySelector('.chat-rename') && document.querySelector('.chat-title').textContent==='Terminal recovery conversation'`), 'rename commits latest revision');
    }
    if (phase === 'crash') {
      await evaluate(`window.vibe.chats.update({chatId:${JSON.stringify(chat.chatId)},revision:${chat.revision},title:'Recovered terminal chat'})`);
      await evaluate(`window.vibe.chats.draft({owner:${JSON.stringify(owner)},text:'Unsent draft survives forced exit.',revision:1})`);
      await evaluate(`document.querySelector('.chat-open').click()`);
      await until(() => fs.existsSync(path.join(output, 'fixture.pid')), 'fixture agent running before forced exit');
      app.exit(17); return;
    }
    if (phase === 'recover') {
      const saved = await evaluate(`window.vibe.chats.bootstrap(null)`);
      assert.equal(saved.recoveryNeeded, true); assert.equal(saved.drafts[owner].text, 'Unsent draft survives forced exit.');
      assert.equal(chat.title, 'Recovered terminal chat');
      await evaluate(`window.__chatFixtureOutput=''; window.vibe.terminal.onEvent(event=>{if(event.id==='saved-terminal' && event.data)window.__chatFixtureOutput+=event.data;}); true;`);
      await evaluate(`document.querySelector('.chat-open').click()`);
      await until(() => calls.some(call => call.id === 'saved-terminal'), 'exact terminal resume');
      assert.match(calls[0].command, /codex resume chat-fixture-A/);
      await until(() => evaluate(`window.vibe.terminal.getRuntimeSnapshots().then(rows=>rows.some(row=>row.id==='saved-terminal' && row.processState==='running'))`), 'real PTY running');
      try { await until(() => evaluate(`window.__chatFixtureOutput.includes('Recovered terminal chat')`), 'live terminal output'); }
      catch (error) { fs.writeFileSync(path.join(output, 'terminal-diagnostics.json'), JSON.stringify(await evaluate(`Promise.all([window.vibe.chats.list(),window.vibe.terminal.getRuntimeSnapshots()]).then(([chats,runtime])=>({chats,runtime,output:window.__chatFixtureOutput,dom:document.querySelector('.terminal-board').textContent,stored:localStorage.getItem('vibe-terminal:workspaces:v2')}))`), null, 2)); throw error; }
      await until(() => evaluate(`!document.querySelector('.terminal-board').textContent.includes('paused')`), 'pane leaves paused state');
      await wait(300);
      fs.writeFileSync(path.join(output, 'terminal-output.txt'), await evaluate('window.__chatFixtureOutput'));
      const generation = (await evaluate('window.vibe.terminal.getRuntimeSnapshots()'))[0].generation;
      const pid = fs.readFileSync(path.join(output, 'fixture.pid'), 'utf8');
      win.reload();
      await until(() => evaluate(`Boolean(document.querySelector('.chat-open'))`), 'renderer reload');
      await until(() => evaluate(`window.vibe.terminal.getRuntimeSnapshots().then(rows=>rows.some(row=>row.id==='saved-terminal' && row.generation===${JSON.stringify(generation)}))`), 'renderer reuses existing generation');
      await wait(400);
      assert.equal(fs.readFileSync(path.join(output, 'fixture.pid'), 'utf8'), pid, 'renderer reload must not respawn the agent');
      const countBeforeFocus = calls.length;
      await evaluate(`document.querySelector('.chat-open').click()`); await wait(150);
      assert.equal(calls.length, countBeforeFocus, 'opening a living chat only focuses it');
      win.setSize(1180, 800); await wait(200);
      await win.webContents.capturePage().then(image => fs.writeFileSync(path.join(output, 'terminal-chat.png'), image.toPNG()));
      const history = await evaluate(`window.vibe.chats.read(${JSON.stringify(chat.chatId)})`);
      assert(history.messages.some(message => message.text.includes('terminal format')));
      assert.equal(history.recoveryCopy, false);
      // A native-store outage falls back to a labeled local copy, not a new agent.
      fs.renameSync(path.join(dir, `rollout-${id}.jsonl`), path.join(dir, `saved-${id}.unavailable`));
      const recoveredCopy = await evaluate(`window.vibe.chats.read(${JSON.stringify(chat.chatId)})`);
      assert.equal(recoveredCopy.recoveryCopy, true);
      data = await evaluate('window.vibe.chats.list()'); const updated = data.chats.find(row => row.chatId === chat.chatId);
      await evaluate(`window.vibe.chats.update({chatId:${JSON.stringify(chat.chatId)},revision:${updated.revision},archived:true})`);
      await until(() => evaluate('document.querySelectorAll(".chat-row").length === 0'), 'archive hides chat without closing terminal');
      assert.equal(fs.readFileSync(path.join(output, 'fixture.pid'), 'utf8'), pid, 'view/history/archive never create extra terminals');
    }
    win.setSize(900, 650); await wait(200);
    const bounds = await evaluate(`(()=>{const p=document.querySelector('.workspace-list').getBoundingClientRect(),c=document.querySelector('.chats-section').getBoundingClientRect(),f=document.querySelector('.sidebar-footer').getBoundingClientRect();return {projectBottom:p.bottom,chatTop:c.top,chatBottom:c.bottom,footerTop:f.top,chatHeight:c.height}})()`);
    assert(bounds.chatTop >= bounds.projectBottom); assert(bounds.chatBottom <= bounds.footerTop + 1); assert(bounds.chatHeight >= 160);
    assert(await evaluate(`document.querySelector('.chats-list').getBoundingClientRect().height >= 40`), 'chat list must leave room for visible rows');
    assert.equal((await evaluate('window.vibe.chats.list()')).chats.length, 1, 'paused placeholder must not duplicate the saved conversation');
    await evaluate(`document.querySelector('button[aria-label="New chat"]').click()`);
    await until(() => evaluate(`Boolean(document.querySelector('.chats-new-menu'))`), 'new chat picker');
    assert(await evaluate(`(()=>{const menu=document.querySelector('.chats-new-menu').getBoundingClientRect(),section=document.querySelector('.chats-section').getBoundingClientRect();return menu.bottom<=section.bottom+1 && menu.height>=32;})()`), 'provider picker must fit in a short sidebar');
    await evaluate(`document.querySelector('button[aria-label="New chat"]').click()`);
    await win.webContents.capturePage().then(image => fs.writeFileSync(path.join(output, phase + '-small.png'), image.toPNG()));
    fs.writeFileSync(path.join(output, phase + '.json'), JSON.stringify({ ok: true, bounds, calls }, null, 2));
    app.quit();
  }
  Object.defineProperty(facade, 'BrowserWindow', { value: class extends BrowserWindow {
    static getAllWindows() { return fixtureWindows.filter(window => !window.isDestroyed()); }
    constructor(options) { super({ ...options, show: false, minWidth: 500, minHeight: 450, webPreferences: { ...options.webPreferences, backgroundThrottling: false } }); fixtureWindows.push(this); this.webContents.on('did-finish-load', () => {
      if (phase === 'seed' && phaseSeeded) { if (!testing) { testing = true; void exercise(this, code => this.webContents.executeJavaScript(code, true)).catch(error => { console.error(error); app.exit(1); }); } }
      else void inspect(this);
    }); }
    show() {} showInactive() {} maximize() {} focus() {}
  } });
  Module._load = function(name, ...args) { return name === 'electron' ? facade : originalLoad.call(this, name, ...args); };
  const handle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, listener) => handle(channel, (event, payload) => {
    if (channel === 'terminal:create') { calls.push(payload); payload = { ...payload, command: `node '${terminal.replace(/'/g, "''")}'` }; }
    // Keep native discovery deterministic and avoid probing unrelated provider CLIs.
    if (channel === 'chats:refresh') return { warnings: [] };
    return listener(event, payload);
  });
  globalThis.fetch = async () => { throw new Error('Chat fixture blocks external network.'); };
  require(path.join(root, 'backend/main.cjs'));
}
