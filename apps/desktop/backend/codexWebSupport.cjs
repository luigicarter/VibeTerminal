'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const TOML = require('@iarna/toml');

const MESSAGES = {
  image_unavailable: 'This generated image is missing or cannot be opened. Generate it again if the file was removed.',
  image_open_failed: 'Windows could not open this image. Check that an image viewer is configured.',
  image_input_invalid: 'This image is missing or unsupported. Attach a local PNG, JPEG, GIF or WebP file.',
  image_input_limit: 'Attach at most 10 images, no larger than 20 MB each or 50 MB combined.',
  authentication_required: 'Sign in to ChatGPT to continue.',
  chatgpt_session_expired: 'Your ChatGPT session has expired. Sign in again to continue.',
  web_account_changed: 'The ChatGPT account changed. Use the pane menu to sign in and reload its models. Local history is kept.',
  rate_limit_exceeded: 'ChatGPT has reached a usage limit. Check ChatGPT for when you can try again.',
  chatgpt_subscription_unavailable: 'ChatGPT could not load your subscription. Check the connection and retry.',
  model_unavailable: 'This model is no longer available. Use the pane menu to refresh Web models, then choose one with /model.',
  web_model_catalog_unavailable: 'ChatGPT could not return this account’s model catalog. Retry model loading; the saved login is kept.',
  model_effort_unavailable: 'ChatGPT did not expose the requested reasoning level for this model. Choose an available level with /model.',
  model_selection_failed: 'ChatGPT did not select the requested model. Use the pane menu to refresh Web models, then choose one with /model.',
  setup_required: 'Complete the ChatGPT browser and tools setup, then check the connection.',
  connection_failed: 'Codex Web could not connect. Check your connection and try again.',
  config_invalid: 'Codex Web could not read its private configuration. Open diagnostics for the setup error.',
  storage_failed: 'Codex Web could not update its local app data. Check file access and available disk space, then retry.',
  tools_runtime_failed: 'The local tools connection is not ready. Check the tunnel ID and its Tunnels Read + Use key, then retry setup.',
  tools_connector_missing: 'ChatGPT could not find the configured tools connector. Complete the connector step in your browser, then verify again.',
  browser_viewport_unavailable: 'The background browser could not display its model controls. Restart Codex Web to reload its browser viewport.',
  browser_model_menu_unavailable: 'ChatGPT did not expose usable model controls. Retry model loading; your saved login has been kept.',
  bridge_config_out_of_sync: 'The private Web model connection settings are out of sync. Restart Codex Web to repair the connection.',
  runtime_missing: 'The Codex Web runtime is missing. Prepare the runtime or reinstall Lina.',
  bridge_operation_failed: 'Codex Web could not complete that operation. Open diagnostics to inspect the connection.',
  busy: 'Wait for the current operation or stop it before changing this connection.',
  client_cancelled: 'Stopped.',
  request_failed: 'Codex Web encountered an error. Check the connection before retrying. The request was not automatically repeated.',
  browser_capacity: 'The ChatGPT task tabs are all in use. Finish an active task or restart Codex Web when the other tasks are idle.',
  manual_mode_unsupported: 'Codex Web needs automatic browser mode. Reconnect using Codex Web tools setup.',
  login_browser_missing: 'Codex Web needs Chrome or Edge for browser sign-in. Install either browser and try again.',
  external_login_timeout: 'Browser sign-in timed out. Choose Sign in to try again.',
  external_login_failed: 'The browser sign-in could not be completed. Close its dedicated login window and try again.',
  external_login_closed: 'The login browser closed before Lina confirmed the session. Keep that window open until sign-in finishes, then try again.',
};
const STAGES = new Set(['capabilities', 'bridge_start', 'browser_status', 'browser_auth', 'browser_models', 'bridge_setup', 'harness_start', 'account_read', 'model_list', 'model_filter']);
function errorInfo(error, stage) {
  const raw = typeof error === 'string' ? error : [error?.code, error?.message, error?.error?.message, error?.error?.code].filter(Boolean).join(' ');
  const fields = [error, error?.code, error?.message, error?.error?.code, error?.error?.message];
  let code = Object.keys(MESSAGES).find(code => fields.includes(code) || raw.includes('"' + code + '"'));
  if (!code) {
    if (/outside.*viewport|not in.*viewport/i.test(raw)) code = 'browser_viewport_unavailable';
    else if (/route marker changed|interrupt lifecycle hook.*changed|\[features\].*changed/i.test(raw)) code = 'bridge_config_out_of_sync';
    else if (/locator\.(?:click|waitFor)|model controls.*unavailable|stable composer|effort control did not expose/i.test(raw)) code = 'browser_model_menu_unavailable';
    else if (error?.name === 'TomlError') code = 'config_invalid';
    else if (['EACCES', 'EPERM', 'ENOSPC', 'EROFS'].includes(error?.code)) code = 'storage_failed';
    else if (/chatgpt_session_expired|ChatGPT session has expired/i.test(raw)) code = 'chatgpt_session_expired';
    else if (/rate_limit_exceeded|too many requests/i.test(raw)) code = 'rate_limit_exceeded';
    else if (/chatgpt_subscription_unavailable/i.test(raw)) code = 'chatgpt_subscription_unavailable';
    else if (/(?:five|5).*(?:tabs|turns)|all.*task tabs.*use|browser.*capacity/i.test(raw)) code = 'browser_capacity';
    else if (/ETIMEDOUT|ECONNREFUSED|ENOTFOUND|fetch failed|timeout waiting/i.test(raw)) code = 'connection_failed';
    else code = 'request_failed';
  }
  const info = { code, message: MESSAGES[code], reference: crypto.randomUUID() };
  if (STAGES.has(stage || error?.stage)) info.stage = stage || error.stage;
  if (error?.name === 'TomlError') {
    if (Number.isSafeInteger(error.line)) info.line = error.line + 1;
    if (Number.isSafeInteger(error.col)) info.column = error.col + 1;
  }
  if (Number.isSafeInteger(error?.code)) info.rpcCode = error.code;
  return info;
}
function webModels(rows, { includePickerHidden = false } = {}) {
  const seen = new Set();
  return (Array.isArray(rows) ? rows : []).filter(row => {
    const id = row?.id ?? row?.slug;
    const webId = typeof id === 'string' && (/^chatgpt-web\/[a-z0-9][a-z0-9.-]{0,100}$/.test(id) || (/^[a-z0-9][a-z0-9.-]{0,100}$/.test(id) && /^[a-z0-9][a-z0-9.-]{0,100}$/.test(row._lina_web_slug || '')));
    if (!webId || row.hidden === true || (row.visibility === 'hide' && !(includePickerHidden && row._lina_web_picker_hidden === true)) || seen.has(id)) return false;
    seen.add(id); return true;
  }).map(row => {
    const levels = row.supportedReasoningEfforts ?? row.supported_reasoning_levels ?? [];
    const effort = row.defaultReasoningEffort ?? row.default_reasoning_level ?? levels[0]?.reasoningEffort ?? levels[0]?.effort;
    return { id: row.id ?? row.slug, label: String(row.displayName ?? row.display_name ?? row.id ?? row.slug).slice(0, 120),
      ...(row.visibility === 'hide' ? { hidden: true } : {}),
      ...(Array.isArray(row._lina_web_aliases) ? { aliases: row._lina_web_aliases.filter(value => typeof value === 'string' && /^chatgpt-web\/[a-z0-9][a-z0-9.-]{0,100}$/.test(value)) } : {}),
      effort: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(effort) ? effort : undefined,
      ...(levels.length > 1 ? { efforts: levels.map(level => level.reasoningEffort ?? level.effort).filter(value => ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(value)) } : {}) };
  });
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  try { fs.renameSync(temporary, file); } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
function preferredWebModel(models, saved) {
  const previous = models.find(model => model.id === saved || model.aliases?.includes(saved)); if (previous) return previous;
  const astra = models.filter(model => !model.hidden && /(?:\bgpt[\s-]*6\b|\bastra\b)/i.test(model.label));
  return astra.find(model => !/\bpro\b/i.test(model.label)) || astra[0] || null;
}
function syncCapabilities(globalHome, home) {
  if (path.resolve(globalHome).toLowerCase() === path.resolve(home).toLowerCase()) throw new Error('Codex Web requires a separate authentication home.');
  fs.mkdirSync(home, { recursive: true });
  // Link capability content, never authentication, session history, or the global config file.
  for (const folder of ['skills', 'plugins', 'rules']) {
    const source = path.join(globalHome, folder), destination = path.join(home, folder);
    if (fs.existsSync(source) && !fs.existsSync(destination)) fs.symlinkSync(source, destination, process.platform === 'win32' ? 'junction' : 'dir');
  }
  let globalConfig = {}, own = {};
  if (fs.existsSync(path.join(globalHome, 'config.toml'))) globalConfig = TOML.parse(fs.readFileSync(path.join(globalHome, 'config.toml'), 'utf8'));
  const ownFile = path.join(home, 'config.toml');
  let repaired = false, original = '', normalized = '';
  if (fs.existsSync(ownFile)) {
    original = fs.readFileSync(ownFile, 'utf8'); normalized = original;
    try { own = TOML.parse(original); }
    catch (error) {
      // Older Lina setup emitted an empty inline features table. The bridge
      // then appended [features], making TOML invalid. Repair only that known
      // empty duplicate, and validate the entire result before writing it.
      const lines = original.split(/\r?\n/);
      const firstTable = lines.findIndex(line => /^\s*\[/.test(line));
      const empty = lines.findIndex((line, index) => index < firstTable && /^\s*features\s*=\s*\{\s*\}\s*(?:#.*)?$/.test(line));
      if (empty < 0 || !lines.some(line => /^\s*\[features\]\s*(?:#.*)?$/.test(line)) || !original.includes('# Managed by codex-chatgpt-web:')) throw error;
      lines.splice(empty, 1);
      normalized = lines.join('\n'); own = TOML.parse(normalized); repaired = true;
    }
  }
  const before = structuredClone(own);
  // Inherit the user's actual Codex permission policy, including the selected
  // global profile. Do not replace it with a Web-specific sandbox policy.
  const sharedSettings = ['approval_policy', 'approvals_reviewer', 'sandbox_mode', 'sandbox_workspace_write', 'windows', 'permissions', 'default_permissions', 'shell_environment_policy'];
  const selectedProfile = globalConfig.profiles?.[globalConfig.profile] || {};
  for (const key of sharedSettings) {
    const value = selectedProfile[key] ?? globalConfig[key];
    if (value !== undefined) own[key] = structuredClone(value);
    else delete own[key];
  }
  for (const key of ['mcp_servers', 'plugins', 'skills']) {
    if (globalConfig[key] !== undefined) own[key] = globalConfig[key];
    else delete own[key];
  }
  own.features ||= {};
  own.projects = { ...(globalConfig.projects || {}), ...(own.projects || {}) };
  for (const key of ['apps', 'plugins']) {
    if (typeof globalConfig.features?.[key] === 'boolean') own.features[key] = globalConfig.features[key];
  }
  // The bridge edits explicit TOML tables. Do not serialize an empty features
  // object as `features = { }`, which cannot later be reopened as [features].
  if (!Object.keys(own.features).length) delete own.features;
  // File-backed auth in this private home must not resolve a shared OS credential-store login.
  own.cli_auth_credentials_store = 'file';
  own.mcp_oauth_credentials_store = 'file';
  const next = require('./codexWebConfig.cjs').privateConfigText(normalized, before, own, home);
  if (next !== original) {
    const temporary = ownFile + '.tmp';
    fs.writeFileSync(temporary, next, { mode: 0o600 }); fs.renameSync(temporary, ownFile);
  }
  // Global user instructions remain available without pointing Codex at global auth.
  for (const file of ['AGENTS.md', 'AGENTS.override.md']) {
    const source = path.join(globalHome, file), target = path.join(home, file);
    if (fs.existsSync(source)) fs.copyFileSync(source, target);
    else if (fs.existsSync(target)) fs.unlinkSync(target);
  }
  return { repaired };
}
function createLog(home, { maxBytes = 5 * 1024 * 1024, files = 5, now = Date.now, versions = {} } = {}) {
  const directory = path.join(home, 'logs'), file = path.join(directory, 'codex-web.jsonl');
  let failed = false;
  function record(event, fields = {}) {
    try {
      fs.mkdirSync(directory, { recursive: true });
      for (const entry of fs.readdirSync(directory).filter(name => /^codex-web\.jsonl(?:\.[1-4])?$/.test(name))) {
        const target = path.join(directory, entry);
        if (now() - fs.statSync(target).mtimeMs > 7 * 86400000) fs.unlinkSync(target);
      }
      const data = { time: new Date(now()).toISOString(), level: fields.code ? 'error' : 'info', event: /^[a-z_.-]{1,64}$/.test(event) ? event : 'unknown' };
      for (const key of ['appVersion', 'bridgeVersion', 'codexVersion']) if (/^[a-z0-9._+-]{1,40}$/i.test(versions[key] || '')) data[key] = versions[key];
      if (Object.hasOwn(MESSAGES, fields.code)) data.code = fields.code;
      if (/^[a-f0-9-]{36}$/.test(fields.reference || '')) data.reference = fields.reference;
      if (STAGES.has(fields.stage)) data.stage = fields.stage;
      for (const key of ['count', 'elapsedMs', 'generation', 'exitCode', 'line', 'column', 'rpcCode']) if (Number.isSafeInteger(fields[key])) data[key] = fields[key];
      const line = JSON.stringify(data) + '\n';
      if (fs.existsSync(file) && fs.statSync(file).size + Buffer.byteLength(line) > maxBytes) {
        const oldest = file + '.' + (files - 1); if (fs.existsSync(oldest)) fs.unlinkSync(oldest);
        for (let i = files - 2; i >= 1; i--) if (fs.existsSync(file + '.' + i)) fs.renameSync(file + '.' + i, file + '.' + (i + 1));
        fs.renameSync(file, file + '.1');
      }
      fs.appendFileSync(file, line, { mode: 0o600 }); failed = false;
    } catch { failed = true; }
  }
  return { record, directory, get failed() { return failed; } };
}
module.exports = { errorInfo, webModels, writeJson, syncCapabilities, createLog, preferredWebModel };
