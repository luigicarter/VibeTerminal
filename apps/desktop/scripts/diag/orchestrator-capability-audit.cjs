'use strict';
// Read-only, offline capability evidence. Synthetic observations only; no PTY,
// provider, installed profile or model request is opened by this diagnostic.
const fs = require('node:fs'), path = require('node:path');
const { createTerminalRuntime } = require('../../backend/terminalRuntime.cjs');
const { plannerTools, withheldPlannerTools, MENTION_GATES } = require('../../backend/orchestratorPlannerTools.cjs');
const { workspaceMap } = require('../../backend/orchestratorWorkspace.cjs');
const { isInactiveCloseTarget } = require('../../backend/orchestratorCloseSafety.cjs');
const root = path.resolve(__dirname, '../..');
// Rarely used operations are offered only when the sentence asks for them, so a
// capability inventory has to ask for all of them at once: one keyword per
// mention gate, plus an existing-terminal group phrase and one pane so the
// operator action is in scope too. withheldPlannerTools re-checks the result, so
// a gate added later cannot silently shrink this list without saying so.
const AUDIT_INSTRUCTION = 'Show capabilities: setup, remember a preference, project folder, go to settings, resume saved history, stage a draft, restart, and use one of the open terminals.';
const auditContext = { instruction: AUDIT_INSTRUCTION, requestId: 'audit', roots: { projects: [] },
  sessions: [{ id: 'audit-pane', generation: 1, name: 'Audit pane', cwd: root, kind: 'codex', provider: 'codex' }] };
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
    plannerOperations: plannerTools(auditContext).map(tool => tool.function.name),
    plannerOperationsWithheld: [...withheldPlannerTools(auditContext)],
    plannerMentionGates: MENTION_GATES.map(gate => Object.keys(gate.kinds)),
    plannerOperationBoundary: 'Current catalogue with every mention gate opened. Legacy send_prompt/terminal_interact/answer_question/permission operations are offered only to an unfinished pending grant and are not listed.',
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
