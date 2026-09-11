'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
if (!process.versions.electron) {
  const { spawn } = require('node:child_process');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename, ...process.argv.slice(2)], { env, windowsHide: true, stdio: 'inherit' });
  child.once('exit', code => { process.exitCode = code || 0; });
} else {
  const { app } = require('electron');
  const pty = require('node-pty');
  const { Terminal } = require('@xterm/headless');
  const TOML = require('@iarna/toml');
  const http = require('node:http');
  const output = path.join(root, '.tmp', 'codex-web-tui-' + Date.now()); fs.mkdirSync(output, { recursive: true });
  app.setPath('userData', path.join(output, 'electron'));
  const source = JSON.parse(fs.readFileSync(path.join(root, 'vendor/codex-official/codex-rs/models-manager/models.json'), 'utf8'));
  const privateHome = path.join(process.env.APPDATA, 'vibe-terminal-codex-web-preview/codex-web/codex-home');
  const accountCatalog = path.join(privateHome, 'lina-model-catalog.json');
  const cached = process.argv.includes('--cached-models') ? JSON.parse(fs.readFileSync(fs.existsSync(accountCatalog) ? accountCatalog : path.join(privateHome, 'models_cache.json'), 'utf8')).models : null;
  const modelId = cached?.find(model => /astra/i.test(model.display_name))?.slug || 'chatgpt-web/astra-fixture';
  const template = (source.models || source).find(model => model.visibility === 'list') || (source.models || source)[0];
  const catalog = path.join(output, 'catalog.json');
  const catalogRows = cached || [{ ...template, slug: modelId, display_name: 'GPT-6 Astra (fixture)', supported_in_api: true, additional_speed_tiers: [], service_tiers: [] }];
  const direct = process.argv.includes('--direct');
  let inheritedPermissions = {};
  if (process.argv.includes('--shared-permissions')) {
    const prepared = TOML.parse(fs.readFileSync(path.join(privateHome, 'config.toml'), 'utf8'));
    const global = TOML.parse(fs.readFileSync(path.join(process.env.CODEX_HOME || path.join(process.env.USERPROFILE, '.codex'), 'config.toml'), 'utf8'));
    for (const key of ['sandbox_mode', 'approval_policy', 'windows', 'sandbox_workspace_write']) {
      const expected = global.profiles?.[global.profile]?.[key] ?? global[key];
      assert.deepEqual(prepared[key], expected, `${key} must match the user's normal Codex settings.`);
      if (prepared[key] !== undefined) inheritedPermissions[key] = prepared[key];
    }
  }
  fs.writeFileSync(catalog, JSON.stringify({ models: catalogRows }));
  // Reproduce a reused profile, where native update checks already cached a
  // newer release. Fresh-home tests alone miss this startup regression.
  fs.writeFileSync(path.join(output, 'version.json'), JSON.stringify({ latest_version: '999.0.0', last_checked_at: new Date().toISOString(), dismissed_version: null }));
  fs.writeFileSync(path.join(output, 'config.toml'), TOML.stringify({ ...inheritedPermissions, model: modelId, model_provider: 'fixture', model_catalog_json: catalog,
    cli_auth_credentials_store: direct ? 'ephemeral' : 'file', check_for_update_on_startup: !direct, features: { apps: false, plugins: false, fast_mode: false },
    projects: { [output]: { trust_level: 'trusted' }, [root.toLowerCase()]: { trust_level: 'trusted' } },
    model_providers: { fixture: { name: 'Offline UI fixture', base_url: 'http://127.0.0.1:1', wire_api: 'responses', requires_openai_auth: false } } }));
  let terminal, server, body = '', pickerSnapshot = '', done = false, spawnedAt, nativeReadyMs;
  const controlActions = [];
  const finish = async error => {
    if (done) return; done = true;
    if (terminal) {
      const exited = new Promise(resolve => terminal.onExit(resolve));
      terminal.write('\x1b'); await new Promise(resolve => setTimeout(resolve, 200)); terminal.write('\x04');
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 4000))]);
    }
    server?.close();
    fs.writeFileSync(path.join(output, 'terminal.txt'), body);
    fs.writeFileSync(path.join(output, 'model-picker.txt'), pickerSnapshot);
    if (error) { console.error(error.message + '\n' + body.slice(-4000)); app.exit(1); }
    else { assert.ok(!body.includes('Model number:'), 'Startup must go directly to Codex; model selection belongs in /model.'); if (process.argv.includes('--pending-login')) assert.ok(!controlActions.some(action => ['login', 'refresh', 'validated-status'].includes(action)), 'Cached UI must not await validation or open a login browser.'); for (const row of catalogRows.filter(row => row.visibility === 'hide')) assert.ok(!pickerSnapshot.includes(row.slug), `Hidden model ${row.slug} leaked into native /model.`); console.log(JSON.stringify({ ok: true, output, nativeTui: true, liveModel: false, modelCount: catalogRows.filter(row => row.visibility !== 'hide').length, catalogModelCount: catalogRows.length, nativeReadyMs, sharedPermissions: process.argv.includes('--shared-permissions'), pendingLogin: process.argv.includes('--pending-login') })); app.exit(0); }
  };
  (async () => {
    await app.whenReady();
    const state = { route: 'http://127.0.0.1:1', catalogPath: catalog, model: modelId, models: catalogRows.map(model => ({ id: model.slug, label: model.display_name, effort: model.default_reasoning_level })), connection: { authenticated: true, configured: true, full: true, toolsVerified: true } };
    if (process.argv.includes('--pending-login')) { state.connection.authenticated = false; state.connection.checkingLogin = true; state.cachedStartupAllowed = true; }
    let firstRequest = true;
    server = http.createServer(async (request, response) => {
      let text = ''; for await (const chunk of request) text += chunk;
      const input = JSON.parse(text || '{}');
      controlActions.push(input.action);
      if (input.action === 'model') state.model = input.model;
      const delay = firstRequest ? 1800 : 0; firstRequest = false;
      setTimeout(() => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ ok: true, state })); }, delay);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const env = { ...process.env, CODEX_HOME: output, LINA_CODEX_WEB_CODEX_BIN: require('../../backend/codexWebNative.cjs').resolveNativeBinary({ root }),
      LINA_CODEX_WEB_CONTROL_URL: `http://127.0.0.1:${server.address().port}`, LINA_CODEX_WEB_CONTROL_KEY: 'fixture', LINA_CODEX_WEB_PANE_ID: 'fixture', LINA_CODEX_WEB_LAUNCH_TOKEN: '1' };
    delete env.ELECTRON_RUN_AS_NODE;
    // Bootstrap the same real CLI used in the product, against an offline model catalog.
    const launchScript = path.join(output, 'codexWebTerminal.cjs');
    fs.copyFileSync(path.join(root, 'backend/codexWebTerminal.cjs'), launchScript);
    fs.copyFileSync(path.join(root, 'backend/codexWebNative.cjs'), path.join(output, 'codexWebNative.cjs'));
    fs.copyFileSync(path.join(root, 'backend/codexWebSetup.cjs'), path.join(output, 'codexWebSetup.cjs'));
    spawnedAt = Date.now();
    terminal = direct
      ? pty.spawn(env.LINA_CODEX_WEB_CODEX_BIN, ['--model', modelId, '--no-alt-screen'], { name: 'xterm-256color', cols: 110, rows: 34, cwd: output, env })
      : pty.spawn(path.join(root, 'vendor/codex-web/runtime/runtime/bun.exe'), [launchScript], { name: 'xterm-256color', cols: 110, rows: 34, cwd: output, env });
    const screen = new Terminal({ cols: 110, rows: 34, allowProposedApi: true });
    screen.onData(data => terminal.write(data));
    let pickerRequested = false, nextRequested = false, nextConfirmed = false, reasoningConfirmed = false;
    const pickerReady = () => {
      if (!process.argv.includes('--choose-next')) { void finish(); return; }
      if (nextRequested) return; nextRequested = true;
      setTimeout(() => terminal.write('2'), 500);
      const deadline = Date.now() + 8000;
      const check = setInterval(() => {
        let saved; try { saved = TOML.parse(fs.readFileSync(path.join(output, 'config.toml'), 'utf8')).model; } catch {}
        if (saved && saved !== modelId) { clearInterval(check); void finish(); }
        else if (Date.now() > deadline) { clearInterval(check); void finish(new Error('/model did not persist the selection in native Codex config.')); }
      }, 100);
    };
    terminal.onData(data => {
      screen.write(data, () => {
        const visible = Array.from({length: screen.rows}, (_, i) => screen.buffer.active.getLine(screen.buffer.active.viewportY + i)?.translateToString(true) || '').join('\n');
        if (pickerRequested && /^\s*Select Model and Effort\s*$/m.test(visible) && /astra/i.test(visible)) { pickerSnapshot = visible; pickerReady(); }
        if (nextRequested && !nextConfirmed && /› 2\./.test(visible) && /Select Model/i.test(visible)) { nextConfirmed = true; setTimeout(() => terminal.write('\r'), 150); }
        if (nextRequested && !reasoningConfirmed && /Select Reasoning Level for/.test(visible)) { reasoningConfirmed = true; setTimeout(() => terminal.write('\r'), 250); }
      });
      body += data; if (body.length > 500000) body = body.slice(-500000);
      const plain = body.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
      if (/Update available/i.test(plain)) { void finish(new Error('The bundled Codex Web CLI displayed its own update prompt.')); return; }
      if (process.argv.includes('--shared-permissions') && /Set up (?:the |an? )?(?:default |admin |Windows )?sandbox|Setting up sandbox/i.test(plain)) { void finish(new Error('The native CLI prompted to set up an already configured sandbox.')); return; }
      if (!pickerRequested && plain.includes(modelId) && /model:/.test(plain)) {
        nativeReadyMs = Date.now() - spawnedAt;
        pickerRequested = true;
        setTimeout(async () => { for (const char of '/model') { terminal.write(char); await new Promise(resolve => setTimeout(resolve, 100)); } setTimeout(() => terminal.write('\r'), 350); }, 500);
      }
    });
    terminal.onExit(() => { if (!done) void finish(new Error('Native TUI exited before the model picker was verified.')); });
    setTimeout(() => void finish(new Error('Native TUI did not become ready.')), 35000);
  })().catch(finish);
}
