'use strict';
// Actual installed CLIs + PTYs + generated observers + local transcript readers.
// Model responses come only from a loopback fixture; all homes are isolated.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const http = require('node:http'), assert = require('node:assert/strict');
const pty = require('node-pty'), { Terminal } = require('@xterm/headless');
const TOML = require('@iarna/toml');
const { createAgentTelemetryManager } = require('../../backend/agentTelemetry.cjs');
const { createTerminalRuntime } = require('../../backend/terminalRuntime.cjs');
const { confirmClaudeThread } = require('../../backend/agentThreadHost.cjs');
const { confirmCodexThread } = require('../../backend/agentThreads.cjs');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, '.tmp', 'native-chat-selection', `${Date.now()}-${process.pid}`);
fs.mkdirSync(output, { recursive: true });
const wait = ms => new Promise(r => setTimeout(r, ms));
const checks = [];
let responseNumber = 0;
const marker = 'SELECTION_FIXTURE_OK';
const server = http.createServer(async (req, res) => {
  let raw = ''; for await (const c of req) raw += c;
  if (!req.url.includes('/messages') && !req.url.includes('/responses')) { res.writeHead(404); res.end('{}'); return; }
  const body = JSON.parse(raw || '{}');
  if (req.url.includes('count_tokens')) { res.setHeader('Content-Type', 'application/json'); res.end('{"input_tokens":10}'); return; }
  const id = `fixture-${++responseNumber}`;
  const answer = JSON.stringify(body.messages || body.input || '').match(/SELECTION_FIXTURE_OK_[ABC]/g)?.at(-1) || marker;
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  const emit = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  if (req.url.includes('/messages')) {
    emit('message_start', { message: { id, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
    emit('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    emit('content_block_delta', { index: 0, delta: { type: 'text_delta', text: answer } });
    emit('content_block_stop', { index: 0 });
    emit('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } });
    emit('message_stop', {});
  } else {
    const item = { id: `msg-${id}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: answer, annotations: [] }] };
    const response = { id, object: 'response', model: body.model, status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } };
    emit('response.created', { response: { ...response, status: 'in_progress', output: [] } });
    emit('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
    emit('response.content_part.added', { item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
    emit('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: answer });
    emit('response.output_item.done', { output_index: 0, item });
    emit('response.completed', { response });
  }
  res.end();
});

async function run(provider) {
  const claude = provider === 'claude' || provider === 'claude-custom';
  const nativeProvider = claude ? 'claude' : provider;
  const dir = path.join(output, provider), cwd = fs.mkdtempSync(path.join(os.tmpdir(), `lina-native-chat-${provider}-`)), home = path.join(dir, 'home');
  fs.mkdirSync(cwd, { recursive: true }); fs.mkdirSync(home, { recursive: true });
  const url = `http://127.0.0.1:${server.address().port}`;
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(VIBE_|LINA_|ANTHROPIC_|CLAUDE_|CODEX_|OPENAI_|ELECTRON_RUN_AS_NODE)/.test(key) || /API_KEY|AUTH_TOKEN/.test(key)) delete env[key];
  Object.assign(env, { CLAUDE_CONFIG_DIR: home, CODEX_HOME: home, XDG_CONFIG_HOME: path.join(home, 'xdg-config'), XDG_DATA_HOME: path.join(home, 'xdg-data'),
    DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', ANTHROPIC_BASE_URL: url, ANTHROPIC_API_KEY: 'fixture-key', IS_SANDBOX: '1' });
  process.env.CLAUDE_CONFIG_DIR = home;
  if (provider === 'claude-custom') process.env.VIBE_CLAUDE_CUSTOM_HOME = home;
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', bypassPermissionsModeAccepted: true,
    customApiKeyResponses: { approved: ['fixture-key'], rejected: [] }, projects: { [cwd]: { hasTrustDialogAccepted: true } } }));
  fs.writeFileSync(path.join(home, 'config.toml'), TOML.stringify({ model: 'fixture', model_provider: 'fixture', check_for_update_on_startup: false,
    cli_auth_credentials_store: 'ephemeral', approval_policy: 'never', sandbox_mode: 'read-only',
    features: { apps: false, plugins: false, responses_websockets: false },
    projects: { [cwd]: { trust_level: 'trusted' } },
    model_providers: { fixture: { name: 'Loopback fixture', base_url: `${url}/v1`, wire_api: 'responses', requires_openai_auth: false } } }));
  if (provider === 'open-codex') {
    const catalog = path.join(home, 'models.json');
    fs.writeFileSync(catalog, JSON.stringify(require('../../backend/openCodexRuntime.cjs').modelCatalog([
      { cliId: 'fixture', label: 'Fixture', providerName: 'Local', contextWindow: 32768, reasoning: false }
    ])));
    Object.assign(env, { LINA_OPEN_CODEX_BIN: path.join(root, 'vendor/open-codex/win32-x64/codex.exe'), LINA_OPEN_CODEX_HOME: home,
      LINA_OPEN_CODEX_CATALOG: catalog, LINA_OPEN_CODEX_BASE_URL: `${url}/v1`, LINA_OPEN_CODEX_TOKEN: 'fixture', LINA_OPEN_CODEX_MODEL: 'fixture' });
  }
  let native, screen, exited = false, raw = '', folderTrusted = false, hooksReviewed = false;
  const events = [];
  const runtime = createTerminalRuntime({ lookup: async p => p.confirmId ? claude
    ? confirmClaudeThread(cwd, p.confirmId, p.claudeHome) : confirmCodexThread(cwd, p.confirmId, { codexHome: home }) : { status: 'pending' } });
  const manager = createAgentTelemetryManager({ baseDir: path.join(dir, 'shims'), openCodeHome: path.join(dir, 'opencode'), emit: e => {
    if (provider === 'open-codex' && e.provider === 'codex') e = { ...e, provider: 'open-codex' };
    events.push(e); runtime.ingest(e);
    const record = runtime.getRecord(e.id);
    if (record?.snapshot.selection?.status === 'pending' || record?.identityHints.size) void runtime.refreshRecord(record);
  } });
  const state = () => runtime.getSnapshot('pane');
  const text = () => Array.from({ length: screen.buffer.active.length }, (_, i) => screen.buffer.active.getLine(i)?.translateToString(true) || '').join('\n');
  async function until(fn, label, timeout = 35000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      // These approvals apply only to this generated fixture and its own seven
      // observer commands, in an empty home with no user/project hooks.
      if (!folderTrusted && text().includes('Yes, I trust this folder')) {
        folderTrusted = true; await wait(1200); native.write('\x1b[B'); await wait(300); native.write('\r'); await wait(700);
      }
      if (!hooksReviewed && text().includes('Hooks need review')) {
        assert.ok(text().includes('7 hooks are new or changed.'));
        hooksReviewed = true; native.write('\x1b[B'); await wait(200); native.write('\r'); await wait(700);
      }
      if (await fn()) return; if (exited) throw Error(`${provider} exited: ${label}`); await wait(50);
    }
    throw Error(`${provider}: ${label}\n${text().slice(-3500)}`);
  }
  async function input(value) { native.write(value); await wait(200); native.write('\r'); }
  async function launch(token, resumeId) {
    exited = false; folderTrusted = false; hooksReviewed = false;
    screen = new Terminal({ cols: 110, rows: 34, allowProposedApi: true });
    const admission = runtime.beginLaunch({ id: 'pane', launchToken: token, provider: nativeProvider, cwd,
      ...(provider === 'claude-custom' && { providerProfileId: 'fixture' }),
      ...(resumeId && { threadRef: { provider: nativeProvider, id: resumeId } }) });
    const prepared = await manager.prepareSession('pane', { provider: nativeProvider, generation: admission.generation });
    const args = claude ? ['--model', 'claude-haiku-4-5', '--dangerously-skip-permissions', ...(resumeId ? ['--resume', resumeId] : [])] :
      [...(resumeId ? ['resume', resumeId] : []), '--no-alt-screen'];
    native = pty.spawn(provider === 'open-codex' ? process.execPath : 'powershell.exe', provider === 'open-codex'
      ? [path.join(root, 'backend/openCodexCli.cjs'), ...args]
      : ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(prepared.shimDir, `${nativeProvider}.ps1`), ...args],
      { cwd, cols: 110, rows: 34, name: 'xterm-256color', env: { ...env, ...prepared.env } });
    runtime.ingest({ id: 'pane', generation: admission.generation, type: 'created' });
    const currentScreen = screen, currentNative = native;
    currentScreen.onData(data => currentNative.write(data));
    currentNative.onData(data => { raw += data; currentScreen.write(data); });
    currentNative.onExit(() => { if (native === currentNative) exited = true; });
    await until(() => /bypass permissions|for shortcuts|context left|fixture (default|none)/i.test(text()), 'native composer ready');
    // Native startup can draw the composer before it begins accepting Enter.
    // This delay is confined to the native acceptance fixture.
    await wait(1500);
  }
  async function stop() {
    if (!native || exited) return;
    await input('/exit');
    const end = Date.now() + 5000;
    while (!exited && Date.now() < end) await wait(50);
    if (!exited) native.kill();
    await wait(250);
  }
  try {
    await launch(1);
    const ids = [];
    for (let i = 0; i < 3; i++) {
      if (i) { await input(claude ? '/clear' : '/new'); await wait(700); }
      const start = events.length;
      await input(`Reply only ${marker}_${String.fromCharCode(65 + i)}.`);
      await until(() => events.slice(start).some(e => e.type === 'agent-attention' && e.attention?.state === 'completed'), `turn ${i + 1} completion`);
      await until(async () => { await runtime.refresh(); return state()?.conversation?.id && !ids.includes(state().conversation.id) && state().selection?.status === 'confirmed'; }, `turn ${i + 1} selected root`);
      ids.push(state().conversation.id);
      console.log(`${provider}: selected chat ${i + 1} ${ids[i]}`);
    }
    assert.equal(new Set(ids).size, 3);
    const last = state().conversation.id;
    await stop(); screen.dispose();
    await launch(2, last);
    await until(() => text().includes(`${marker}_C`), 'restored transcript from chat C');
    const resumedAt = events.length;
    await input(`Reply only ${marker}_C.`);
    await until(() => events.slice(resumedAt).some(e => e.type === 'agent-attention' && e.attention?.state === 'completed' && e.providerThreadId === last), 'native resumed turn belongs to C');
    assert.ok(events.some(e => e.type === 'agent-session' && e.source === 'resume' && e.providerThreadId === last));
    assert.equal(state().conversation.id, last);
    checks.push({ provider, ids, resumedId: last, resumeHookReview: hooksReviewed, sessionStartSources: events.filter(e => e.type === 'agent-session').map(e => e.source) });
    console.log(`${provider}: exact chat C resumed with native history`);
  } finally {
    await stop(); screen?.dispose(); manager.cleanup(); runtime.dispose();
    fs.writeFileSync(path.join(dir, 'terminal.txt'), raw);
    fs.writeFileSync(path.join(dir, 'events.json'), JSON.stringify(events, null, 2));
  }
}

(async () => {
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    for (const provider of process.argv.includes('--codex') ? ['codex'] : process.argv.includes('--claude') ? ['claude'] : process.argv.includes('--claude-custom') ? ['claude-custom'] : process.argv.includes('--open-codex') ? ['open-codex'] : ['claude', 'claude-custom', 'codex', 'open-codex']) await run(provider);
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ ok: true, checks, liveModel: false }, null, 2));
    console.log(JSON.stringify({ ok: true, output, checks }));
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
})().then(() => process.exit(0), error => { console.error(error); console.error(output); process.exit(1); });
