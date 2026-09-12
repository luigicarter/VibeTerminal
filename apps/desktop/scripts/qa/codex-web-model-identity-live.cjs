'use strict';
// Opt-in account test of server-reported models, not assistant self-identification.
// Uses the preview login and isolated native history through the real bridge/CLI.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '../..');
if (!process.argv.includes('--live')) throw new Error('Pass --live to test server-reported models using the saved preview ChatGPT account.');
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename, '--live', ...(process.argv.includes('--tools') ? ['--tools'] : [])], { env, windowsHide: true, stdio: 'inherit' });
  child.once('error', error => { console.error(error.message); process.exitCode = 1; });
  child.once('exit', code => { process.exitCode = code || 0; });
} else {
  const { app } = require('electron');
  const { createCodexWebHost } = require('../../backend/codexWebHost.cjs');
  const { nativeArgs, privateNativeEnv, resolveNativeBinary } = require('../../backend/codexWebNative.cjs');
  const profile = path.join(process.env.APPDATA, 'vibe-terminal-codex-web-preview');
  const output = fs.mkdtempSync(path.join(root, '.tmp/codex-web-identity-live-'));
  const nativeHome = path.join(output, 'native'); fs.mkdirSync(nativeHome);
  if (process.argv.includes('--tools')) {
    const TOML = require('@iarna/toml'), cfg = TOML.parse(fs.readFileSync(path.join(profile, 'codex-web/codex-home/config.toml'), 'utf8'));
    const policy = Object.fromEntries(['sandbox_mode', 'approval_policy', 'windows', 'sandbox_workspace_write'].filter(key => cfg[key] !== undefined).map(key => [key, cfg[key]]));
    fs.writeFileSync(path.join(nativeHome, 'config.toml'), TOML.stringify(policy));
  }
  app.setPath('userData', path.join(output, 'electron'));
  const nativeBin = resolveNativeBinary({ root });
  const globalHome = process.env.CODEX_HOME || path.join(process.env.USERPROFILE, '.codex');
  const protectedFiles = [path.join(globalHome, 'config.toml'), path.join(globalHome, 'auth.json'), path.join(profile, 'codex-web/codex-home/auth.json')];
  const digest = file => fs.existsSync(file) ? createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null;
  const before = protectedFiles.map(digest);
  let host, currentChild;
  const results = [];
  async function turn(state, model, effort, prompt, threadId, expectedResponse, blocked = false, toolTurn = false) {
    const startedAt = Date.now();
    const catalogPath = path.join(nativeHome, 'catalog.json');
    fs.copyFileSync(state.catalogPath, catalogPath);
    const args = nativeArgs({ route: state.route, catalogPath, model, effort }, [
      'exec', ...(threadId ? ['resume', threadId] : []), '--json', '--skip-git-repo-check',
      '-c', 'cli_auth_credentials_store="ephemeral"', '-c', 'features.apps=false', '-c', 'features.plugins=false',
      '-c', 'web_search="disabled"', prompt,
    ]);
    const child = spawn(nativeBin, args, { cwd: output, env: privateNativeEnv({ ...process.env, CODEX_HOME: nativeHome }), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    currentChild = child;
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-4000); });
    const receipts = new Map();
    const receiptFile = path.join(profile, 'codex-web/bridge/lina-last-model-request.json');
    const observe = () => { try { const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8')); if (Date.parse(receipt.time) >= startedAt) receipts.set(receipt.requestId, receipt); } catch {} };
    const poll = setInterval(observe, 100);
    const timer = setTimeout(() => child.kill(), toolTurn ? 300000 : 150000);
    let code;
    try { code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); }); }
    finally { observe(); clearInterval(poll); clearTimeout(timer); child.stdout.destroy(); child.stderr.destroy(); currentChild = null; }
    const events = stdout.trim().split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    fs.writeFileSync(path.join(output, `turn-${results.length + 1}.json`), JSON.stringify(events, null, 2));
    const started = events.find(event => event.type === 'thread.started');
    const answer = events.filter(event => event.type === 'item.completed' && event.item?.type === 'agent_message').map(event => event.item.text).join('\n');
    const toolEvents = events.filter(event => event.type === 'item.completed' && ['command_execution', 'mcp_tool_call', 'file_change', 'web_search', 'collab_tool_call'].includes(event.item?.type));
    if (toolTurn) assert(toolEvents.length > 0, 'Local work must reach a native tool, not only ChatGPT cloud tools.');
    else assert.equal(toolEvents.length, 0, 'The arithmetic test should not need tool calls.');
    const receipt = JSON.parse(fs.readFileSync(path.join(profile, 'codex-web/bridge/lina-last-model-request.json'), 'utf8'));
    const selected = JSON.parse(fs.readFileSync(catalogPath, 'utf8')).models.find(row => row.slug === model);
    assert.equal(receipt.model, selected._lina_web_slug);
    assert(Date.parse(receipt.time) >= startedAt, 'The response receipt belongs to an older request.');
    assert.equal(receipt.requestVerified, true);
    const expectedModels = Array.isArray(expectedResponse) ? expectedResponse : [expectedResponse];
    assert(receipt.responseModels.length > 0 && receipt.responseModels.every(value => expectedModels.includes(value)), 'Unexpected response model: ' + JSON.stringify(receipt.responseModels));
    if (blocked) {
      assert.notEqual(code, 0); assert.equal(answer, '', 'A mismatched answer leaked into the native conversation.');
      assert.equal(receipt.responseVerified, false); assert.equal(receipt.responseError, 'model_response_mismatch');
      assert.match(JSON.stringify(events), /different model|model_response_mismatch/);
      assert.doesNotMatch(JSON.stringify(events), /Reconnecting/, 'A rejected model must not cause native stream retries.');
    } else {
      assert.equal(code, 0, 'Native turn failed: ' + (events.find(event => event.type === 'error')?.message || stderr.slice(-1000)));
      assert.equal(receipt.responseVerified, true); if (!toolTurn) assert.match(answer, /\b703\b/);
    }
    const verified = [...receipts.values()].filter(row => row.responseVerified);
    if (toolTurn) {
      assert(verified.length >= 2, 'A local tool round and final answer must both be verified.');
      assert(verified.every(row => row.model === selected._lina_web_slug && row.responseModels.every(value => expectedModels.includes(value))));
      const conversations = [...new Set(verified.map(row => row.conversationId).filter(Boolean))];
      assert.equal(conversations.length, 1, 'Native tool rounds must reuse one Work conversation.');
    }
    const result = { model, effort, threadId: started?.thread_id || threadId, answer, blocked, requestedModel: receipt.model, responseModels: receipt.responseModels, responseVerified: receipt.responseVerified, toolCalls: toolEvents.length, conversations: [...new Set(verified.map(row => row.conversationId).filter(Boolean))] };
    results.push(result); console.log(JSON.stringify(result));
    return result;
  }
  (async () => {
    await app.whenReady();
    host = createCodexWebHost({ app: { isPackaged: false, getPath: () => profile, getVersion: () => 'identity-qa' },
      shell: { openExternal: async () => { throw new Error('Login must already be cached.'); } }, broadcast() {}, resolveCodexBin: () => nativeBin });
    const pane = { id: 'identity-qa', launchToken: 1, cwd: output };
    await host.prepareTerminal(pane);
    let ready = await host.action({ ...pane, action: 'validated-status' });
    assert(ready.ok && ready.state.connection.authenticated, 'The preview account could not be validated.');
    if (!ready.state.models.length) ready = await host.action({ ...pane, action: 'refresh' });
    assert(ready.ok, 'The account model catalog could not be loaded.');
    if (process.argv.includes('--tools')) {
      const file = path.join(output, 'work-routing.txt');
      const first = await turn(ready.state, 'gpt-6-astra', 'high', 'Create work-routing.txt in the current local working directory with exactly native-work-ok. Read the file back and report its contents.', undefined, 'gpt-6-astra-wm', false, true);
      assert.equal(fs.readFileSync(file, 'utf8').trim(), 'native-work-ok');
      await turn(ready.state, 'gpt-6-astra', 'high', 'Append a second line resumed-ok to work-routing.txt. Read the file back and report both lines.', first.threadId, 'gpt-6-astra-wm', false, true);
      assert.equal(fs.readFileSync(file, 'utf8').trim().replace(/\r\n/g, '\n'), 'native-work-ok\nresumed-ok');
    } else {
      const prompt = 'Reply only with the result of 37 * 19.';
      const first = await turn(ready.state, 'gpt-6-astra', 'high', prompt, undefined, 'gpt-6-astra-wm');
      await turn(ready.state, 'gpt-5.6-sol', 'medium', prompt, first.threadId, 'gpt-5.6-sol-wm');
      await turn(ready.state, 'gpt-5.5-thinking', 'medium', prompt, first.threadId, 'gpt-5-5-thinking');
      await turn(ready.state, 'gpt-5.6-sol-thinking', 'medium', prompt, first.threadId, ['gpt-5-6-thinking', 'gpt-5-6-auto-thinking']);
      await turn(ready.state, 'gpt-6-astra', 'high', prompt, first.threadId, 'gpt-6-astra-wm');
    }
    assert.deepEqual(protectedFiles.map(digest), before, 'The global or saved native login/config changed.');
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed: true, protectedFilesUnchanged: true, results }, null, 2));
    console.log(JSON.stringify({ passed: true, output, protectedFilesUnchanged: true }));
  })().then(async () => { await host?.shutdown(); app.exit(0); }, async error => {
    currentChild?.kill(); console.error(error.message); await host?.shutdown(); app.exit(1);
  });
}
