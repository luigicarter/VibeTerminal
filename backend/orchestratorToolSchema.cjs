'use strict';

// Presentation only: authorization still belongs to the request's frozen grants
// and runtime validators. Do not advertise unrelated fields on every operation.
const target = ['grantId', 'targetId'];
const observed = [...target, 'stepId', 'observationToken'];
const native = ['observationSequence', 'inputRevision'];
const fields = {
  watch_terminal: [...target, 'watchUntil'],
  navigate: ['grantId', 'view', 'cwd'],
  list_roots: [], list_sessions: ['query', 'provider', 'cwd', 'offset', 'limit'],
  read_session: ['targetId', 'beforeSequence', 'maxChars'],
  list_conversations: ['provider', 'cwd', 'query', 'limit', 'offset'],
  read_conversation: ['reference', 'cursor', 'maxChars', 'limit'],
  search_conversation: ['reference', 'query', 'cursor', 'limit'],
  resume_conversation: ['grantId', 'provider', 'cwd', 'reference'],
  search_files: ['root', 'query', 'limit'], create_project: ['grantId', 'parent', 'name'],
  focus_session: observed, stage_draft: [...target, 'text'],
  send_prompt: [...observed, 'text', ...native, 'editInput'],
  interrupt: [...observed, ...native], restart: target, close: target,
  create_session: ['grantId', 'cwd', 'kindOfSession', 'text'], add_project: ['grantId', 'path'],
  list_setups: [], read_setup: ['name'], launch_setup: ['grantId', 'name'], save_setup: ['grantId', 'name'],
  list_preferences: [], remember_preference: ['grantId', 'text'], forget_preference: ['grantId', 'preferenceId'],
  ask_user: ['text', 'reference', 'grantId'], respond: ['text', 'speechText', 'responseTurn'],
  list_work: ['cwd', 'query', 'offset', 'limit'],
  answer_question: [...observed, 'requestId', 'revision', 'answerText', 'answerTexts'],
  permission: [...observed, 'requestId', 'revision', 'answerText', 'answerTexts', 'decision'],
  terminal_interact: [...observed, 'text', 'keys', 'mouse', 'inputPurpose', 'submit', ...native, 'editInput'],
  finish_terminal: [...observed, 'text', 'outcome'],
};
const required = {
  read_session: ['targetId'], read_setup: ['name'], ask_user: ['text'], respond: ['text', 'responseTurn'],
  read_conversation: ['reference'], search_conversation: ['reference'],
  terminal_interact: ['observationSequence'], finish_terminal: ['stepId', 'observationToken', 'text', 'outcome'],
};
const operator = 'For operate_terminal grants include a unique stepId and the latest read_session observationToken. ';
const nativeEvidence = 'Native operator input also requires observationSequence copied exactly from observation.sequence and inputRevision copied exactly from observation.inputRevision in that read. ';
const descriptions = {
  send_prompt: operator + nativeEvidence + 'Supply the task text for composed operator work; omit text for an already bound legacy prompt. Fusion/OpenFusion do not need native input revisions.',
  interrupt: operator + nativeEvidence,
  focus_session: operator,
  terminal_interact: operator + nativeEvidence + 'Submit with submit:true OR a final Enter key, never both. Use inputPurpose:task when starting agent work.',
  finish_terminal: 'After a post-action read, report the observed outcome with text and completed or blocked. Include stepId and observationToken only; no native input revisions or controls.',
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
const readKinds = ['list_roots', 'list_sessions', 'read_session', 'list_conversations', 'read_conversation', 'search_conversation', 'search_files', 'list_setups', 'read_setup', 'list_preferences', 'list_work'];
const operatorKinds = ['send_prompt', 'terminal_interact', 'answer_question', 'permission', 'interrupt', 'focus_session', 'finish_terminal'];
const inspectionKinds = ['terminal_interact', 'focus_session', 'finish_terminal'];
function scopedWorkspaceTool(tool, grants = []) {
  const allowed = new Set([...readKinds, 'respond', 'ask_user']);
  const operatorGrants = grants.filter(grant => grant.kind === 'operate_terminal');
  const inspectionOnly = operatorGrants.length > 0 && operatorGrants.every(grant => grant.inspection === true);
  // An unresolved delegated task permits routing reads only. Application code
  // binds it first; neither arbitrary creation nor terminal input is exposed.
  for (const grant of grants) for (const kind of grant.kind === 'delegate_task' ? [] : grant.kind === 'operate_terminal' ? grant.inspection === true ? inspectionKinds : operatorKinds : [grant.kind]) allowed.add(kind);
  const branches = tool.function.parameters.anyOf.filter(branch => allowed.has(branch.properties.kind.enum[0])).map(branch => {
    if (!inspectionOnly || branch.properties.kind.enum[0] !== 'terminal_interact') return branch;
    const scoped = structuredClone(branch);
    delete scoped.properties.editInput;
    scoped.properties.inputPurpose = { ...scoped.properties.inputPurpose, enum: ['interaction'] };
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
  if (properties.observationSequence) properties.observationSequence.description = 'Native operator input: copy exactly observation.sequence from the latest read_session.';
  if (properties.inputRevision) properties.inputRevision.description = 'Native operator input: copy exactly observation.inputRevision from the same read_session.';
  return { ...tool, function: { ...tool.function,
    description: tool.function.description + (grants.some(grant => grant.kind === 'operate_terminal') ? ' Operator actions require stepId and observationToken; native input also requires observationSequence and inputRevision. finish_terminal needs text and outcome, never native input fields.' : ''),
    parameters: { type: 'object', additionalProperties: false, required: ['kind'], properties,
      anyOf: branches.map(branch => ({ additionalProperties: false,
        ...(branch.required.length > 1 && { required: branch.required.filter(name => name !== 'kind') }),
        properties: Object.fromEntries(Object.keys(branch.properties).map(name => [name, name === 'kind' ? { enum: [...branch.properties.kind.enum] }
          : name === 'limit' && branch.properties.kind.enum[0] === 'list_work' ? { maximum: 10 }
          : name === 'limit' && branch.properties.kind.enum[0] === 'search_conversation' ? { maximum: 8 } : {}])) })) }
  } };
}
module.exports = { buildWorkspaceParameters, scopedWorkspaceTool };
