'use strict';
const destinations = require('../shared/workspaceNavigation.json');
const WORKSPACE_VIEWS = Object.freeze(destinations.map(item => item.id));
const VOICE_CAPABILITIES = Object.freeze({
  followUp: 'Questions or listen responses open a temporary answer window; completed replies return to standby.',
  handsFree: 'Hey Lina activation; does not listen after every completed reply.',
  alwaysListenAfterReplySetting: false, changeVoiceSettingsTool: false
});
function workspaceMap({ ui, sessions = [], tasks = [], roots = {}, interactions = [], configuration } = {}) {
  const projects = Array.isArray(roots) ? roots : roots.projects || [];
  const current = ui?.ok === true && WORKSPACE_VIEWS.includes(ui.view) ? {
    view: ui.view, ...(typeof ui.projectId === 'string' && { projectId: ui.projectId }),
    ...(typeof ui.cwd === 'string' && { cwd: ui.cwd }),
    ...(typeof ui.selectedSessionId === 'string' && { selectedSessionId: ui.selectedSessionId }),
    ...(typeof ui.maximizedSessionId === 'string' && { maximizedSessionId: ui.maximizedSessionId }),
  } : null;
  const live = sessions.filter(session => !session.closed && session.started !== false &&
    !['exited', 'failed', 'paused', 'closed'].includes(session.status) && !['exited', 'failed'].includes(session.processState));
  const needsInput = session => session.pendingInteraction || session.pendingInteractions?.length || session.status === 'waiting' ||
    (!session.status && session.turnState === 'waiting') || interactions.some(request => request.sessionId === session.id && request.state === 'pending' &&
      (request.generation === undefined || request.generation === session.generation));
  // Directory status includes child/background activity and uncertainty; an old
  // root turnState alone cannot describe what the pane is currently doing.
  const active = session => ['running', 'busy', 'working', 'waiting'].includes(session.status || session.turnState);
  const config = configuration && {
    enabled: configuration.enabled === true, ready: configuration.ready === true,
    model: typeof configuration.model === 'string' ? configuration.model.slice(0, 240) : '',
    monitoringEnabled: configuration.monitoringEnabled === true,
    spendingLimit: Number.isFinite(configuration.spendingLimit) ? configuration.spendingLimit : null,
    ...(typeof configuration.sttModel === 'string' && { sttModel: configuration.sttModel.slice(0, 240) }),
    ...(typeof configuration.ttsModel === 'string' && { ttsModel: configuration.ttsModel.slice(0, 240) }),
    handsFreeEnabled: configuration.handsFreeEnabled === true
  };
  return { ok: true, current, observation: current ? 'observed' : 'unavailable',
    destinations: destinations.map(({ id, label, requiresCwd }) => ({ view: id, label, ...(requiresCwd && { requiresCwd: true }) })),
    projects: projects.slice(0, 30).map(project => typeof project === 'string' ? { path: project } : { id: project.id, name: project.name, path: project.path }),
    totalProjects: projects.length, projectsTruncated: projects.length > 30,
    terminals: { total: sessions.length, active: live.filter(active).length, needsInput: live.filter(needsInput).length },
    requests: { total: tasks.length, unfinished: tasks.filter(task => !['finished', 'failed', 'cancelled', 'continued'].includes(task.status)).length },
    voiceCapabilities: { ...VOICE_CAPABILITIES },
    ...(config && { orchestrator: config }),
    capabilities: {
      settings: { read: 'read_workspace', write: false, view: 'settings', note: 'No always-listen-after-reply setting exists.' },
      requests: { cancel: 'ui-only', retry: 'ui-only', note: 'Cancelling tracking does not stop an agent. Terminal interruption is a separate authorized operation.' },
      files: { read: true, search: 'names-only', directWrite: false, delegateEdits: true },
      externalApplications: { generalUiControl: false, revealFolder: 'open_folder' }
    },
    discovery: { terminals: 'list_sessions', liveOutputAndMenus: 'read_session', savedConversations: 'list_conversations', taskResults: 'list_work', files: 'search_files', fileContents: 'read_file', setups: 'list_setups' },
  };
}
module.exports = { WORKSPACE_VIEWS, workspaceMap, VOICE_CAPABILITIES };
