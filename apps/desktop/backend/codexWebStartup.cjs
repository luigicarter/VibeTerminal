'use strict';
const fs = require('node:fs');
const path = require('node:path');
const ERRORS = {
  chatgpt_session_expired: [401, 'Your ChatGPT sign-in has expired. Use the pane menu → ChatGPT Web sign in. Your local history is kept.'],
  web_account_changed: [409, 'The ChatGPT account changed. Use the pane menu to sign in and reload its models before continuing.'],
  connection_failed: [503, 'Codex Web could not verify the saved login. Check the connection and retry.'],
  web_model_catalog_unavailable: [503, 'Codex Web could not refresh the saved model list. Use the pane menu → Refresh Web models.'],
};
const failure = code => ({ ok: false, status: ERRORS[code][0], code, message: ERRORS[code][1] });
function readStartupCache(home) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(home, 'lina-model-catalog.json'), 'utf8'));
    if (value._lina?.format !== 1 || typeof value._lina.accountKey !== 'string' || !value._lina.accountKey || !Number.isSafeInteger(value._lina.updatedAt) || value._lina.updatedAt > Date.now() || !Array.isArray(value.models) || !value.models.length) return null;
    return value._lina;
  } catch { return null; }
}
function startValidation(browserHost, { check, refreshModels, cached = null }) {
  const validation = { pending: true, cached, error: null, modelsRefreshed: false, done: null, finishedAt: 0,
    retry: () => startValidation(browserHost, { check, refreshModels, cached }) };
  browserHost.linaValidation = validation;
  validation.done = (async () => {
    try {
      await check();
      const state = browserHost.snapshot();
      if (!state.authenticated) {
        if (cached) validation.error = failure(state.status === 'signed-out' ? 'chatgpt_session_expired' : 'connection_failed');
        return;
      }
      if (cached && cached.accountKey !== state.linaAccountKey) { validation.error = failure('web_account_changed'); return; }
      if (cached && Date.now() - cached.updatedAt > 3600000) {
        try { await refreshModels(); validation.modelsRefreshed = true; }
        catch { validation.error = failure('web_model_catalog_unavailable'); }
      }
    } catch { validation.error = failure('connection_failed'); }
    finally { validation.pending = false; validation.finishedAt = Date.now(); browserHost.publishState?.(browserHost.snapshot()); browserHost.linaOnValidationComplete?.(); }
  })();
  return validation.done;
}
async function validatedSession(browserHost) {
  if (browserHost.linaLoginPending) return failure('chatgpt_session_expired');
  await browserHost.linaValidation?.done;
  const previous = browserHost.linaValidation;
  if (previous?.error?.status === 503 && Date.now() - previous.finishedAt >= 1000) await previous.retry();
  if (browserHost.linaValidation?.error) return browserHost.linaValidation.error;
  if (!browserHost.snapshot().authenticated) return failure('chatgpt_session_expired');
  return { ok: true };
}
async function waitForValidation(descriptor, signal) {
  // The caller supplies the upstream's validated private browser descriptor.
  const response = await fetch(descriptor.control.endpoint + '/v1/session/ready', {
    method: 'POST', headers: { authorization: 'Bearer ' + descriptor.control.token, 'content-type': 'application/json' }, body: '{}',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(90000)]) : AbortSignal.timeout(90000),
  });
  const value = await response.json();
  if (response.ok && value.ok === true) return { ok: true };
  return failure(Object.hasOwn(ERRORS, value.code) ? value.code : 'connection_failed');
}
module.exports = { readStartupCache, startValidation, validatedSession, waitForValidation };
