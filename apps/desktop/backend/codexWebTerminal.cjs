'use strict';
// A small bootstrap only. The real Codex CLI owns the terminal and all conversations.
const { spawn } = require('node:child_process');
const readline = require('node:readline/promises');
const { nativeArgs, privateNativeEnv } = require('./codexWebNative.cjs');
const pane = { id: process.env.LINA_CODEX_WEB_PANE_ID, launchToken: Number(process.env.LINA_CODEX_WEB_LAUNCH_TOKEN) };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function call(action, extra = {}) {
  const response = await fetch(process.env.LINA_CODEX_WEB_CONTROL_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.LINA_CODEX_WEB_CONTROL_KEY },
    body: JSON.stringify({ ...pane, action, ...extra }), signal: AbortSignal.timeout(action === 'setup-tools' ? 660000 : ['refresh', 'verify-tools'].includes(action) ? 360000 : 90000),
  });
  if (!response.ok) throw new Error('Could not reach Lina. Restart this terminal.');
  const result = await response.json();
  if (!result.ok) throw new Error((result.error?.message || 'Codex Web could not connect.') + (result.error?.reference ? ' [' + result.error.reference + ']' : ''));
  return result;
}
async function prompt(message) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try { return await rl.question(message); } finally { rl.close(); process.stdin.pause(); }
}
async function signIn() {
  console.log('Opening ChatGPT sign-in in your browser…');
  await call('login');
  for (;;) {
    await sleep(700);
    const state = (await call('terminal-status')).state;
    if (state.connection.authenticated && !state.connection.loginPending) return;
    if (state.error) throw new Error(state.error.message);
    if (!state.connection.loginPending) throw new Error('ChatGPT sign-in did not finish. Try signing in again.');
  }
}
async function prepare() {
  let state = (await call('terminal-status')).state;
  if (state.cachedStartupAllowed && state.models?.length && state.route) return state;
  if (state.connection.checkingLogin) {
    if (state.models?.length && state.route) return state;
    state = (await call('validated-status')).state;
  }
  if (!state.connection.authenticated && !state.connection.loginPending && ['error', 'loading'].includes(state.connection.browserStatus)) throw new Error('Could not verify the saved ChatGPT login. Check the connection and retry.');
  if (state.connection.loginExpired) console.log('Your saved ChatGPT sign-in has expired. Sign in again to continue.');
  if (!state.connection.authenticated || state.connection.loginPending) { await signIn(); state = (await call('terminal-status')).state; }
  if (!state.models?.length || !state.route) state = (await call('refresh')).state;
  return state;
}
async function main() {
  const binary = process.env.LINA_CODEX_WEB_CODEX_BIN;
  if (!binary || !pane.id || !process.env.LINA_CODEX_WEB_CONTROL_KEY) throw new Error('Launch Codex Web from Lina.');
  const cliArgs = process.argv.slice(2);
  if (cliArgs[0] === 'logout') { await call('logout'); console.log('Signed out of Codex Web.'); return; }
  if (cliArgs[0] === 'login') { await signIn(); console.log('Signed in to Codex Web.'); return; }
  let state;
  for (;;) {
    const progress = setTimeout(() => console.log('Starting Codex Web…'), 1500);
    try {
      state = await prepare();
      if (!state.model) throw new Error('This ChatGPT account has no thinking models available. Sign in with an account that exposes a thinking model.');
      break;
    }
    catch (error) {
      clearTimeout(progress);
      console.error('\nCodex Web: ' + error.message);
      const choice = (await prompt('\nEnter to retry · l to sign in · d for diagnostics · q to quit: ')).trim().toLowerCase();
      if (choice === 'q') return;
      if (choice === 'l') await signIn().catch(error => console.error('Codex Web: ' + error.message));
      if (choice === 'd') await call('diagnostics').catch(error => console.error('Codex Web: ' + error.message));
    }
    finally { clearTimeout(progress); }
  }
  const child = spawn(binary, nativeArgs(state, cliArgs), { env: privateNativeEnv(process.env, { terminal: true }), cwd: process.cwd(), stdio: 'inherit', windowsHide: true });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => { process.exitCode = code || 0; resolve(); });
  });
}
const lifetime = setInterval(() => {}, 1000);
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => clearInterval(lifetime));
