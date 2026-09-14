'use strict';
const path = require('node:path');
const PROVIDERS = new Set(['claude', 'codex', 'open-codex', 'codex-web', 'opencode', 'cursor', 'gemini', 'kimi', 'kimi-custom', 'qwen', 'grok']);
const CONFIG_FIELDS = ['providerProfileId', 'providerModelOverride', 'openCodexModel', 'fusionPlannerFamily', 'fusionPlannerModel', 'fusionPlannerEffort', 'fusionPlannerFast', 'fusionExecutorFamily', 'fusionExecutorModel', 'fusionExecutorEffort', 'fusionExecutorFast', 'fusionRunMode', 'openFusionPlannerModel', 'openFusionExecutorModel', 'openFusionRunMode'];
const SESSION_FIELDS = ['id', 'name', 'kind', 'command', 'cwd', 'createdAt', 'threadRef', 'resumeRef', 'threadSelectionPending', 'nextLaunchMode', 'started', 'launchToken', 'status', 'layout', 'tileId', 'splitTree', 'fusion', 'openFusion', 'chat', ...CONFIG_FIELDS];
// Providers whose native conversation store is one directory. kimi-custom is
// the vendored fork and reads/writes the same home as stock kimi
// (agentThreadHost's kimiCustomHome() returns kimiHome()), so a session id
// there proves nothing about which of the two produced it: "is this
// conversation already taken" must be asked per store, not per provider label.
// Claude's custom profile is deliberately absent - it scans a different home
// (VIBE_CLAUDE_CUSTOM_HOME) and callers separate it by its own home field.
const STORE_FAMILIES = { 'kimi-custom': 'kimi' };
function storeFamily(provider) { return STORE_FAMILIES[provider] || provider; }
function folder(value) {
  const windows = /^[a-z]:[\\/]|^\\\\|^\/\//i.test(value || '');
  const normalized = (windows ? path.win32 : path.posix).normalize(String(value || '')).replace(/\\/g, '/').replace(/\/+$/, '');
  return windows ? normalized.toLowerCase() : normalized;
}
function identity(value) {
  if (!value || typeof value !== 'object') return null;
  const provider = value.provider === 'fusion' ? value.plannerProvider || value.fusionPlannerFamily || 'claude' : value.provider === 'openfusion' ? 'opencode' : value.provider === 'claude-custom' ? 'claude' : value.provider;
  if (!PROVIDERS.has(provider) || typeof value.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(value.id) || typeof value.cwd !== 'string' || !path.isAbsolute(value.cwd)) return null;
  return { ...value, provider, fusion: value.provider === 'fusion' || value.fusion || undefined, openFusion: value.provider === 'openfusion' || value.openFusion || undefined,
    claudeHome: value.provider === 'claude-custom' || value.claudeHome === 'custom' ? 'custom' : undefined };
}
function key(value) {
  const item = identity(value);
  if (!item) return null;
  return JSON.stringify([storeFamily(item.provider), item.provider === 'claude' ? item.claudeHome || 'global' : item.provider === 'opencode' && item.openFusion ? 'openfusion' : 'global', folder(item.cwd), item.id]);
}
function fromSession(session, ref = session.threadRef) {
  if (!ref?.id) return null;
  return identity({ ...Object.fromEntries(CONFIG_FIELDS.filter(field => session[field] !== undefined).map(field => [field, session[field]])),
    provider: ref.provider, id: ref.id, cwd: session.cwd, title: ref.title || session.name, createdAt: ref.createdAt || session.createdAt, updatedAt: ref.updatedAt || session.createdAt,
    claudeHome: session.providerProfileId ? 'custom' : undefined, fusion: session.fusion, openFusion: session.openFusion });
}
function cleanSession(value) {
  if (!value || typeof value.id !== 'string' || value.id.length > 200 || typeof value.cwd !== 'string' || !path.isAbsolute(value.cwd) || typeof value.kind !== 'string') throw new Error('Invalid saved pane.');
  const result = Object.fromEntries(SESSION_FIELDS.filter(field => value[field] !== undefined).map(field => [field, value[field]]));
  if (JSON.stringify(result).length > 64000) throw new Error('Saved pane is too large.');
  // A snapshot carries data only; only explicitly selected launchers interpret commands.
  return JSON.parse(JSON.stringify(result));
}
function cleanWorkspace(value) {
  if (!value || !Array.isArray(value.workspaces) || !Array.isArray(value.multiSessions) || value.workspaces.length > 500 || value.multiSessions.length > 1000) throw new Error('Invalid workspace snapshot.');
  const workspaces = value.workspaces.map(project => {
    if (typeof project.id !== 'string' || typeof project.name !== 'string' || typeof project.path !== 'string' || !path.isAbsolute(project.path) || !Array.isArray(project.sessions) || project.sessions.length > 1000) throw new Error('Invalid saved project.');
    return { id: project.id.slice(0, 200), name: project.name.slice(0, 200), path: project.path, sessions: project.sessions.map(cleanSession) };
  });
  const result = { workspaces, multiSessions: value.multiSessions.map(cleanSession), activeWorkspaceId: typeof value.activeWorkspaceId === 'string' ? value.activeWorkspaceId : null, activeView: value.activeView === 'multi' ? 'multi' : 'project' };
  const ids = new Set();
  for (const pane of [...result.multiSessions, ...workspaces.flatMap(project => project.sessions)]) { if (ids.has(pane.id)) throw new Error('Duplicate pane identity.'); ids.add(pane.id); }
  if (JSON.stringify(result).length > 16 * 1024 * 1024) throw new Error('Workspace snapshot is too large.');
  return result;
}
module.exports = { PROVIDERS, CONFIG_FIELDS, SESSION_FIELDS, folder, storeFamily, identity, key, fromSession, cleanSession, cleanWorkspace };
