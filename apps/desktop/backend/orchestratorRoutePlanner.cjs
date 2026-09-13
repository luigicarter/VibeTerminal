'use strict';

// What survives of routing after the deterministic resolver replaced its model
// rounds: the closed vocabulary of routing read operations, the validator the
// assignment reader still enforces on every read it performs, and the launcher
// choice for an explicitly requested new conversation. No model call, no
// discovery loop and no app-authored assistant turn remain here.
const fields = {
  find_agents: ['query', 'provider', 'cursor', 'limit', 'state', 'workItemId'], read_agent: ['agentId', 'sections', 'cursor', 'limit'], read_work_item: ['workItemId', 'cursor', 'maxChars'],
  list_sessions: ['query', 'offset', 'limit'], read_session: ['targetId'],
  list_work_items: ['query', 'offset', 'limit'], list_work: ['query', 'offset', 'limit'],
  list_conversations: ['query', 'provider', 'offset', 'limit'],
  read_conversation: ['reference', 'cursor'],
  choose: ['decision', 'targetId', 'agentId', 'kindOfSession', 'workItemId', 'reason', 'text'],
};
const properties = {
  agentId: { type: 'string', minLength: 1, maxLength: 500 }, state: { type: 'string', maxLength: 80 },
  sections: require('../shared/orchestratorAgentTools.cjs').PROPERTIES.sections,
  maxChars: { type: 'integer', minimum: 128, maximum: 4000 },
  kind: { type: 'string', enum: Object.keys(fields) },
  query: { type: 'string', maxLength: 500 }, offset: { type: 'integer', minimum: 0, maximum: 10000 },
  limit: { type: 'integer', minimum: 1, maximum: 40 },
  targetId: { type: 'string', minLength: 1, maxLength: 500 },
  workItemId: { type: 'string', minLength: 1, maxLength: 500 },
  kindOfSession: { type: 'string', minLength: 1, maxLength: 100 },
  provider: { type: 'string', maxLength: 100 },
  reference: { type: 'string', minLength: 1, maxLength: 4000 }, cursor: { type: 'string', maxLength: 4000 },
  decision: { type: 'string', enum: ['reuse', 'create', 'clarify'] },
  reason: { type: 'string', minLength: 1, maxLength: 1200 },
  text: { type: 'string', minLength: 1, maxLength: 1200 },
};
function validateRouteCall(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !fields[value.kind]) throw new Error('Unknown routing operation.');
  if (Object.keys(value).some(key => key !== 'kind' && !fields[value.kind].includes(key))) throw new Error('Unexpected routing argument.');
  for (const [key, item] of Object.entries(value)) {
    if (key === 'kind') continue;
    const rule = properties[key];
    if (rule.type === 'array') { if (!Array.isArray(item) || item.length < rule.minItems || item.length > rule.maxItems || item.some(v => !rule.items.enum.includes(v))) throw new Error(`Invalid routing ${key}.`); }
    else if (rule.type === 'integer') { if (!Number.isSafeInteger(item) || item < rule.minimum || item > rule.maximum) throw new Error(`Invalid routing ${key}.`); }
    else if (typeof item !== 'string' || item.length < (rule.minLength || 0) || item.length > rule.maxLength || rule.enum && !rule.enum.includes(item)) throw new Error(`Invalid routing ${key}.`);
  }
  if (value.kind === 'read_session' && !value.targetId || value.kind === 'read_conversation' && !value.reference ||
      value.kind === 'read_agent' && !value.agentId || value.kind === 'read_work_item' && !value.workItemId) throw new Error('Identify the routing evidence to read.');
  if (value.kind === 'choose') {
    if (!value.decision || !value.reason?.trim()) throw new Error('Choose a routing decision with its evidence-based reason.');
    if (value.decision === 'reuse' && (!value.targetId && !value.agentId || value.targetId && value.agentId || value.kindOfSession || value.text)) throw new Error('Reuse requires one live target or agent reference.');
    if (value.decision === 'create' && (!value.kindOfSession || value.targetId || value.agentId || value.text)) throw new Error('Creation requires one configured launcher.');
    if (value.decision === 'clarify' && (!value.text?.trim() || value.targetId || value.agentId || value.kindOfSession || value.workItemId)) throw new Error('Clarification requires one question.');
  }
  return value;
}

function deterministicNewTaskRoute({ scope, launchers = [], automaticProvider = false }) {
  if (scope?.assignmentMode !== 'new') return null;
  const eligible = launchers.filter(item => item.kind !== 'terminal' && item.available === true && item.configured === true);
  const order = ['codex', 'claude', 'fusion', 'openfusion', 'cursor', 'gemini', 'opencode', 'kimi', 'qwen', 'claude-custom', 'kimi-custom', 'grok'];
  const selected = scope.kindOfSession ? eligible.find(item => item.kind === scope.kindOfSession) : eligible.length === 1 ? eligible[0]
    : automaticProvider ? eligible.sort((a, b) => (a.defaultRank || order.indexOf(a.kind) + 1 || 100) - (b.defaultRank || order.indexOf(b.kind) + 1 || 100))[0] : null;
  if (selected) return { kind: 'choose', decision: 'create', kindOfSession: selected.kind, reason: 'The user requested a new conversation with this configured coding agent.' };
  const requested = launchers.find(item => item.kind === scope.kindOfSession);
  const blocker = typeof requested?.reason === 'string' && requested.reason.trim() ? requested.reason.trim().slice(0, 240)
    : requested?.configured === false ? 'it needs configuration' : requested?.available === false ? 'it is unavailable' : 'its availability or configuration is not confirmed';
  return { kind: 'choose', decision: 'clarify', reason: 'The new conversation needs an available configured launcher.',
    text: scope.kindOfSession ? `The requested ${scope.kindOfSession} launcher cannot start: ${blocker}. Which configured coding agent should I use?`
      : 'Which configured coding agent should I use for the new conversation?' };
}

class RoutingError extends Error {
  constructor(grantId) {
    super('Routing discovery reached its limit; no terminal was assigned.');
    this.name = 'RoutingError'; this.code = 'ROUTING_EXHAUSTED';
    this.grantId = grantId; this.assignmentState = 'not-assigned'; this.delivery = 'not-dispatched';
  }
}
module.exports = { validateRouteCall, deterministicNewTaskRoute, RoutingError };
