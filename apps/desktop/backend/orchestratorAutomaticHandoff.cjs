'use strict';
const { randomUUID } = require('node:crypto');
const { projectIntent } = require('./orchestratorIntent.cjs');
const { routingBindingMatches } = require('./orchestratorLaunchers.cjs');

// A planner already supplied the complete task and assignment bound its owner.
// Let the application perform ordinary observe/send/observe through the existing
// executor. Native menus and proven-unsent refusals return to model judgment.
function createAutomaticHandoff() {
  const entries = new Map(), calls = new Map();
  return {
    propose({ plan, sessions, observations, modelRound, getOperation, pendingRequests = [] }) {
      if (!plan || plan.clarification) return;
      const progress = projectIntent(plan);
      for (const grant of plan.grants) {
        const state = progress.grants.find(g => g.id === grant.id);
        if (state?.dispatched) continue;
        // Never reorder another authorized operation or automate an arbitrary
        // interaction on a user-selected pane.
        if (grant.kind !== 'operate_terminal' || !grant.routing || grant.operationMode !== 'task' || grant.inspection || grant.lifecycleMode !== 'preserve') return;
        for (const target of grant.targets) {
          if (!state.availableTargetIds.includes(target.id)) continue;
          const key = JSON.stringify([grant.id, target.id, target.generation]);
          let entry = entries.get(key);
          const operation = getOperation(grant, target.id);
          if (!entry) {
            if (operation?.steps || operation?.uncertain) return;
            entry = { phase: 'read', grant, target }; entries.set(key, entry);
          }
          if (['fallback', 'finished'].includes(entry.phase)) return;
          const session = sessions.find(s => s.id === target.id && s.generation === target.generation);
          const binding = grant.routing.binding;
          if (!session || !routingBindingMatches({ target: binding, nativeIdentity: { workspace: grant.routing.cwd, id: binding?.conversationId } }, session)) { entry.phase = 'fallback'; return; }
          const pending = pendingRequests.some(r => r.sessionId === target.id && r.state === 'pending' && (r.generation === undefined || r.generation === target.generation));
          if (['read', 'post-read'].includes(entry.phase)) {
            const callId = `agent-handoff-${randomUUID()}`;
            calls.set(callId, { entry, phase: entry.phase });
            return { id: callId, function: { name: 'workspace', arguments: JSON.stringify({ kind: 'read_session', targetId: target.id }) } };
          }
          const token = observations?.latest(session, modelRound);
          if (!token) { entry.phase = 'fallback'; return; }
          const callId = `agent-handoff-${randomUUID()}`;
          let action;
          if (entry.phase === 'send') {
            if (pending || session.status === 'waiting' || session.pendingInteraction || session.composer?.dirty || session.composer?.reserved) { entry.phase = 'fallback'; return; }
            action = { kind: 'send_prompt', grantId: grant.id, targetId: target.id, stepId: callId, observationToken: token, text: grant.text };
          } else if (entry.phase === 'finish') {
            action = { kind: 'finish_terminal', grantId: grant.id, targetId: target.id, stepId: callId, observationToken: token,
              outcome: entry.sent?.ok === false ? 'blocked' : 'completed',
              text: entry.sent?.status === 'queued' ? 'The prompt is queued; task start and result are pending.' : entry.sent?.ok === false
                ? 'Prompt delivery is unconfirmed. It has not been replayed.' : 'The task prompt was submitted. Its attributed result remains pending.' };
          } else return;
          calls.set(callId, { entry, phase: entry.phase });
          return { id: callId, function: { name: 'workspace', arguments: JSON.stringify(action) } };
        }
      }
    },
    observe(call, result) {
      const current = calls.get(call?.id); if (!current) return;
      calls.delete(call.id); const { entry, phase } = current;
      if (phase === 'send') {
        entry.sent = result;
        // Never automatically retry any attempted write. Unknown outcomes keep
        // the normal receipt and operator uncertainty protections.
        entry.phase = result?.delivery === 'not-dispatched' || result?.validationFailure ? 'fallback' : 'post-read';
      } else if (!result?.ok) entry.phase = 'fallback';
      else entry.phase = phase === 'read' ? 'send' : phase === 'post-read' ? 'finish' : 'finished';
    }
  };
}
module.exports = { createAutomaticHandoff };
