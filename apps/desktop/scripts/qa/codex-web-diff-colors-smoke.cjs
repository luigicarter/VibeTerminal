'use strict';
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('electron'), [__filename], { env, windowsHide: true, stdio: 'inherit' });
  child.on('exit', code => { process.exitCode = code || 0; });
} else {
  const { app } = require('electron'), pty = require('node-pty'), { Terminal } = require('@xterm/headless'), TOML = require('@iarna/toml');
  const home = fs.mkdtempSync(path.join(root, '.tmp/codex-web-diff-colors-'));
  app.setPath('userData', path.join(home, 'electron'));
  const file = path.join(home, 'colors.txt'), catalog = path.join(home, 'catalog.json'), model = 'gpt-color-fixture';
  const source = JSON.parse(fs.readFileSync(path.join(root, 'vendor/codex-official/codex-rs/models-manager/models.json'), 'utf8'));
  fs.writeFileSync(file, 'KEEP_COLOR_CONTEXT\nREMOVED_COLOR_LINE\n');
  fs.writeFileSync(catalog, JSON.stringify({ models: [{ ...(source.models || source).find(row => row.visibility === 'list'), slug: model, display_name: 'Color fixture', supported_in_api: true }] }));
  fs.writeFileSync(path.join(home, 'config.toml'), TOML.stringify({ features: { apps: false, plugins: false, code_mode: { enabled: false } }, approval_policy: 'never', sandbox_mode: 'danger-full-access', projects: { [home]: { trust_level: 'trusted' }, [root.toLowerCase()]: { trust_level: 'trusted' } } }));
  let terminal, server, raw = '', ended = false, calls = 0;
  const screen = new Terminal({ cols: 110, rows: 34, scrollback: 3000, allowProposedApi: true });
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(test, ms, message) { const limit = Date.now() + ms; while (Date.now() < limit) { if (test()) return; await sleep(100); } throw new Error(message); }
  const plain = () => raw.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  app.whenReady().then(async () => {
    let state;
    server = http.createServer(async (req, res) => {
      let rawBody = ''; for await (const chunk of req) rawBody += chunk;
      if (req.url === '/control') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, state })); return; }
      if (req.url !== '/v1/responses') { res.writeHead(404); res.end(); return; }
      const request = JSON.parse(rawBody), number = ++calls;
      const patch = '*** Begin Patch\n*** Update File: ' + file + '\n@@\n KEEP_COLOR_CONTEXT\n-REMOVED_COLOR_LINE\n+ADDED_COLOR_LINE\n*** End Patch';
      const item = number === 1
        ? { id: 'fc_colors', type: 'custom_tool_call', call_id: 'call_colors', name: 'apply_patch', input: patch, status: 'completed' }
        : { id: 'msg_colors', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'COLOR_FIXTURE_COMPLETE', annotations: [] }] };
      const response = { id: 'resp_colors_' + number, object: 'response', model: request.model, status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 } };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const emit = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      emit('response.created', { response: { ...response, status: 'in_progress', output: [] } });
      emit('response.output_item.added', { output_index: 0, item: number === 1 ? { ...item, input: '', status: 'in_progress' } : { ...item, content: [], status: 'in_progress' } });
      if (number === 1) emit('response.custom_tool_call_input.delta', { item_id: item.id, output_index: 0, delta: patch });
      else {
        emit('response.content_part.added', { item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
        emit('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: 'COLOR_FIXTURE_COMPLETE' });
      }
      emit('response.output_item.done', { output_index: 0, item }); emit('response.completed', { response }); res.end();
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    state = { route: base + '/v1', catalogPath: catalog, model, models: [{ id: model, label: 'Color fixture' }], effort: 'medium', connection: { authenticated: true } };
    const env = { ...process.env, NO_COLOR: '1', TERM: 'dumb', COLORTERM: '', CODEX_HOME: home, LINA_CODEX_WEB_CODEX_BIN: require('../../backend/codexWebNative.cjs').resolveNativeBinary({ root }), LINA_CODEX_WEB_CONTROL_URL: base + '/control', LINA_CODEX_WEB_CONTROL_KEY: 'fixture', LINA_CODEX_WEB_PANE_ID: 'fixture', LINA_CODEX_WEB_LAUNCH_TOKEN: '1' };
    delete env.ELECTRON_RUN_AS_NODE;
    terminal = pty.spawn(path.join(root, 'vendor/codex-web/runtime/runtime/bun.exe'), [path.join(root, 'backend/codexWebTerminal.cjs'), '-c', 'cli_auth_credentials_store="ephemeral"'], { env, cwd: home, name: 'xterm-256color', cols: 110, rows: 34 });
    screen.onData(data => terminal.write(data)); terminal.onData(data => { raw += data; screen.write(data); }); terminal.onExit(() => { ended = true; });
    await until(() => plain().includes(model) && /model:/.test(plain()), 20000, 'Native TUI did not open'); await sleep(700);
    terminal.write('Run the local diff color fixture.'); await sleep(200); terminal.write('\r');
    await until(() => plain().includes('COLOR_FIXTURE_COMPLETE'), 20000, 'Native diff fixture did not complete'); await sleep(350);
    assert.equal(fs.readFileSync(file, 'utf8').trim(), 'KEEP_COLOR_CONTEXT\nADDED_COLOR_LINE');
    const colors = {};
    for (let y = 0; y < screen.buffer.active.length; y++) {
      const line = screen.buffer.active.getLine(y), text = line?.translateToString(true) || '';
      for (const [kind, marker, sign] of [['deletion', 'REMOVED_COLOR_LINE', '-'], ['insertion', 'ADDED_COLOR_LINE', '+']]) {
        const index = text.indexOf(marker); if (index < 0) continue;
        const signIndex = text.lastIndexOf(sign, index); if (signIndex < 0) continue;
        const cell = line.getCell(signIndex);
        colors[kind] = { foreground: cell.getFgColor(), palette: cell.isFgPalette(), background: cell.getBgColor(), truecolorBackground: cell.isBgRGB() };
      }
    }
    assert.equal(colors.deletion?.palette, true); assert.equal(colors.deletion.foreground, 1, 'Deletion sign should use native red.');
    assert.equal(colors.insertion?.palette, true); assert.equal(colors.insertion.foreground, 2, 'Insertion sign should use native green.');
    assert(colors.deletion.truecolorBackground && colors.insertion.truecolorBackground, 'Native diff backgrounds should retain truecolor.');
    assert.notEqual(colors.deletion.background, colors.insertion.background);
    fs.writeFileSync(path.join(home, 'evidence.json'), JSON.stringify({ passed: true, colors, calls, inheritedNoColor: true, webRequests: 0 }, null, 2));
    console.log(JSON.stringify({ passed: true, colors, calls, inheritedNoColor: true, webRequests: 0, output: home }));
  }).catch(error => { console.error(error.message); process.exitCode = 1; }).finally(async () => {
    fs.writeFileSync(path.join(home, 'terminal.txt'), raw);
    if (terminal && !ended) { terminal.write('\x04'); await until(() => ended, 4000, 'CLI exit timed out').catch(() => { if (!ended) terminal.kill(); }); }
    server?.close(); app.exit(process.exitCode || 0);
  });
}
