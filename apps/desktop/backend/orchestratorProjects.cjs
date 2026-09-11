'use strict';
const path = require('node:path');
function projectPath(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('An existing project folder is required.');
  const flavor = /^[a-z]:[\\/]|^\\\\/i.test(value) ? path.win32 : path.posix;
  if (!flavor.isAbsolute(value)) throw new Error('An absolute project folder is required.');
  const normalized = flavor.normalize(value).replace(/[\\/]+$/, '');
  return flavor === path.win32 ? normalized.toLowerCase() : normalized;
}
function captureProjectRemoval(folder, projects = [], sessions = []) {
  const matches = projects.filter(project => project?.id && projectPath(project.path) === projectPath(folder));
  if (matches.length !== 1) throw new Error('Identify one project currently open in Lina Terminal. Removing a project never deletes its folder.');
  const project = matches[0];
  return { id: project.id, path: project.path, name: project.name,
    targets: sessions.filter(session => session.projectId === project.id && session.visiblePane !== false).map(session => ({
      id: session.id, launchToken: session.launchToken, generation: session.generation, kind: session.kind || session.provider,
    })) };
}
function validateProjectRemoval(selection, projects, sessions) {
  if (!selection || !Array.isArray(selection.targets)) throw new Error('Project removal requires its original workspace snapshot.');
  const current = projects.find(project => project.id === selection.id);
  if (!current || projectPath(current.path) !== projectPath(selection.path)) throw new Error('The selected project changed before removal.');
  const panes = sessions.filter(session => session.projectId === current.id && session.visiblePane !== false);
  if (panes.some(pane => !selection.targets.some(target => target.id === pane.id && target.launchToken === pane.launchToken && target.generation === pane.generation))) {
    throw new Error('The project gained or restarted a terminal after removal was requested. Review its current terminals before removing it.');
  }
  return current;
}
async function prepareProjectPrerequisites({ plan, execute, onOutcome }) {
  const { projectIntent } = require('./orchestratorIntent.cjs');
  const taskFolders = new Set(plan.grants.filter(grant => grant.kind === 'delegate_task').map(grant => projectPath(grant.args.cwd)));
  const firstTask = plan.grants.findIndex(grant => grant.kind === 'delegate_task');
  const prefix = new Set();
  for (const grant of plan.grants.slice(0, Math.max(0, firstTask))) {
    if (!['open_folder', 'add_project', 'remove_project', 'navigate', 'close'].includes(grant.kind)) break;
    prefix.add(grant.id);
  }
  let prepared = 0;
  for (const grant of plan.grants) {
    if ((!prefix.has(grant.id) && (grant.kind !== 'add_project' || !taskFolders.has(projectPath(grant.args.path)))) || projectIntent(plan).grants.find(item => item.id === grant.id)?.dispatched) continue;
    const progress = projectIntent(plan).grants.find(item => item.id === grant.id);
    for (const target of grant.targets.length ? grant.targets.filter(target => progress.availableTargetIds.includes(target.id)) : [null]) {
      const action = { kind: grant.kind, grantId: grant.id, ...(target && { targetId: target.id }) };
      const result = await execute(action);
      onOutcome({ ...action, ...result });
      if (!result?.ok) throw new Error(result?.error || 'Workspace preparation did not complete. Its dependent task was not started.');
    }
    prepared++;
  }
  return prepared;
}
module.exports = { projectPath, captureProjectRemoval, validateProjectRemoval, prepareProjectPrerequisites };
