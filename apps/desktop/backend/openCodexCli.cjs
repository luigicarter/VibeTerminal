#!/usr/bin/env node
"use strict";

// Dedicated Open Codex CLI entry point. Only the separately bundled executable
// is launched; neither PATH codex nor the user's Codex configuration is used.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');

function cleanEnvironment(source) {
  const env = { ...source };
  for (const key of Object.keys(env)) {
    if (/^(CODEX_HOME|CODEX_API_KEY|OPENAI_API_KEY|OPENAI_BASE_URL|OPENAI_ORG_ID|OPENAI_ORGANIZATION|OPENAI_PROJECT_ID|ELECTRON_RUN_AS_NODE)$/i.test(key)) delete env[key];
  }
  return env;
}
function launchSpec(source = process.env, argv = process.argv.slice(2)) {
  const binary = source.LINA_OPEN_CODEX_BIN;
  const home = source.LINA_OPEN_CODEX_HOME;
  const catalog = source.LINA_OPEN_CODEX_CATALOG;
  if (!binary || !path.isAbsolute(binary) || !fs.existsSync(binary)) throw new Error('Open Codex is missing its bundled runtime. Prepare or reinstall Lina Terminal.');
  if (!home || !catalog || !source.LINA_OPEN_CODEX_BASE_URL || !source.LINA_OPEN_CODEX_TOKEN || !source.LINA_OPEN_CODEX_MODEL)
    throw new Error('Launch Open Codex from Lina Terminal after configuring its providers in Settings.');
  const env = { ...cleanEnvironment(source), CODEX_HOME: home };
  fs.mkdirSync(home, { recursive: true });
  const overrides = {
    model: source.LINA_OPEN_CODEX_MODEL,
    model_provider: 'lina_open_codex',
    model_catalog_json: catalog,
    'model_providers.lina_open_codex.name': 'Open Codex',
    'model_providers.lina_open_codex.base_url': source.LINA_OPEN_CODEX_BASE_URL,
    'model_providers.lina_open_codex.env_key': 'LINA_OPEN_CODEX_TOKEN',
    'model_providers.lina_open_codex.wire_api': 'responses',
    'model_providers.lina_open_codex.requires_openai_auth': false,
    'model_providers.lina_open_codex.supports_websockets': false,
    web_search: 'disabled',
    // Use portable function tools; OpenAI-only hosted tools and model-routing
    // defaults must not silently escape the configured model catalog.
    'features.code_mode': false,
    'features.multi_agent': false,
    'features.goals': false,
    'features.fast_mode': false,
    'features.responses_websockets': false,
    'features.responses_websockets_v2': false,
    check_for_update_on_startup: false
  };
  const args = [...argv];
  for (const [key, value] of Object.entries(overrides)) args.push('-c', `${key}=${JSON.stringify(value)}`);
  const trust = source.VIBE_TERMINAL_CODEX_HOOK_TRUST_OVERRIDE;
  if (trust) args.push('-c', trust);
  const hooks = JSON.parse(source.VIBE_TERMINAL_CODEX_HOOK_OVERRIDES || '[]');
  for (const hook of hooks) if (typeof hook === 'string') args.push('-c', hook);
  const notify = source.VIBE_TERMINAL_NOTIFY_PROGRAM;
  if (notify) {
    const command = process.platform === 'win32' ? ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', notify, 'agent.completed'] : [notify, 'agent.completed'];
    args.push('-c', `notify=${JSON.stringify(command)}`);
  }
  return { binary, args, env };
}
async function post(type, extra = {}, env = process.env) {
  if (!env.VIBE_TERMINAL_CALLBACK_URL) return;
  try {
    await fetch(env.VIBE_TERMINAL_CALLBACK_URL, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-vibe-telemetry-token': env.VIBE_TERMINAL_TELEMETRY_TOKEN },
      body: JSON.stringify({ sessionId: env.VIBE_TERMINAL_SESSION_ID, launchNonce: env.VIBE_TERMINAL_LAUNCH_NONCE, provider: 'codex', type, ...extra }),
      signal: AbortSignal.timeout(1500) });
  } catch { /* telemetry availability must not stop the CLI */ }
}
async function main() {
  const processId = `open-codex:${randomUUID()}`;
  let spec;
  try { spec = launchSpec(); }
  catch (error) { process.stderr.write(`Open Codex: ${error.message}\n`); await post('agent.process.started', { processId }); await post('agent.process.exited', { processId, exitCode: 1, error: error.message }); process.exitCode = 1; return; }
  spec.env.VIBE_TERMINAL_INVOCATION_ID = processId;
  // Claim ownership before a fast native SessionStart hook can reach Lina.
  // The second event supplies the native PID once spawn has assigned it.
  await post('agent.process.started', { processId });
  const child = spawn(spec.binary, spec.args, { env: spec.env, stdio: 'inherit', windowsHide: true });
  const completion = new Promise(resolve => {
    child.once('error', () => resolve(1));
    child.once('exit', value => resolve(value ?? 1));
  });
  // ConPTY delivers Ctrl+C to the foreground native CLI. The wrapper remains
  // alive while Codex handles the interrupt, instead of orphaning the child.
  const interrupt = () => { if (process.platform !== 'win32') child.kill('SIGINT'); };
  const terminate = () => { try { child.kill('SIGTERM'); } catch {} };
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  await post('agent.process.started', { processId, pid: child.pid });
  const code = await completion;
  process.off('SIGINT', interrupt); process.off('SIGTERM', terminate);
  await post('agent.process.exited', { processId, exitCode: code });
  process.exitCode = code;
}
if (require.main === module) main().catch(() => { process.stderr.write('Open Codex could not start. Check its settings and bundled runtime.\n'); process.exitCode = 1; });
module.exports = { launchSpec, cleanEnvironment };
