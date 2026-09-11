'use strict';
const path = require('node:path');
function resolveNativeBinary({ isPackaged, resourcesPath, root }) {
  const base = isPackaged ? resourcesPath : path.join(root, 'vendor');
  const file = path.join(base, 'codex-web/native', process.platform + '-' + process.arch, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex');
  if (!require('node:fs').existsSync(file)) throw new Error('Codex Web is missing its bundled CLI. Run npm run prepare:codex-web or reinstall Lina.');
  return file;
}
function privateNativeEnv(env, { terminal = false } = {}) {
  const result = { ...env };
  for (const key of Object.keys(result)) if (/^LINA_CODEX_WEB_/.test(key) || ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'ELECTRON_RUN_AS_NODE'].includes(key)) delete result[key];
  if (terminal) {
    // Lina's xterm supports truecolor. Agent-launched previews can inherit
    // NO_COLOR/TERM=dumb from a noninteractive parent; do not pass those
    // restrictions into this interactive native TUI.
    for (const key of Object.keys(result)) if (key.toUpperCase() === 'NO_COLOR') delete result[key];
    result.FORCE_COLOR = '3';
    result.COLORTERM = 'truecolor';
    if (!result.TERM || result.TERM === 'dumb') result.TERM = 'xterm-256color';
  }
  return result;
}
function nativeArgs(state, args = []) {
  const url = new URL(state.route);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !path.isAbsolute(state.catalogPath)) throw new Error('The local Web provider is not ready.');
  const flags = ['-c', 'model_provider="codex_web"', '-c', 'cli_auth_credentials_store="file"',
    '-c', 'model_catalog_json=' + JSON.stringify(state.catalogPath),
    // Codex uses this OpenAI provider name to retain native turn/message IDs.
    // Authentication is owned by the Web bridge; native login is optional.
    '-c', 'model_providers.codex_web={name="OpenAI",base_url=' + JSON.stringify(state.route) + ',wire_api="responses",requires_openai_auth=false,supports_websockets=false}',
    '-c', 'features.fast_mode=false', '-c', 'service_tier="default"',
    // Lina ships and validates this executable; a global CLI update cannot
    // update the embedded copy and must not interrupt its startup.
    '-c', 'check_for_update_on_startup=false'];
  if (state.imageTool && [state.imageTool.command, state.imageTool.entry, state.imageTool.home].every(value => typeof value === 'string' && path.isAbsolute(value))) {
    const codeMode = state.imageTool.codeMode;
    const direct = Array.isArray(codeMode?.direct_only_tool_namespaces) ? codeMode.direct_only_tool_namespaces.filter(value => typeof value === 'string') : [];
    flags.push('-c', 'mcp_servers.lina_images.command=' + JSON.stringify(state.imageTool.command),
      '-c', 'mcp_servers.lina_images.args=' + JSON.stringify([state.imageTool.entry, 'lina-image-mcp']),
      '-c', 'mcp_servers.lina_images.env={CODEX_HOME=' + JSON.stringify(path.dirname(state.catalogPath)) + ',CODEX_CHATGPT_WEB_HOME=' + JSON.stringify(state.imageTool.home) + ',LINA_CODEX_WEB_HOST_MODULE="1"}',
      '-c', 'mcp_servers.lina_images.tool_timeout_sec=300',
      '-c', 'mcp_servers.lina_images.required=true',
      '-c', 'features.code_mode.direct_only_tool_namespaces=' + JSON.stringify([...new Set([...direct, 'mcp__lina_images'])]));
    const enabled = typeof codeMode === 'boolean' ? codeMode : codeMode?.enabled;
    if (typeof enabled === 'boolean') flags.push('-c', 'features.code_mode.enabled=' + enabled);
  }
  const explicitModel = args.some(arg => arg === '-m' || arg === '--model' || arg.startsWith('--model=') || /^-m.+/.test(arg));
  if (!explicitModel) {
    flags.push('-c', 'model=' + JSON.stringify(state.model));
    if (state.effort) flags.push('-c', 'model_reasoning_effort=' + JSON.stringify(state.effort));
  }
  // Codex 0.144 can discard root -c values when a subcommand also has -c.
  // Keep every config override together at the active command level, preserving
  // explicit user overrides and the native end-of-options delimiter.
  const forwarded = [], overrides = [];
  let tail = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--') { tail = args.slice(index); break; }
    if (arg === '-c' || arg === '--config') { overrides.push(arg); if (index + 1 < args.length) overrides.push(args[++index]); }
    else if (arg.startsWith('--config=') || /^-c.+/.test(arg)) overrides.push(arg);
    else forwarded.push(arg);
  }
  return ['--no-alt-screen', ...forwarded, ...flags, ...overrides, ...tail];
}
module.exports = { nativeArgs, privateNativeEnv, resolveNativeBinary };
