'use strict';
function agent(id = 'worker', overrides = {}) {
  return { id, name: `Agent ${id}`, kind: 'codex', provider: 'codex', cwd: 'C:/agent-harness/project',
    generation: `run-${id}`, launchToken: 1, conversation: { provider: 'codex', id: `conversation-${id}` },
    started: true, processState: 'running', agentProcessState: 'running', agentPid: 101, status: 'idle',
    turnState: 'idle', observation: 'observed', telemetryHealth: 'available', binding: { status: 'found' },
    children: [], activeTools: [], childActivity: false, ...overrides };
}
function childApproval() {
  return agent('approval', { status: 'waiting', turnState: 'completed', turnId: 'root-turn', childActivity: true,
    children: [{ id: 'reviewer', label: 'Review authentication changes', observation: 'observed',
      attention: { id: 'permission-1', state: 'waiting', reason: 'approval', toolId: 'attempt-1', updatedAt: 10 } }] });
}
module.exports = { agent, childApproval };
