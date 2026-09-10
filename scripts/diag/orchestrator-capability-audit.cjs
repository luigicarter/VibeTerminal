'use strict';
// Read-only, offline capability evidence. Synthetic observations only; no PTY,
// provider, installed profile or model request is opened by this diagnostic.
const fs = require('node:fs'), path = require('node:path');
const { createTerminalRuntime } = require('../../backend/terminalRuntime.cjs');
const { plannerTools } = require('../../backend/orchestratorPlannerTools.cjs');
const { workspaceMap } = require('../../backend/orchestratorWorkspace.cjs');
const { isInactiveCloseTarget } = require('../../backend/orchestratorCloseSafety.cjs');
const root = path.resolve(__dirname, '../..');
const runtime = createTerminalRuntime();
const { generation } = runtime.beginLaunch({ id: 'audit', provider: 'claude', cwd: root, launchToken: 1 });
const emit = (type, extra = {}) => runtime.ingest({ id: 'audit', generation, providerThreadId: 'root', rootVerified: true, type, ...extra });
const attention = () => runtime.getSnapshot('audit').children.find(child => child.id === 'worker')?.attention;
try {
  emit('created');
  const child = { transcriptKind: 'subagent', taskId: 'worker' };
  emit('agent-attention', { ...child, toolName: 'Bash', attention: { state: 'waiting', reason: 'approval' } });
  const before = Boolean(attention());
  emit('agent-running', { ...child, toolName: 'Read', toolId: 'unrelated-read', phase: 'stop', turnStart: false });
  const report = {
    at: new Date().toISOString(),
    childApproval: { beforeUnrelatedReturn: before, afterUnrelatedReturn: Boolean(attention()),
      boundary: 'Production runtime with a native-shaped approval missing toolId; not a live provider permission request.' },
    plannerOperations: plannerTools({ instruction: 'Show capabilities.', requestId: 'audit', sessions: [], roots: { projects: [] } }).map(tool => tool.function.name),
    capabilities: workspaceMap().capabilities,
    inactiveStructuredChatEligible: isInactiveCloseTarget({ id: 'chat', generation: 'g', launchToken: 1, kind: 'fusion',
      engineReady: true, status: 'idle', turnState: 'idle', observation: 'observed' }),
    boundary: 'Diagnostics report current limitations; false evidence fields are not passing acceptance assertions.'
  };
  const directory = path.join(root, '.tmp', 'orchestrator-capability-audit', `${Date.now()}-${process.pid}`);
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'report.json');
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ file, childApproval: report.childApproval, inactiveStructuredChatEligible: report.inactiveStructuredChatEligible }));
} finally { runtime.dispose(); }
