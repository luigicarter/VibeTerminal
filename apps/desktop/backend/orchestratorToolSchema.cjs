'use strict';

// Presentation only: authorization still belongs to the request's frozen grants
// and runtime validators. Do not advertise unrelated fields on every operation.
const target = ['grantId', 'targetId'];
const observed = [...target, 'stepId', 'observationToken'];
// The application observes these operations itself when no eligible read exists,
// and generates their step identity, so neither field is model-facing.
const autoObserved = [...target];
const agentTools = require('../shared/orchestratorAgentTools.cjs');
const fields = {
  ...Object.fromEntries(Object.entries(agentTools.OPERATIONS).map(([kind, descriptor]) => [kind, descriptor.fields])),
  watch_terminal: [...target, 'watchUntil'],
  navigate: ['grantId', 'view', 'cwd'],
  read_file: ['path', 'cursor', 'maxChars', 'reference'], read_workspace: [], list_roots: [], list_sessions: ['query', 'provider', 'cwd', 'offset', 'limit'],
  read_session: ['targetId', 'beforeSequence', 'maxChars'],
  list_conversations: ['provider', 'cwd', 'query', 'limit', 'offset'],
  read_conversation: ['reference', 'cursor', 'maxChars', 'limit'],
  search_conversation: ['reference', 'query', 'cursor', 'limit'],
  resume_conversation: ['grantId', 'provider', 'cwd', 'reference'],
  open_folder: ['grantId', 'path'], remove_project: ['grantId', 'path'],
  search_files: ['root', 'query', 'limit'], create_project: ['grantId', 'parent', 'name'],
  focus_session: observed, stage_draft: [...target, 'text'],
  send_prompt: [...autoObserved, 'text', 'editInput'],
  interrupt: [...autoObserved], restart: target, close: target,
  create_session: ['grantId', 'cwd', 'kindOfSession', 'text'], add_project: ['grantId', 'path'],
  list_setups: [], read_setup: ['name'], launch_setup: ['grantId', 'name'], save_setup: ['grantId', 'name'],
  list_preferences: [], remember_preference: ['grantId', 'text'], forget_preference: ['grantId', 'preferenceId'],
  ask_user: ['text', 'reference', 'grantId'], respond: ['text', 'speechText', 'responseTurn'],
  list_work: ['cwd', 'query', 'offset', 'limit'],
  answer_question: [...autoObserved, 'requestId', 'revision', 'answerText', 'answerTexts'],
  permission: [...autoObserved, 'requestId', 'revision', 'answerText', 'answerTexts', 'decision'],
  terminal_interact: [...observed, 'text', 'keys', 'mouse', 'inputPurpose', 'submit', 'editInput'],
  finish_terminal: [...observed, 'text', 'outcome'],
};
const required = {
  ...Object.fromEntries(Object.entries(agentTools.OPERATIONS).map(([kind, descriptor]) => [kind, descriptor.required || []])),
  read_file: ['path'], read_session: ['targetId'], read_setup: ['name'], ask_user: ['text'], respond: ['text', 'responseTurn'],
  read_conversation: ['reference'], search_conversation: ['reference'],
  finish_terminal: ['text', 'outcome'],
};
const operator = 'For operate_terminal grants, send_prompt, answer_question, permission and interrupt are observed for you, while focus_session, terminal_interact and finish_terminal still need your own earlier read_session round and an omitted stepId to use this tool call identity; they bind to your latest unused read of that terminal by themselves, so omit observationToken. ';
// Freshness is the application's own business: it captures the input surface of
// the read that issued the token and fences the write on that. There is nothing
// for the model to copy back, and nothing it can get wrong.
const nativeEvidence = '';
const descriptions = {
  send_prompt: operator + nativeEvidence + 'Supply the task text for composed operator work; omit text for an already bound legacy prompt. Fusion/OpenFusion do not need native input revisions.',
  interrupt: operator + nativeEvidence,
  focus_session: operator,
  terminal_interact: operator + nativeEvidence + 'Submit with submit:true OR a final Enter key, never both. Use inputPurpose:task when starting agent work.',
  finish_terminal: operator + 'After a post-action read, report the observed outcome with text and completed or blocked. No native input revisions or controls.',
  answer_question: operator + 'Operator answers require the current pending interaction requestId and revision, plus answerText or answerTexts. Legacy answers are already bound.',
  permission: operator + 'Operator decisions require the current pending interaction requestId and revision. Follow the grant permissionMode; delegated decisions allow once or reject only.',
};
function buildWorkspaceParameters(flat) {
  return { type: 'object', anyOf: flat.properties.kind.enum.map(kind => {
    if (!Object.hasOwn(fields, kind)) throw new Error(`Missing workspace schema for ${kind}.`);
    return { type: 'object', additionalProperties: false, required: ['kind', ...(required[kind] || [])],
      ...(descriptions[kind] && { description: descriptions[kind] }),
      properties: Object.fromEntries(['kind', ...fields[kind]].map(field => {
        if (!flat.properties[field]) throw new Error(`Missing workspace property ${field}.`);
        return [field, field === 'kind' ? { type: 'string', enum: [kind] } : structuredClone(flat.properties[field])];
      })) };
  }) };
}
const readKinds = ['read_file', 'read_workspace', 'list_roots', 'list_sessions', 'read_session', 'list_conversations', 'read_conversation', 'search_conversation', 'search_files', 'list_setups', 'read_setup', 'list_preferences', 'list_work'];
const operatorKinds = ['send_prompt', 'terminal_interact', 'answer_question', 'permission', 'interrupt', 'focus_session', 'finish_terminal'];
const inspectionKinds = ['terminal_interact', 'focus_session', 'finish_terminal'];
function scopedWorkspaceTool(tool, grants = []) {
  const allowed = new Set([...readKinds, 'respond', 'ask_user', ...Object.keys(agentTools.OPERATIONS)]);
  const operatorGrants = grants.filter(grant => grant.kind === 'operate_terminal');
  const inspectionOnly = operatorGrants.length > 0 && operatorGrants.every(grant => grant.inspection === true);
  // An unresolved delegated task permits routing reads only. Application code
  // binds it first; neither arbitrary creation nor terminal input is exposed.
  for (const grant of grants) for (const kind of grant.kind === 'delegate_task' ? [] : grant.kind === 'operate_terminal' ? grant.inspection === true ? inspectionKinds : operatorKinds : [grant.kind]) allowed.add(kind);
  const branches = tool.function.parameters.anyOf.filter(branch => allowed.has(branch.properties.kind.enum[0])).map(branch => {
    if (branch.properties.kind.enum[0] === 'create_session' && grants.filter(grant => grant.kind === 'create_session').every(grant => grant.text === undefined)) {
      const blank = structuredClone(branch); delete blank.properties.text; return blank;
    }
    if (branch.properties.kind.enum[0] !== 'terminal_interact' || !operatorGrants.length) return branch;
    const scoped = structuredClone(branch);
    if (inspectionOnly) {
      delete scoped.properties.editInput;
      scoped.properties.inputPurpose = { ...scoped.properties.inputPurpose, enum: ['interaction'] };
    }
    return scoped;
  });
  // Shared definitions live once at the root. Each branch still closes its own
  // field whitelist, so an input revision cannot sneak into finish_terminal.
  // Avoid $refs and preserve the ordinary object/anyOf provider contract.
  const properties = {};
  for (const branch of branches) for (const [name, definition] of Object.entries(branch.properties)) {
    if (name !== 'kind') {
      properties[name] = structuredClone(definition);
      // Operation instructions are already in the request system prompt; retain
      // schema constraints here without paying for repeated prose definitions.
      delete properties[name].description;
    }
  }
  properties.kind = { type: 'string', enum: branches.map(branch => branch.properties.kind.enum[0]) };
  // These are model-facing limits; direct UI reads may request larger excerpts.
  if (properties.maxChars) properties.maxChars.maximum = 4000;
  return { ...tool, function: { ...tool.function,
    description: tool.function.description + (operatorGrants.length ? ' ' + operator + nativeEvidence + 'finish_terminal needs text and outcome, never native input fields.' : ''),
    parameters: { type: 'object', additionalProperties: false, required: ['kind'], properties,
      anyOf: branches.map(branch => ({ additionalProperties: false,
        ...(branch.required.length > 1 && { required: branch.required.filter(name => name !== 'kind') }),
        properties: Object.fromEntries(Object.keys(branch.properties).map(name => [name, name === 'kind' ? { enum: [...branch.properties.kind.enum] }
          : name === 'limit' && branch.properties.kind.enum[0] === 'list_work' ? { maximum: 10 }
          : name === 'limit' && branch.properties.kind.enum[0] === 'search_conversation' ? { maximum: 8 } : {}])) })) }
  } };
}
// Retrieval over Lina's own memory store. These are reads with no target, no
// grant and no effect, so they are offered on every request rather than scoped
// by the plan: they only ever return bounded citations of what the application
// already recorded about its own actions.
const MEMORY_TOOLS = Object.freeze([
  { name: 'recall', required: [], properties: { query: { type: 'string' }, targetId: { type: 'string' },
    cwd: { type: 'string' }, since: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 10 } } },
  { name: 'recall_pane', required: ['targetId'], properties: { targetId: { type: 'string' } } },
  { name: 'recall_project', required: ['name'], properties: { name: { type: 'string' } } },
]);
const MEMORY_KINDS = MEMORY_TOOLS.map(tool => tool.name);
function memoryTools() {
  return MEMORY_TOOLS.map(tool => ({ type: 'function', function: { name: tool.name,
    description: require('./orchestratorToolGuide.cjs').workspaceOperationGuide(tool.name) || `Read Lina's memory with ${tool.name}.`,
    parameters: { type: 'object', additionalProperties: false, required: [...tool.required], properties: structuredClone(tool.properties) } } }));
}
function namedWorkspaceTools(tool) {
  const root = tool.function.parameters;
  return [...root.anyOf.map(branch => {
    const kind = branch.properties.kind.enum[0];
    return { type: 'function', function: { name: kind,
      description: require('./orchestratorToolGuide.cjs').workspaceOperationGuide(kind) || `Perform the scoped ${kind} operation.`,
      parameters: { type: 'object', additionalProperties: false,
        required: (branch.required || []).filter(name => name !== 'kind'),
        properties: Object.fromEntries(Object.keys(branch.properties).filter(name => name !== 'kind').map(name => [name,
          { ...structuredClone(root.properties[name]), ...structuredClone(branch.properties[name]) }])) } } };
  }), ...memoryTools()];
}
module.exports = { buildWorkspaceParameters, scopedWorkspaceTool, namedWorkspaceTools, memoryTools, MEMORY_KINDS };
