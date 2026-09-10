'use strict';
const destinations = require('../shared/workspaceNavigation.json');
const WORKSPACE_VIEWS = Object.freeze(destinations.map(item => item.id));
function workspaceMap({ ui, sessions = [], tasks = [], roots = {} } = {}) {
  const projects = Array.isArray(roots) ? roots : roots.projects || [];
  const current = ui?.ok === true && WORKSPACE_VIEWS.includes(ui.view) ? {
    view: ui.view, ...(typeof ui.projectId === 'string' && { projectId: ui.projectId }),
    ...(typeof ui.cwd === 'string' && { cwd: ui.cwd }),
    ...(typeof ui.selectedSessionId === 'string' && { selectedSessionId: ui.selectedSessionId }),
    ...(typeof ui.maximizedSessionId === 'string' && { maximizedSessionId: ui.maximizedSessionId }),
  } : null;
  return { ok: true, current, observation: current ? 'observed' : 'unavailable',
    destinations: destinations.map(({ id, label, requiresCwd }) => ({ view: id, label, ...(requiresCwd && { requiresCwd: true }) })),
    projects: projects.slice(0, 30).map(project => typeof project === 'string' ? { path: project } : { id: project.id, name: project.name, path: project.path }),
    totalProjects: projects.length, projectsTruncated: projects.length > 30,
    terminals: { total: sessions.length, active: sessions.filter(session => ['running', 'busy', 'waiting'].includes(session.turnState)).length,
      needsInput: sessions.filter(session => session.pendingInteraction || session.pendingInteractions?.length || session.turnState === 'waiting').length },
    requests: { total: tasks.length, unfinished: tasks.filter(task => !['finished', 'failed', 'cancelled', 'continued'].includes(task.status)).length },
    discovery: { terminals: 'list_sessions', liveOutputAndMenus: 'read_session', savedConversations: 'list_conversations', taskResults: 'list_work', files: 'search_files', fileContents: 'read_file', setups: 'list_setups' },
  };
}
module.exports = { WORKSPACE_VIEWS, workspaceMap };
