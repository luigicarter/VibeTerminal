'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { readStartupCache, startValidation, validatedSession } = require('./codexWebStartup.cjs');

function beginStartupValidation(browserHost) {
  return startValidation(browserHost, { cached: readStartupCache(process.env.CODEX_HOME),
    check: () => refreshStartupAuthentication(browserHost), refreshModels: () => browserHost.inspectSession(true) });
}

function bundledRuntime(bundle) {
  const root = path.join(bundle, 'runtime');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  if (manifest.schemaVersion !== 2 || manifest.appVersion !== '5.0.6' || manifest.platform !== process.platform || manifest.arch !== process.arch) throw new Error('runtime_missing');
  for (const file of ['app/cli.js', 'app/browser-helper.cjs', 'runtime/' + (process.platform === 'win32' ? 'bun.exe' : 'bun')]) {
    const target = path.join(root, file), stat = fs.statSync(target);
    if (!stat.isFile() || stat.size === 0) throw new Error('runtime_missing');
  }
  return root;
}

async function refreshStartupAuthentication(browserHost) {
  const browserSession = browserHost.view?.webContents?.session;
  if (typeof browserSession?.fetch !== 'function') return browserHost.refreshAuthentication();
  const began = Date.now();
  try {
    // Verify the saved login in its own Chromium cookie partition without
    // waiting for the entire ChatGPT website to render. No token leaves here.
    const response = await browserSession.fetch('https://chatgpt.com/api/auth/session', {
      credentials: 'include', cache: 'no-store', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(5000),
    });
    if (response.status === 401) { browserHost.setState({ authenticated: false, status: 'signed-out', message: 'Sign in to ChatGPT' }); return browserHost.snapshot(); }
    if (response.ok && response.headers.get('content-type')?.includes('application/json') && new URL(response.url).origin === 'https://chatgpt.com') {
      const payload = await response.json(), user = payload?.user;
      const valid = user && typeof user === 'object' && Object.keys(user).length && typeof payload.accessToken === 'string' && payload.accessToken.length > 0 && !payload.error && (!payload.expires || Date.parse(payload.expires) > Date.now());
      if (!valid) { browserHost.setState({ authenticated: false, status: 'signed-out', message: 'Sign in to ChatGPT' }); return browserHost.snapshot(); }
      const identity = String(user.id || user.email || '') + ':' + String(payload.account?.id || payload.account_id || '');
      browserHost.setState({ authenticated: true, status: 'ready', message: 'ChatGPT is ready', linaAccountKey: require('node:crypto').createHash('sha256').update(identity).digest('hex'), linaAccountLabel: String(user.email || user.name || '').slice(0, 120) });
      browserHost.logger?.info('browser.cached_session_checked', { durationMs: Date.now() - began });
      return browserHost.snapshot();
    }
  } catch { /* Browser navigation can resolve a challenge or transient session failure. */ }
  return browserHost.refreshAuthentication();
}

function runtimeConnection(runtimeHost, state) {
  const config = runtimeHost.runtimeConfigSnapshot();
  return { configured: config.configured === true, full: config.mode === 'full',
    toolsVerified: state.mcpSetupComplete === true, operation: runtimeHost.currentOperation() || null,
    toolsCredentials: runtimeHost.mcpCredentialsConfigured('automatic'),
    // A fresh or browser-only profile has no configured MCP runtime yet.
    connectorName: runtimeHost.browserConnectorName(),
    automatic: config.config?.browserInteractionMode !== 'manual' };
}

function bootstrap() {
  require('./codexWebChannel.cjs').attachBridgeChannel();
  const { app } = require('electron');
  const bundle = app.isPackaged ? path.join(process.resourcesPath, 'codex-web') : path.join(__dirname, '../vendor/codex-web');
  if (!fs.existsSync(path.join(bundle, 'lina-build.json'))) throw new Error('Codex Web runtime is missing. Run npm run prepare:codex-web.');
  process.env.LINA_CODEX_WEB_BUNDLE = bundle;
  process.env.LINA_CODEX_WEB_HOST_MODULE = __filename;
  require(path.join(bundle, 'launcher/electron/main.cjs'));
}

function attach({ app, browserHost, runtimeHost, runtimeSupervisor, stateStore, requestQuit }) {
  const send = message => { if (process.connected) process.send(message); };
  let externalLogin, externalOperation = null, modelLabel = '', modelEffort = '', refreshPhase = null;
  function snapshot() {
    const state = stateStore.read();
    const browser = browserHost.snapshot();
    return { authenticated: browser.authenticated === true, accountKey: browser.authenticated ? browser.linaAccountKey : null,
      accountLabel: browser.authenticated ? String(browser.linaAccountLabel || '').slice(0, 120) : '', browserStatus: browser.status,
      loginPending: externalOperation !== null, loginPhase: externalLogin?.status?.phase || null, loginBrowser: externalLogin?.status?.browser || null,
      checkingLogin: browserHost.linaValidation?.pending === true,
      cachedAccountKey: browserHost.linaValidation?.cached?.accountKey,
      modelsRefreshed: browserHost.linaValidation?.modelsRefreshed === true,
      validationError: browserHost.linaValidation?.error?.code,
      loginExpired: !browser.authenticated && browser.status === 'signed-out' && fs.existsSync(path.join(process.env.CODEX_CHATGPT_WEB_HOME, 'lina-account-models.json')),
      modelLabel, modelEffort, refreshPhase, busy: Boolean(browserHost.activeTraceId), ...runtimeConnection(runtimeHost, state) };
  }
  const oldPublish = browserHost.publishState;
  browserHost.publishState = state => { oldPublish?.(state); send({ event: 'state', state: snapshot() }); };
  externalLogin = require('./codexWebBrowserLogin.cjs').createBrowserLogin({
    userData: app.getPath('userData'),
    chromium: require(path.join(process.env.LINA_CODEX_WEB_BUNDLE, 'runtime/app/node_modules/playwright-core')).chromium,
    importState: transfer => browserHost.installPasskeyLogin(transfer),
    publish: () => send({ event: 'state', state: snapshot() }),
    log: event => browserHost.logger.info(event, {}),
  });
  // Override the launcher's own Sign in action too, so both entry points use the same flow.
  browserHost.openLogin = () => {
    if (externalOperation) return externalOperation;
    browserHost.linaLoginPending = true;
    externalOperation = browserHost.withManualOperation('ChatGPT login', () => externalLogin.start())
      .then(() => { if (browserHost.linaValidation) { browserHost.linaValidation.cached = null; browserHost.linaValidation.error = null; browserHost.linaValidation.modelsRefreshed = false; } send({ event: 'login-complete', state: snapshot() }); return browserHost.snapshot(); })
      .catch(error => {
        const code = ['client_cancelled', 'login_browser_missing', 'external_login_timeout', 'external_login_failed', 'external_login_closed'].includes(error?.message) ? error.message : 'external_login_failed';
        send({ event: 'login-failed', state: snapshot(), error: code });
        throw new Error(code);
      }).finally(() => { externalOperation = null; browserHost.linaLoginPending = false; send({ event: 'state', state: snapshot() }); });
    send({ event: 'login-started', state: snapshot() });
    return externalOperation;
  };
  let mutation = null;
  process.on('message', async message => {
    if (!Number.isSafeInteger(message?.requestId)) return;
    let stage;
    const progress = value => { stage = value; refreshPhase = value; send({ event: 'state', state: snapshot() }); };
    try {
      let result;
      if (!['status', 'shutdown'].includes(message.action)) await browserHost.linaValidation?.done;
      switch (message.action) {
        case 'status': case 'validated-status': result = snapshot(); break;
        case 'setup-tools':
          if (mutation || runtimeHost.currentOperation()) throw new Error('busy');
          await runtimeHost.setupMcp({ tunnelId: message.input?.tunnelId || '', runtimeKey: message.input?.runtimeKey || '', replace: message.input?.replace === true, interactionMode: 'automatic' });
          stateStore.update({ coreSetupComplete: true, mcpRuntimeInstalled: true, mcpSetupComplete: false });
          result = snapshot(); break;
        case 'verify-tools': {
          if (mutation || runtimeHost.currentOperation() || browserHost.activeTraceId) throw new Error('busy');
          stateStore.update({ mcpSetupComplete: false });
          const report = await runtimeHost.doctor();
          if (!report.ok) throw new Error('tools_runtime_failed');
          try { await browserHost.verifyConnector(runtimeHost.mcpConnectorName()); }
          catch { throw new Error('tools_connector_missing'); }
          stateStore.update({ mcpSetupComplete: true });
          result = snapshot(); break;
        }
        case 'login': {
          if (!mutation) {
            mutation = browserHost.openLogin().catch(() => {}).finally(() => { mutation = null; });
          }
          result = snapshot(); break;
        }
        case 'cancel-login':
          if (externalLogin.status?.phase === 'finishing') throw new Error('busy');
          await externalLogin.cancel(); await externalOperation?.catch(() => {});
          result = snapshot(); break;
        case 'logout':
          await externalLogin.cancel(); await externalOperation?.catch(() => {});
          await runtimeSupervisor.cancelActiveTurns();
          await browserHost.logout();
          if (browserHost.linaValidation) { browserHost.linaValidation.cached = null; browserHost.linaValidation.error = null; browserHost.linaValidation.modelsRefreshed = false; }
          for (const name of ['lina-account-models.json', 'lina-model.json']) {
            const file = path.join(process.env.CODEX_CHATGPT_WEB_HOME, name); if (fs.existsSync(file)) fs.unlinkSync(file);
          }
          stateStore.update({ mcpSetupComplete: false, codexCatalogVerified: false });
          result = snapshot(); break;
        case 'refresh':
          if (mutation) throw new Error('busy');
          for (let attempt = 0; attempt < 50 && runtimeHost.currentOperation(); attempt++) await new Promise(resolve => setTimeout(resolve, 200));
          if (runtimeHost.currentOperation()) throw new Error('busy');
          // The upstream setup owns capability refresh, config journaling and daemon draining.
          progress('browser_auth');
          if (!browserHost.snapshot().authenticated) await browserHost.refreshAuthentication();
          if (!browserHost.snapshot().authenticated) throw new Error('authentication_required');
          progress('browser_models');
          const capabilities = await browserHost.inspectSession(true);
          modelLabel = capabilities.modelLabel || ''; modelEffort = capabilities.modelEffort || '';
          progress('bridge_setup');
          if (!runtimeHost.runtimeConfigSnapshot().configured) await runtimeHost.setupCore();
          else {
            const runtime = await runtimeSupervisor.startIfConfigured();
            if (runtime.status !== 'ready') throw new Error('bridge_config_out_of_sync');
            await runtimeHost.connectBridgeRoute();
          }
          stateStore.update({ coreSetupComplete: true, codexCatalogVerified: false });
          if (browserHost.linaValidation) browserHost.linaValidation.error = null;
          result = snapshot(); break;
        case 'shutdown':
          if (browserHost.linaValidation?.pending) {
            await runtimeSupervisor.shutdown({ cancelActiveTurns: true, force: true });
            await browserHost.persistSession(); browserHost.destroy(); app.exit(0); return;
          }
          await externalLogin.cancel(); await externalOperation?.catch(() => {});
          await runtimeSupervisor.cancelActiveTurns();
          result = await requestQuit(); break;
        default: throw new Error('unsupported_action');
      }
      send({ requestId: message.requestId, result });
    } catch (error) {
      // Private bridge errors may contain tokens, URLs or page text. Send only safe categories.
      const { errorInfo, createLog } = require('./codexWebSupport.cjs');
      let safe = errorInfo(error, stage);
      if (safe.code === 'request_failed') safe = errorInfo('bridge_operation_failed', stage);
      if (['authentication_required', 'chatgpt_session_expired'].includes(safe.code)) browserHost.setState({ authenticated: false, status: 'signed-out', message: 'Sign in to ChatGPT' });
      createLog(path.dirname(process.env.CODEX_HOME)).record('bridge.operation_failed', safe);
      send({ requestId: message.requestId, error: safe });
    } finally {
      if (message.action === 'refresh') { refreshPhase = null; send({ event: 'state', state: snapshot() }); }
    }
  });
  process.once('disconnect', () => { void externalLogin.cancel().then(() => runtimeSupervisor.shutdown({ cancelActiveTurns: true, force: true })).finally(() => app.exit(0)); });
  send({ event: 'ready', state: snapshot() });
  browserHost.linaOnValidationComplete = () => send({ event: 'validation-complete', state: snapshot(), error: browserHost.linaValidation?.error?.code });
  if (browserHost.linaValidation && !browserHost.linaValidation.pending) browserHost.linaOnValidationComplete();
}
module.exports = { bootstrap, attach, runtimeConnection, refreshStartupAuthentication, bundledRuntime, beginStartupValidation, validatedSession };
