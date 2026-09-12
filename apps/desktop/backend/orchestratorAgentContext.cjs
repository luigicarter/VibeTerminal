'use strict';
const { LIMITS } = require('../shared/orchestratorAgentContract.cjs');
const { agentIndex } = require('./orchestratorAgentQueries.cjs');

// Relevant evidence only. Explicit authority stays in the original immutable
// grant envelope, even when a large target group needs paged record discovery.
function buildAgentContext({ records = [], targets = [], targetId, conversationTarget, workItemId, replyWorkItem } = {}) {
  const surfaceIds = new Set([targetId, conversationTarget?.id, ...targets.map(t => t.id), replyWorkItem?.binding?.target?.id].filter(Boolean));
  const workIds = new Set([workItemId, replyWorkItem?.id].filter(Boolean));
  const relevant = records.filter(r => surfaceIds.has(r.identity.surfaceId) || r.work.items.some(w => workIds.has(w.id)));
  const agents = [];
  for (const r of relevant) {
    if (agents.length >= LIMITS.bootstrapEntries) break;
    const next = agentIndex(r);
    if (Buffer.byteLength(JSON.stringify(agents.concat(next))) > LIMITS.bootstrapBytes - 500) break;
    agents.push(next);
  }
  return { agents,
    agentDirectory: { total: records.length, relevant: relevant.length, included: agents.length, truncated: agents.length < relevant.length,
      active: records.filter(r => ['running', 'busy', 'working', 'waiting'].includes(r.activity.status)).length,
      needsInput: records.filter(r => r.attention.required).length, discovery: 'find_agents', details: 'read_agent',
      notes: 'record_agent_note', taskDetails: 'read_work_item' } };
}
module.exports = { buildAgentContext };
