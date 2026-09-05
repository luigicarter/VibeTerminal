const { spawn } = require('child_process');
const { createOrchestratorHistory } = require('./orchestratorHistory.cjs');
const { findLatestAgentThread, isSamePath } = require('./agentThreadHost.cjs');

function parseOpenCodeExport(value, identity) {
  if (!value?.info || value.info.id !== identity.id || value.info.parentID || value.info.parentId || value.info.parent_id || !isSamePath(value.info.directory, identity.cwd)) throw new Error('OpenCode export did not match the selected root conversation.');
  return { status: 'found', messages: (Array.isArray(value.messages) ? value.messages : []).flatMap(message => {
    if (message.info?.sessionID !== identity.id || !['user', 'assistant'].includes(message.info?.role)) return [];
    const text = (Array.isArray(message.parts) ? message.parts : []).filter(part => part.type === 'text' && !part.synthetic && typeof part.text === 'string').map(part => part.text).join('\n');
    return text ? [{ role: message.info.role, text }] : [];
  }) };
}
function readOpenCodeExport(identity, envOverrides, spawnChild = spawn) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(identity.id || '')) return Promise.reject(new Error('Invalid conversation identity.'));
  return new Promise((resolve, reject) => {
    let child; let timer; let done = false; let bytes = 0; const chunks = [];
    function finish(error, result) { if (done) return; done = true; clearTimeout(timer); if (error) { child?.kill(); reject(error); } else resolve(result); }
    try {
      child = spawnChild('opencode', ['export', identity.id], { cwd: identity.cwd, env: envOverrides ? { ...process.env, ...envOverrides } : process.env, shell: process.platform === 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      timer = setTimeout(() => finish(new Error('OpenCode transcript export timed out.')), 15000);
      child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 8 * 1024 * 1024) return finish(new Error('OpenCode transcript exceeds the bounded export limit.')); if (!done) chunks.push(chunk); });
      child.on('error', () => finish(new Error('OpenCode transcript export is unavailable.')));
      child.on('close', code => {
        if (done) return;
        if (code !== 0) return finish(new Error('OpenCode transcript export failed.'));
        try { finish(null, parseOpenCodeExport(JSON.parse(Buffer.concat(chunks).toString('utf8')), identity)); }
        catch { finish(new Error('OpenCode export was malformed or did not match the selected root conversation.')); }
      });
    } catch { finish(new Error('OpenCode transcript export is unavailable.')); }
  });
}
function createHostService() {
  let config = {}; const homes = {};
  function openFusionEnv() {
    const env = config.openFusion?.env;
    if (!env || !env.XDG_DATA_HOME || !env.XDG_CONFIG_HOME) throw new Error('The app-owned Open Fusion store is unavailable.');
    return { XDG_DATA_HOME: env.XDG_DATA_HOME, XDG_CONFIG_HOME: env.XDG_CONFIG_HOME };
  }
  const service = createOrchestratorHistory({ homes, getStoreBinding: () => config.openFusion, getKnownScopes: () => config.scopes || [], lookupThreads: input => {
    const payload = { provider: input.provider, cwd: input.cwd, list: true, fusion: input.fusion, claudeHome: input.claudeHome };
    if (input.claudeHome === 'custom' && !homes.claudeCustom) throw new Error('Custom Claude history is unavailable.');
    if (input.openFusion) { payload.opencodeEnv = openFusionEnv(); payload.after = Number(config.openFusion.after) || 0; }
    return findLatestAgentThread(payload);
  }, readOpenCodeTranscript: identity => readOpenCodeExport(identity, identity.openFusion || identity.provider === 'openfusion' ? openFusionEnv() : undefined) });
  return { async dispatch(method, input, nextConfig) {
    config = nextConfig && typeof nextConfig === 'object' ? nextConfig : {};
    for (const key of Object.keys(homes)) delete homes[key];
    if (typeof config.homes?.claudeCustom === 'string') homes.claudeCustom = config.homes.claudeCustom;
    if (homes.claudeCustom) process.env.VIBE_CLAUDE_CUSTOM_HOME = homes.claudeCustom;
    else delete process.env.VIBE_CLAUDE_CUSTOM_HOME;
    if (!['list', 'read', 'search', 'resolve'].includes(method)) throw new Error('Unknown history operation.');
    return service[method](input);
  } };
}
if (require.main === module) {
  const host = createHostService(); let queue = Promise.resolve();
  process.on('message', message => { queue = queue.then(async () => {
    try { process.send?.({ id: message.id, result: await host.dispatch(message.method, message.input, message.config) }); }
    catch (error) { process.send?.({ id: message.id, error: String(error.message || 'Conversation history failed.').slice(0, 500) }); }
  }).catch(() => {}); });
  process.on('disconnect', () => process.exit(0));
}
module.exports = { createHostService, readOpenCodeExport, parseOpenCodeExport };
