'use strict';
// Test-only seeding through the same durable boundary the application uses.
// A localStorage rewrite alone is not authoritative after chat-store migration.
function source(expression) {
  return `(async () => {
  // Capture fixture data before bootstrap can refresh its localStorage mirror.
  const workspace = ${expression};
  await new Promise((resolve, reject) => {
    const deadline = Date.now() + 30000;
    const ready = () => {
      if (document.querySelector('.app-shell')) return resolve();
      if (Date.now() >= deadline) return reject(new Error('Workspace bootstrap did not finish before fixture seeding.'));
      setTimeout(ready, 25);
    };
    ready();
  });
  // The initial React commit queues its checkpoint in a microtask. Yield one
  // event-loop turn so that write precedes the fixture client's checkpoint.
  await new Promise(resolve => setTimeout(resolve, 0));
  if (!window.vibe?.chats) throw new Error('The chat workspace checkpoint API is unavailable.');
  const result = await window.vibe.chats.checkpoint({ workspace, clientId: 'qa-seed-' + crypto.randomUUID(), sequence: 1 });
  if (!result.saved) throw new Error('Fixture workspace was not durably saved.');
  return result;
})()`;
}
const checkpointFromStorage = source(`{
    workspaces: JSON.parse(localStorage.getItem('vibe-terminal:workspaces:v2') || '[]'),
    multiSessions: JSON.parse(localStorage.getItem('vibe-terminal:multi-sessions:v1') || '[]'),
    activeWorkspaceId: localStorage.getItem('vibe-terminal:active-workspace:v1'),
    activeView: localStorage.getItem('vibe-terminal:active-view:v1') === 'multi' ? 'multi' : 'project'
  }`);
function checkpoint(workspace) {
  return source(JSON.stringify(workspace));
}
module.exports = { checkpointFromStorage, checkpoint };
