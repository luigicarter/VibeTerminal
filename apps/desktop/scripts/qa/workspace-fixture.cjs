'use strict';
// Test-only seeding through the same durable boundary the application uses.
// A localStorage rewrite alone is not authoritative after chat-store migration.
const checkpointFromStorage = `(async () => {
  if (!window.vibe?.chats) throw new Error('The chat workspace checkpoint API is unavailable.');
  const workspace = {
    workspaces: JSON.parse(localStorage.getItem('vibe-terminal:workspaces:v2') || '[]'),
    multiSessions: JSON.parse(localStorage.getItem('vibe-terminal:multi-sessions:v1') || '[]'),
    activeWorkspaceId: localStorage.getItem('vibe-terminal:active-workspace:v1'),
    activeView: localStorage.getItem('vibe-terminal:active-view:v1') === 'multi' ? 'multi' : 'project'
  };
  const result = await window.vibe.chats.checkpoint({ workspace, clientId: 'qa-seed-' + crypto.randomUUID(), sequence: 1 });
  if (!result.saved) throw new Error('Fixture workspace was not durably saved.');
  return result;
})()`;
function checkpoint(workspace) {
  return `window.vibe.chats.checkpoint({ workspace: ${JSON.stringify(workspace)}, clientId: 'qa-seed-' + crypto.randomUUID(), sequence: 1 })`;
}
module.exports = { checkpointFromStorage, checkpoint };
