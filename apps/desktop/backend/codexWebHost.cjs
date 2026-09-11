'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createServer } = require('node:http');
const { randomBytes, timingSafeEqual } = require('node:crypto');
const TOML = require('@iarna/toml');
const { spawnBridge } = require('./codexWebChannel.cjs');
const { errorInfo, webModels, writeJson, syncCapabilities, createLog, preferredWebModel } = require('./codexWebSupport.cjs');
const { readStartupCache } = require('./codexWebStartup.cjs');
const { refreshNativeModelNames, filterNativeModelPicker } = require('./codexWebModelDiscovery.cjs');

function createCodexWebHost({ app, shell, clipboard, broadcast, resolveCodexBin, bridgeAdapter, globalCodexHome }) {
  const root = path.join(app.getPath('userData'), 'codex-web');
  const home = path.join(root, 'codex-home');
  const catalogPath = path.join(home, 'lina-model-catalog.json');
  const globalHome = globalCodexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const bundle = app.isPackaged ? path.join(process.resourcesPath, 'codex-web') : path.join(__dirname, '../vendor/codex-web');
  const log = createLog(root, { versions: { appVersion: app.getVersion?.() || 'unknown', bridgeVersion: '5.0.6' } });
  const sessions = new Map(), setupRequests = new Set(), requests = new Map();
  let bridge, starting, connection = {}, models = [], requestId = 0, generation = 0, closing = false, refreshPromise = null, mutation = false;
  let server, serverReady, port, catalogAccount, catalogLoad, prewarming, adapterReady = false;
  const controlKey = randomBytes(32).toString('hex');
  function config() {
    try { return TOML.parse(fs.readFileSync(path.join(home, 'config.toml'), 'utf8')); } catch { return {}; }
  }
  function route() {
    try { const value = config().openai_base_url, url = new URL(value); return url.protocol === 'http:' && url.hostname === '127.0.0.1' ? value : null; } catch { return null; }
  }
  const cachedStartupMode = () => !connection.loginPending && (connection.checkingLogin || ['connection_failed', 'web_model_catalog_unavailable'].includes(connection.validationError));
  function view(s) {
    const saved = config();
    const selected = preferredWebModel(models, saved.model) || models.find(model => !model.hidden);
    const supported = selected?.efforts || [selected?.effort];
    const sameModel = saved.model === selected?.id || selected?.aliases?.includes(saved.model);
    const effort = sameModel && supported.includes(saved.model_reasoning_effort) ? saved.model_reasoning_effort : selected?.effort;
    return { id: s.id, launchToken: s.launchToken, models, model: selected?.id || '', effort, route: route(), catalogPath,
      imageTool: { command: path.join(bundle, 'runtime/runtime', process.platform === 'win32' ? 'bun.exe' : 'bun'), entry: path.join(bundle, 'runtime/app/cli.js'), home: path.join(root, 'bridge'), codeMode: saved.features?.code_mode },
      connection, cachedStartupAllowed: Boolean(models.length && cachedStartupMode()), setupRequested: setupRequests.has(s.id), error: s.error, backgroundError: Boolean(s.cachedStartup && s.error), loggingFailed: log.failed };
  }
  const publish = s => broadcast('codex-web:event', view(s));
  const publishAll = () => { for (const s of sessions.values()) publish(s); };
  function invalidate() { generation++; models = []; publishAll(); }
  function forgetCatalog() {
    invalidate();
    try { if (fs.existsSync(catalogPath)) fs.unlinkSync(catalogPath); }
    catch (error) { log.record('models.clear_failed', errorInfo(error)); }
  }
  function restoreCatalog() {
    const account = connection.authenticated ? connection.accountKey : cachedStartupMode() ? connection.cachedAccountKey : null;
    if (models.length && (!account || catalogAccount !== account)) forgetCatalog();
    if (models.length || !account || !route()) return;
    try {
      const cached = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
      const age = Date.now() - cached._lina?.updatedAt;
      if (cached._lina?.format !== 1 || cached._lina.accountKey !== account || !Number.isSafeInteger(cached._lina.updatedAt) || age < 0 || (!cachedStartupMode() && age > 3600000)) return;
      const named = filterNativeModelPicker(refreshNativeModelNames(cached.models));
      if (named !== cached.models) { cached.models = named; writeJson(catalogPath, cached); }
      models = webModels(cached.models, { includePickerHidden: true });
      catalogAccount = account;
      if (models.length) log.record('models.cached', { count: models.length });
    } catch { /* Missing or stale metadata is refreshed through the authenticated bridge. */ }
  }
  function fail(s, error) { s.error = errorInfo(error); log.record('operation.failed', s.error); publish(s); return { ok: false, error: s.error }; }
  function shareCapabilities() {
    const result = syncCapabilities(globalHome, home);
    if (result.repaired) log.record('config.repaired', { stage: 'capabilities' });
  }
  function send(action, timeout = 45000, input) {
    if (bridgeAdapter) return bridgeAdapter.call(action, input);
    return new Promise((resolve, reject) => {
      if (!bridge?.connected) { reject(new Error('connection_failed')); return; }
      const id = ++requestId;
      const timer = setTimeout(() => { requests.delete(id); reject(new Error('connection_failed')); }, timeout);
      requests.set(id, { resolve, reject, timer });
      bridge.send({ requestId: id, action, ...(input ? { input } : {}) }, error => {
        if (error) { requests.delete(id); clearTimeout(timer); reject(new Error('connection_failed')); }
      });
    });
  }
  async function ensureBridge() {
    if (closing) throw new Error('client_cancelled');
    if (starting) return starting;
    if (bridge?.connected || adapterReady) return;
    starting = (async () => {
      const startedAt = Date.now();
      shareCapabilities();
      if (bridgeAdapter) { await bridgeAdapter.start(); adapterReady = true; return; }
      if (!fs.existsSync(path.join(bundle, 'lina-build.json'))) throw new Error('runtime_missing');
      const env = { ...process.env, CODEX_HOME: home, CODEX_CHATGPT_WEB_HOME: path.join(root, 'bridge'),
        CODEX_WEB_GPT_LAUNCHER_DATA_DIR: path.join(root, 'browser'), LINA_CODEX_WEB_HOST_MODULE: path.join(__dirname, 'codexWebLauncher.cjs') };
      delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL;
      const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH';
      env[pathKey] = path.dirname(resolveCodexBin()) + path.delimiter + (env[pathKey] || '');
      const args = app.isPackaged ? ['--codex-web-host', '--hidden'] : [path.resolve(__dirname, '..'), '--codex-web-host', '--hidden'];
      const child = await spawnBridge(process.execPath, args, { env, windowsHide: true });
      if (closing) { child.kill(); throw new Error('client_cancelled'); }
      bridge = child; child.stdout.resume(); child.stderr.resume();
      await new Promise((resolve, reject) => {
        let ready = false;
        const timer = setTimeout(() => reject(new Error('connection_failed')), 90000);
        child.on('message', message => {
          if (child !== bridge) return;
          if (message.event === 'ready') { clearTimeout(timer); connection = message.state; restoreCatalog(); ready = true; resolve(); log.record('bridge.ready', { elapsedMs: Date.now() - startedAt }); publishAll(); }
          else if (message.event) {
            const account = connection.accountKey, authenticated = connection.authenticated;
            if (message.state) connection = message.state;
            if ((!connection.checkingLogin && authenticated && !connection.authenticated) || ['login-started', 'login-complete'].includes(message.event) || (account && account !== connection.accountKey)) forgetCatalog();
            if (message.event === 'login-failed') for (const s of sessions.values()) fail(s, message.error || 'external_login_failed');
            if (message.event === 'validation-complete') {
              if (message.error) {
                log.record('validation.failed', errorInfo(message.error));
                if (['chatgpt_session_expired', 'web_account_changed'].includes(message.error)) forgetCatalog();
                for (const s of sessions.values()) if (s.cachedStartup) fail(s, message.error);
              } else {
                for (const s of sessions.values()) if (s.cachedStartup) s.error = null;
                if (connection.modelsRefreshed && connection.authenticated) void loadProviderCatalog().catch(error => { for (const s of sessions.values()) fail(s, error); });
                else restoreCatalog();
              }
            }
            publishAll();
          } else if (requests.has(message.requestId)) {
            const pending = requests.get(message.requestId); requests.delete(message.requestId); clearTimeout(pending.timer);
            if (message.error) pending.reject(typeof message.error === 'string' ? new Error(message.error) : Object.assign(new Error(message.error.code), { stage: message.error.stage }));
            else pending.resolve(message.result);
          }
        });
        const ended = () => {
          clearTimeout(timer); reject(new Error('connection_failed'));
          if (bridge !== child) return;
          bridge = null; connection = {}; invalidate();
          for (const pending of requests.values()) { clearTimeout(pending.timer); pending.reject(new Error('connection_failed')); }
          requests.clear();
          if (ready && !closing) for (const s of sessions.values()) fail(s, 'connection_failed');
        };
        child.once('error', ended); child.once('exit', ended);
      });
    })().finally(() => { starting = null; });
    return starting;
  }
  async function prewarm() {
    if (closing || !readStartupCache(home)) return false;
    if (prewarming) return prewarming;
    prewarming = (async () => {
      log.record('prewarm.started');
      await ensureBridge();
      if (closing) return false;
      connection = await send('status');
      restoreCatalog();
      if (connection.authenticated && connection.modelsRefreshed && !models.length) await loadProviderCatalog();
      log.record('prewarm.available');
      return true;
    })().catch(error => { if (!closing) log.record('prewarm.failed', errorInfo(error)); return false; })
      .finally(() => { prewarming = null; });
    return prewarming;
  }
  async function loadProviderCatalog() {
    if (catalogLoad) return catalogLoad;
    catalogLoad = (async () => {
      const current = generation, account = connection.accountKey, base = route(), startedAt = Date.now();
      if (!connection.authenticated) throw new Error('authentication_required');
      if (!base) throw new Error('bridge_config_out_of_sync');
      const response = await fetch(base.replace(/\/$/, '') + '/models', { signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error('web_model_catalog_unavailable');
      const body = await response.json();
      body.models = filterNativeModelPicker(body.models);
      const available = webModels(body.models, { includePickerHidden: true });
      if (!available.length) throw new Error('web_model_catalog_unavailable');
      if (current !== generation || account !== connection.accountKey || closing) throw new Error('client_cancelled');
      writeJson(catalogPath, { _lina: { format: 1, accountKey: account, updatedAt: Date.now() }, models: available.map(model => body.models.find(row => (row.slug || row.id) === model.id && row.hidden !== true)) });
      models = available; catalogAccount = account;
      log.record('models.refreshed', { count: models.length, elapsedMs: Date.now() - startedAt }); publishAll();
    })().finally(() => { catalogLoad = null; });
    return catalogLoad;
  }
  async function refresh() {
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      await ensureBridge();
      connection = await send('validated-status', 90000);
      if (connection.validationError === 'web_account_changed') throw new Error('web_account_changed');
      if (connection.busy) throw new Error('busy');
      if (!connection.authenticated) throw new Error('authentication_required');
      if (connection.automatic === false) throw new Error('manual_mode_unsupported');
      invalidate();
      connection = await send('refresh', 360000);
      await loadProviderCatalog();
      shareCapabilities();
    })().finally(() => { refreshPromise = null; });
    return refreshPromise;
  }
  async function stop(id, launchToken) {
    const s = sessions.get(id);
    if (!s) return { ok: true, process: 'already-absent', launchSettled: true };
    if (launchToken !== undefined && launchToken !== s.launchToken) return { ok: false, process: 'superseded', launchSettled: false };
    sessions.delete(id); log.record('pane.stopped');
    return { ok: true, process: 'stopped', launchSettled: true };
  }
  async function action(payload) {
    if (typeof payload?.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(payload.id)) throw new Error('Invalid pane id.');
    if (payload.action === 'start') {
      if (!path.isAbsolute(payload.cwd || '') || !fs.statSync(payload.cwd).isDirectory()) throw new Error('Invalid working folder.');
      const previous = sessions.get(payload.id);
      if (!previous || previous.launchToken !== payload.launchToken) {
        sessions.set(payload.id, { id: payload.id, cwd: payload.cwd, launchToken: payload.launchToken, error: null });
        log.record('pane.started');
      }
      return { ok: true, state: view(sessions.get(payload.id)) };
    }
    if (payload.action === 'stop') return stop(payload.id, payload.launchToken);
    const s = sessions.get(payload.id);
    if (!s || s.launchToken !== payload.launchToken) return { ok: false, error: errorInfo('client_cancelled') };
    const independent = ['status', 'terminal-status', 'validated-status', 'progress', 'diagnostics', 'open-image', 'clipboard-image', 'attach-images'].includes(payload.action);
    if (payload.action === 'refresh' && refreshPromise) {
      try { await refreshPromise; return { ok: true, state: view(s) }; } catch (error) { return fail(s, error); }
    }
    if (!independent && mutation) return { ok: false, error: errorInfo('busy') };
    if (!independent) mutation = true;
    try {
      if (!independent) s.error = null;
      switch (payload.action) {
        case 'clipboard-image': return { ok: true, attachmentPaths: require('./codexWebImages.cjs').clipboardImagePath(path.join(root, 'input-images'), clipboard) };
        case 'attach-images': return { ok: true, attachmentPaths: require('./codexWebImages.cjs').readImageReferences(payload.paths).map(image => image.file) };
        case 'status': case 'progress': break;
        case 'terminal-status': case 'validated-status':
          await ensureBridge(); connection = await send(payload.action === 'validated-status' ? 'validated-status' : 'status', 90000);
          restoreCatalog();
          if (connection.authenticated && connection.modelsRefreshed && !models.length) await loadProviderCatalog();
          if (cachedStartupMode() && models.length) {
            s.cachedStartup = true;
            if (connection.validationError && !s.error) fail(s, connection.validationError);
          }
          break;
        case 'refresh': await refresh(); break;
        case 'setup': if (connection.busy) throw new Error('busy'); setupRequests.add(s.id); break;
        case 'setup-consume': setupRequests.delete(s.id); break;
        case 'login': case 'cancel-login': case 'logout':
          await ensureBridge(); connection = await send('status');
          if (connection.busy) throw new Error('busy');
          if (payload.action !== 'cancel-login') forgetCatalog();
          connection = await send(payload.action, 90000); break;
        case 'setup-browser': {
          const urls = { tunnels: 'https://platform.openai.com/settings/organization/tunnels', keys: 'https://platform.openai.com/settings/organization/api-keys', connector: 'https://chatgpt.com/#settings/Plugins' };
          if (!Object.hasOwn(urls, payload.page)) throw new Error('setup_required');
          await shell.openExternal(urls[payload.page]); break;
        }
        case 'setup-tools':
          await ensureBridge();
          if (payload.replace === true && (!/^tunnel_[a-f0-9]{32}$/.test(payload.tunnelId || '') || typeof payload.runtimeKey !== 'string' || payload.runtimeKey.trim().length < 20 || payload.runtimeKey.length > 4096)) throw new Error('tools_runtime_failed');
          connection = await send('setup-tools', 660000, { tunnelId: payload.tunnelId, runtimeKey: payload.runtimeKey, replace: payload.replace === true }); invalidate(); break;
        case 'verify-tools': await ensureBridge(); connection = await send('verify-tools', 180000); break;
        case 'diagnostics': await shell.openPath(log.directory); break;
        case 'open-image': {
          const file = require('./codexWebImages.cjs').resolveGeneratedImage(path.join(root, 'generated-images'), payload.filename);
          if (await shell.openPath(file)) throw new Error('image_open_failed');
          break;
        }
        default: throw new Error('Unknown Codex Web connection action.');
      }
      publish(s); return { ok: true, state: view(s) };
    } catch (error) {
      if (['open-image', 'clipboard-image', 'attach-images'].includes(payload.action)) { const info = errorInfo(error); log.record('image.operation_failed', info); return { ok: false, error: info }; }
      return fail(s, error);
    }
    finally { if (!independent) mutation = false; }
  }
  async function prepareTerminal(payload) {
    await action({ ...payload, action: 'start' });
    // Start the browser while Lina/PowerShell prepares the PTY, not afterward.
    void ensureBridge().catch(error => { const s = sessions.get(payload.id); if (s?.launchToken === payload.launchToken) fail(s, error); });
    if (!server) {
      server = createServer(async (request, response) => {
        const supplied = Buffer.from((request.headers.authorization || '').replace(/^Bearer /, ''));
        const expected = Buffer.from(controlKey);
        if (request.method !== 'POST' || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { response.writeHead(403); response.end(); return; }
        try {
          let body = ''; for await (const chunk of request) { body += chunk; if (body.length > 64000) throw new Error('Invalid request.'); }
          const input = JSON.parse(body);
          if (!['progress', 'terminal-status', 'validated-status', 'login', 'cancel-login', 'logout', 'setup', 'setup-consume', 'setup-browser', 'setup-tools', 'verify-tools', 'refresh', 'diagnostics'].includes(input.action)) throw new Error('Invalid action.');
          const result = await action(input);
          response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(result));
        } catch (error) { response.writeHead(400, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ ok: false, error: errorInfo(error) })); }
      });
      serverReady = new Promise((resolve, reject) => {
        server.once('error', reject); server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); });
      });
    }
    await serverReady;
    const binDir = path.join(root, 'bin'); fs.mkdirSync(binDir, { recursive: true });
    const bun = path.join(bundle, 'runtime/runtime', process.platform === 'win32' ? 'bun.exe' : 'bun');
    const script = path.join(__dirname.replace('app.asar', 'app.asar.unpacked'), 'codexWebTerminal.cjs');
    const literal = value => value.replace(/%/g, '%%');
    fs.writeFileSync(path.join(binDir, 'codex-web.cmd'), '@echo off\r\nsetlocal DisableDelayedExpansion\r\n"' + literal(bun) + '" "' + literal(script) + '" %*\r\n');
    return { command: 'codex-web', binDir, env: { CODEX_HOME: home, LINA_CODEX_WEB_CODEX_BIN: resolveCodexBin(),
      LINA_CODEX_WEB_CONTROL_URL: 'http://127.0.0.1:' + port, LINA_CODEX_WEB_CONTROL_KEY: controlKey,
      LINA_CODEX_WEB_PANE_ID: payload.id, LINA_CODEX_WEB_LAUNCH_TOKEN: String(payload.launchToken) } };
  }
  async function shutdown() {
    closing = true;
    for (const id of sessions.keys()) await stop(id);
    if (bridge?.connected || adapterReady) { try { await send('shutdown', 12000); } catch { bridge?.disconnect(); } }
    server?.close();
  }
  return { action, stop, shutdown, prepareTerminal, prewarm, sessions };
}
module.exports = { createCodexWebHost };
