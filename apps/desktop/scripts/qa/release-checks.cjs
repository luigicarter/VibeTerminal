'use strict';
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const checks = [
  'test:model-providers', 'test:codex-web', 'smoke:open-codex', 'smoke:codex-web',
  'smoke:electron:git-branches', 'smoke:electron:fusion-menus', 'smoke:electron:session-resume',
  'smoke:backend:codex-discovery', 'smoke:backend:claude-discovery',
  'smoke:backend:agent-telemetry', 'smoke:backend:code-changes', 'smoke:backend:updates',
  'smoke:backend:fusion-launch', 'smoke:backend:fusion-adapter', 'smoke:backend:fusion-chat-parse',
  'smoke:backend:completion-gate', 'smoke:backend:openfusion-chat-parse',
  'smoke:backend:openfusion-background-status', 'smoke:backend:openfusion-custom-provider',
  'smoke:backend:openfusion-isolation', 'smoke:backend:fusion-appserver:embedded',
  'smoke:backend:terminal-runtime', 'smoke:backend:agent-generation', 'smoke:backend:metadata',
  'smoke:frontend:attention', 'smoke:frontend:workspace', 'smoke:frontend:session-launch',
  'test:frontend', 'smoke:electron:orchestrator-background-launch', 'smoke:electron:orchestrator-close', 'smoke:electron:orchestrator-navigation',
  'smoke:frontend:fusion-settings', 'smoke:frontend:tiled-resize', 'smoke:frontend:pane-split',
  'smoke:frontend:cwd-conflicts', 'smoke:frontend:terminal-runtime', 'smoke:frontend:app-runtime',
  'smoke:frontend:session-persistence', 'smoke:frontend:terminal-output',
  'smoke:electron:terminal-scroll', 'smoke:electron:terminal-board', 'smoke:electron:tiled-drag',
  'smoke:frontend:workspace-setups', 'smoke:frontend:orchestrator-history', 'smoke:frontend:conversation-live',
  'smoke:frontend:workspace-dock', 'smoke:frontend:conversation-pages', 'smoke:frontend:orchestrator-tasks',
  'smoke:frontend:voice-experience', 'test:voice:capture', 'smoke:voice:native', 'smoke:voice:matrix', 'smoke:voice:workflow', 'smoke:frontend:orchestrator-dashboard',
  'smoke:frontend:session-recency', 'smoke:frontend:orchestrator-work', 'test:orchestrator'
];
if (require.main === module) {
  for (const script of checks) {
    const windows = process.platform === 'win32';
    const result = spawnSync(windows ? (process.env.ComSpec || 'cmd.exe') : 'npm',
      windows ? ['/d', '/s', '/c', `npm run ${script}`] : ['run', script],
      { cwd: path.resolve(__dirname, '../..'), stdio: 'inherit', windowsHide: true });
    if (result.error) throw result.error;
    if (result.status !== 0) { console.error(`Release check failed: ${script}`); process.exit(result.status || 1); }
  }
  console.log(`All ${checks.length} release checks passed.`);
}
module.exports = { checks };
