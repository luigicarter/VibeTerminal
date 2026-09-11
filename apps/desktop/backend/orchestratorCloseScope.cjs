'use strict';

const MAX_CLOSE_TARGETS = 500;
function scopeMembers(scope, sessions) {
  return sessions.filter(session => session.visiblePane === true && (
    scope.type === 'workspace' || scope.type === 'board' && session.board === 'multi' ||
    scope.type === 'project' && session.projectId === scope.projectId ||
    scope.type === 'explicit' && scope.targetIds.includes(session.id)));
}
function resolveCloseScope(command, context) {
  const scope = command.scope;
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) throw new Error('Close requires an explicit scope selector.');
  const fields = scope.type === 'project' ? ['type', 'projectId'] : scope.type === 'explicit' ? ['type', 'targetIds'] : ['type'];
  if (!['project', 'board', 'workspace', 'explicit'].includes(scope.type) || Object.keys(scope).some(key => !fields.includes(key))) throw new Error('Invalid close scope.');
  const sessions = context.sessions || [];
  if (scope.type === 'project') {
    const projects = [...(context.projects || []), ...(context.roots?.projects || [])];
    if (typeof scope.projectId !== 'string' || !scope.projectId || !projects.some(project => project?.id === scope.projectId) && !sessions.some(session => session.visiblePane === true && session.projectId === scope.projectId)) throw new Error('Close scope requires one known project ID.');
  }
  if (scope.type === 'explicit' && (!Array.isArray(scope.targetIds) || !scope.targetIds.length || scope.targetIds.length > MAX_CLOSE_TARGETS || scope.targetIds.some(id => typeof id !== 'string' || !id) || new Set(scope.targetIds).size !== scope.targetIds.length)) throw new Error('Explicit close scope requires distinct pane IDs.');
  const members = scopeMembers(scope, sessions);
  if (members.length > MAX_CLOSE_TARGETS) throw new Error('Close scope exceeds the supported 500-pane bound; narrow the scope.');
  if (new Set(members.map(session => session.id)).size !== members.length) throw new Error('Close scope contains ambiguous pane identities.');
  if (scope.type === 'explicit' && members.length !== scope.targetIds.length) throw new Error('An explicitly selected pane is unavailable.');
  if (members.some(session => !Number.isSafeInteger(session.launchToken) || session.launchToken < 0 || session.generation === undefined)) throw new Error('Close scope has unverified pane launch identities. Refresh the inventory.');
  const ids = members.map(session => session.id);
  if (command.targetIds !== undefined && (!Array.isArray(command.targetIds) || command.targetIds.length !== ids.length || new Set(command.targetIds).size !== ids.length || command.targetIds.some(id => !ids.includes(id)))) throw new Error('Close target IDs must cover the complete selected scope.');
  if (command.selection !== undefined && command.selection !== 'all') throw new Error('Close scope already identifies the complete set; omit selection. To close one pane use an explicit scope with one ID.');
  return { scope: structuredClone(scope), inventoryRevision: Math.max(0, ...sessions.map(session => session.inventoryRevision || 0)),
    targetCount: members.length, targets: members.map(({ id, launchToken, generation, kind }) => ({ id, launchToken, generation, kind })) };
}
function sameClosePane(target, session) {
  return target.id === session.id && target.launchToken === session.launchToken && (target.generation === session.generation ||
    target.generation === `paused:${target.id}:${target.launchToken}` || session.generation === `paused:${session.id}:${session.launchToken}`);
}
function remainingCloseScope(closeScope, sessions) {
  const remaining = scopeMembers(closeScope.scope, sessions);
  const newTargetCount = remaining.filter(session => !closeScope.targets.some(target => sameClosePane(target, session))).length;
  return { remainingTargetCount: remaining.length - newTargetCount, newTargetCount };
}
module.exports = { resolveCloseScope, scopeMembers, remainingCloseScope, sameClosePane };
