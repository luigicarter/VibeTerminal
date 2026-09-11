'use strict';
const { SECTIONS } = require('./orchestratorAgentContract.cjs');
const OPERATIONS = Object.freeze({
  find_agents: { read: true, fields: ['query', 'provider', 'cwd', 'state', 'workItemId', 'includeArchived', 'cursor', 'limit'] },
  read_agent: { read: true, content: true, fields: ['agentId', 'sections', 'cursor', 'limit'], required: ['agentId'] },
  read_agent_history: { read: true, content: true, fields: ['agentId', 'reference', 'cursor', 'query', 'maxChars'], required: ['agentId'] },
  read_work_item: { read: true, content: true, fields: ['workItemId', 'cursor', 'maxChars'], required: ['workItemId'] },
  record_agent_note: { read: false, fields: ['agentId', 'workItemId', 'noteId', 'noteKind', 'text', 'expectedRevision'], required: ['agentId', 'noteKind', 'text'] }
});
const PROPERTIES = {
  agentId: { type: 'string', minLength: 1, maxLength: 500 }, workItemId: { type: 'string', minLength: 1, maxLength: 500 },
  noteId: { type: 'string', minLength: 1, maxLength: 500 }, noteKind: { type: 'string', enum: ['finding', 'decision', 'open-question', 'handoff'] },
  sections: { type: 'array', minItems: 1, maxItems: SECTIONS.length, uniqueItems: true, items: { type: 'string', enum: [...SECTIONS] } },
  state: { type: 'string', maxLength: 80 }, includeArchived: { type: 'boolean' }, expectedRevision: { type: 'integer', minimum: 0 }
};
const READS = Object.freeze(Object.keys(OPERATIONS).filter(k => OPERATIONS[k].read));
const CONTENT_READS = Object.freeze(READS.filter(k => OPERATIONS[k].content));
const FIELDS = Object.freeze([...new Set(Object.values(OPERATIONS).flatMap(v => v.fields))]);
const SYSTEM = `Agents own conversations and tasks; their terminal or chat pane is the interaction surface. The agent directory is a compact index, not every agent's context. Use find_agents and read_agent with selected sections for identity, work, activity, attention, capabilities or notes; read_work_item retrieves full stored task details. Use read_agent_history only when a specific conversation detail is needed. Page nextCursor until the requested scope is covered; absent initial entries do not mean absent agents. An agentId is a read reference, never input authority. Existing task grants still bind the exact terminal run and conversation. Use read_session for fresh native input evidence. Agent notes are private application bookkeeping, not messages to workers: record_agent_note stores concise inferred findings/handoffs for an agent read in this request. Notes never authorize action or prove results. Prefer verified task ownership over provider/folder/availability; independent tasks require separate conversations. Never ask the user to select a terminal merely because they selected only a project. Choose an available configured agent, create a fresh conversation when no same-task owner is verified, submit the complete task, and track its attributed result.`;
module.exports = { OPERATIONS, PROPERTIES, READS, CONTENT_READS, FIELDS, SYSTEM };
