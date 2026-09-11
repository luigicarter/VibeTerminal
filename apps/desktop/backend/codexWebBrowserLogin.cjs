'use strict';
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const LOGIN_URL = 'https://chatgpt.com/?temporary-chat=true';

function resolveLoginBrowser({ env = process.env, exists = fs.existsSync, query = execFileSync } = {}) {
  let preference = '';
  try { preference = query('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice', '/v', 'ProgId'], { encoding: 'utf8', windowsHide: true, timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }); } catch {}
  const chrome = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter(Boolean).map(root => ({ name: 'Chrome', executable: path.join(root, 'Google/Chrome/Application/chrome.exe') }));
  const edge = [env['ProgramFiles(x86)'], env.ProgramFiles, env.LOCALAPPDATA].filter(Boolean).map(root => ({ name: 'Edge', executable: path.join(root, 'Microsoft/Edge/Application/msedge.exe') }));
  const result = (/MSEdgeHTM/i.test(preference) ? [...edge, ...chrome] : [...chrome, ...edge]).find(browser => exists(browser.executable));
  if (!result) throw new Error('login_browser_missing');
  return result;
}
function browserLoginArgs(profile, port, url = LOGIN_URL) {
  if (!path.isAbsolute(profile) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid login browser configuration.');
  return [`--user-data-dir=${profile}`, '--new-window', '--no-first-run', '--no-default-browser-check', '--disable-background-mode',
    '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`, url];
}
function filterLoginState(state) {
  if (!state || !Array.isArray(state.cookies) || !Array.isArray(state.origins)) throw new Error('external_login_failed');
  const allowed = domain => typeof domain === 'string' && /^(?:\.?)(?:[a-z0-9-]+\.)*(?:chatgpt\.com|openai\.com)$/i.test(domain);
  // Identity-provider cookies and unrelated browsing state never leave the dedicated browser.
  return { cookies: state.cookies.filter(cookie => allowed(cookie.domain) && cookie.partitionKey === undefined),
    origins: state.origins.filter(origin => origin.origin === 'https://chatgpt.com') };
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('client_cancelled')); return; }
    const abort = () => { clearTimeout(timer); reject(new Error('client_cancelled')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}
function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('client_cancelled'));
    if (signal.aborted) { reject(new Error('client_cancelled')); return; }
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
async function authenticatedPage(page) {
  try {
    if (new URL(page.url()).origin !== 'https://chatgpt.com') return false;
    return await page.evaluate(async () => {
      const url = new URL(location.href);
      if (url.origin !== 'https://chatgpt.com') return false;
      const composer = document.querySelector('#prompt-textarea,[data-testid="prompt-textarea"],[contenteditable="true"][data-lexical-editor="true"]');
      if (!composer || !composer.getClientRects().length) return false;
      const response = await fetch('/api/auth/session', { credentials: 'include', cache: 'no-store', signal: AbortSignal.timeout(5000) });
      if (!response.ok || new URL(response.url).origin !== 'https://chatgpt.com' || new URL(response.url).pathname !== '/api/auth/session' || !response.headers.get('content-type')?.includes('application/json')) return false;
      const state = await response.json();
      return !!state.user && typeof state.user === 'object' && Object.keys(state.user).length > 0 && !state.error
        && (!state.expires || Date.parse(state.expires) > Date.now());
    });
  } catch { return false; }
}
function createBrowserLogin({ userData, chromium, importState, publish = () => {}, log = () => {},
  chooseBrowser = resolveLoginBrowser, spawnBrowser = spawn, portProvider = freePort,
  verifyPage = authenticatedPage, timeoutMs = 10 * 60 * 1000, pollMs = 1500, loginUrl = LOGIN_URL } = {}) {
  const root = path.join(userData, 'external-login');
  let operation = null, controller = null, status = null;
  function update(phase, browser) { status = phase ? { phase, browser } : null; publish(status); }
  function start() {
    if (operation) return operation;
    const abort = new AbortController(); controller = abort;
    operation = run(abort).finally(() => { operation = null; controller = null; update(null); });
    return operation;
  }
  async function run(abort) {
    let child, browser, profile, browserName;
    let primaryError;
    const deadline = setTimeout(() => abort.abort('timeout'), timeoutMs);
    function assertActive() { if (abort.signal.aborted) throw new Error(abort.signal.reason === 'timeout' ? 'external_login_timeout' : 'client_cancelled'); }
    async function closeOwnedBrowser() {
      if (browser) {
        try { const control = await browser.newBrowserCDPSession(); await control.send('Browser.close'); } catch {}
        await browser.close().catch(() => {}); browser = null;
      }
      if (child && child.exitCode === null && child.signalCode === null) {
        await new Promise(resolve => {
          const timer = setTimeout(resolve, 1500);
          child.once('exit', () => { clearTimeout(timer); resolve(); });
        });
      }
      if (child?.pid && child.exitCode === null && child.signalCode === null) {
        // This is only the process created with our new, unique app-owned profile.
        await new Promise(resolve => {
          const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          killer.once('error', resolve); killer.once('exit', resolve);
        });
      }
    }
    async function cleanup() {
      if (!profile || !fs.existsSync(profile)) return;
      const parent = fs.realpathSync(root), target = fs.realpathSync(profile), relative = path.relative(parent, target);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || fs.lstatSync(profile).isSymbolicLink()) throw new Error('external_login_cleanup_failed');
      try { await fs.promises.rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 }); }
      catch { log('login.cleanup_failed'); } // Retained only under app data; never export this directory.
    }
    try {
      const selected = chooseBrowser(); browserName = selected.name;
      fs.mkdirSync(root, { recursive: true, mode: 0o700 });
      profile = fs.mkdtempSync(path.join(root, 'attempt-'));
      const port = await portProvider(); assertActive();
      update('opening', browserName); log('login.browser_opening');
      child = spawnBrowser(selected.executable, browserLoginArgs(profile, port, loginUrl), { windowsHide: false, stdio: 'ignore' });
      let spawnFailed = false;
      child.once('error', () => { spawnFailed = true; abort.abort('launch'); });
      const connectDeadline = Date.now() + 30000;
      while (!browser && Date.now() < connectDeadline) {
        assertActive();
        if (spawnFailed) throw new Error('external_login_failed');
        // Chrome can hand the window off and exit its launcher process. The
        // dedicated profile's CDP connection is the authority once available.
        try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 1200 }); }
        catch { await delay(250, abort.signal); }
      }
      if (!browser) throw new Error('external_login_failed');
      log('login.browser_connected');
      update('waiting', browserName);
      while (true) {
        assertActive();
        if (!browser.isConnected()) throw new Error('external_login_closed');
        const context = browser.contexts()[0];
        let verified = false;
        for (const page of context?.pages() || []) { if (await abortable(verifyPage(page), abort.signal)) { verified = true; break; } }
        assertActive();
        if (verified) {
          log('login.browser_authenticated');
          update('finishing', browserName);
          const storageState = filterLoginState(await abortable(context.storageState(), abort.signal));
          assertActive(); await closeOwnedBrowser(); assertActive();
          clearTimeout(deadline); // The bridge's verified import has its own bounded timeout.
          await importState({ storageState, cleanup });
          log('login.browser_completed'); return;
        }
        await delay(pollMs, abort.signal);
      }
    } catch (error) {
      primaryError = abort.signal.reason === 'timeout' ? new Error('external_login_timeout') : error;
      log('login.browser_failed');
    } finally {
      clearTimeout(deadline);
      await closeOwnedBrowser(); await cleanup();
    }
    if (primaryError) throw primaryError;
  }
  async function cancel() { controller?.abort('cancel'); if (operation) await operation.catch(() => {}); }
  return { start, cancel, get status() { return status; } };
}
module.exports = { resolveLoginBrowser, browserLoginArgs, filterLoginState, authenticatedPage, createBrowserLogin };
