'use strict';
const { interpretationTool } = require('./orchestratorInterpretationSchema.cjs');

const PLANNER_TOOL_PROTOCOL = 'Each plan_* call describes one operation and nothing happens during planning. interpret_workspace carries optional request metadata (goal, access, dependencies, clarification, or an observation-only request), never an actions array, and a clarification uses it alone. To open a worker AND run work, use plan_delegate_task once with assignmentMode new; do not also open a blank or draft terminal. Return every requested operation in one response.';

// Terminal work, conversation, inspection, watching and closing are offered to
// every request. The remaining operations answer a named user request, so they
// are offered only when the instruction mentions one, or when an unfinished
// pending command already holds that kind of grant and may still need it.
const MENTION_GATES = [
  { kinds: { plan_launch_setup: 'launch_setup', plan_save_setup: 'save_setup' }, mentions: /\bsetup\b/ },
  { kinds: { plan_remember_preference: 'remember_preference', plan_forget_preference: 'forget_preference' },
    mentions: /\b(remember|forget|prefer|preference|from now on|always|never)\b/ },
  { kinds: { plan_add_project: 'add_project', plan_remove_project: 'remove_project', plan_open_folder: 'open_folder', plan_create_project: 'create_project' },
    mentions: /\b(project|folder|directory|repo|side ?panel|workspace)\b/ },
  { kinds: { plan_navigate: 'navigate' },
    mentions: /\b(go to|take me|open (the )?(settings|history|dashboard|orchestrator|multi)|show (me )?(settings|history|dashboard|multi))\b/ },
  { kinds: { plan_resume_conversation: 'resume_conversation' }, mentions: /\b(resume|previous|earlier|saved|history|conversation)\b/ },
  { kinds: { plan_prepare_terminal_draft: 'create_session', plan_stage_draft: 'stage_draft' },
    mentions: /\b(draft|stage|without sending|don'?t send|type (it )?but)\b/ },
  { kinds: { plan_restart: 'restart' }, mentions: /\b(restart|relaunch|reboot)\b/ },
];
// The same gate, one level down. targetAvailability is not a routing preference
// but a user requirement: it instructs the application to refuse rather than
// write when the chosen pane is not free, and normalization drops every target
// that is busy at interpretation time. An offered enum field gets filled - the
// live planner sets one of its values on most operations - so a single unasked
// "idle" turns a pane the user named by name into "no selected terminal is
// currently free". Offer the field only to a sentence that states the
// requirement, or to a pending grant that already carries it.
const AVAILABILITY_MENTION = /\b(idle|free|not busy|isn[’']?t busy|unused|unoccupied|available|spare|empty|vacant|doing nothing|not working on)\b/;
function pendingGrants(context) {
  return [context.previousCommand, context.replyContext, ...(Array.isArray(context.pendingCommands) ? context.pendingCommands : [])]
    .flatMap(command => command?.grants || []).filter(Boolean);
}
function pendingGrantKinds(context) {
  const kinds = new Set();
  for (const grant of pendingGrants(context)) if (grant.kind) kinds.add(grant.kind);
  return kinds;
}
// Withheld action fields, by the same enforced boundary as the tool names: a
// field absent from every offered schema cannot be part of any plan.
function withheldPlannerFields(context) {
  const instruction = String(context.normalizedText ?? context.instruction ?? '').toLowerCase();
  if (AVAILABILITY_MENTION.test(instruction) || pendingGrants(context).some(grant => grant.targetAvailability)) return new Set();
  return new Set(['targetAvailability']);
}
// Withheld names are not merely undescribed: decodePlannerCalls rejects them, so
// the offered list is the enforced boundary.
function withheldPlannerTools(context) {
  // The normalized instruction is what the planner reads; fall back to the
  // spoken text while normalization is unavailable.
  const instruction = String(context.normalizedText ?? context.instruction ?? '').toLowerCase();
  const pending = pendingGrantKinds(context), withheld = new Set();
  for (const gate of MENTION_GATES) {
    if (gate.mentions.test(instruction)) continue;
    for (const [name, kind] of Object.entries(gate.kinds)) if (!pending.has(kind)) withheld.add(name);
  }
  return withheld;
}
// Length, item-count and uniqueness bounds, and every per-field description,
// are dropped from the offered schemas. They cost about a sixth of the whole
// interpretation call and enforce nothing: normalizeIntent revalidates every
// field against the same limits, and the system prompt already states each
// mode's meaning once. What stays is the part a model must read to be correct:
// the field set, its types and enums, the required list and additionalProperties.
const ADVISORY_KEYS = ['minLength', 'maxLength', 'minItems', 'maxItems', 'uniqueItems', 'minProperties', 'maxProperties', 'description'];
function slim(value) {
  if (Array.isArray(value)) return value.map(slim);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !ADVISORY_KEYS.includes(key)).map(([key, item]) => [key, slim(item)]));
}
const KIND_DESCRIPTIONS = {
  operate_terminal: 'Perform the task or interaction on user-selected existing terminals.',
  inspect_terminal: 'Read existing output or native usage/status; provider comes from terminalCapabilities.',
  add_project: 'Open an existing folder as a Lina project.',
  remove_project: 'Remove the project entry and stop its panes; deletes no files.',
  open_folder: 'Reveal an existing folder in the file manager.',
};
function plannerTools(context) {
  const legacy = interpretationTool(context), schema = legacy.function.parameters, actions = schema.properties.actions.items;
  const withheldFields = withheldPlannerFields(context);
  const { actions: omitted, ...metadata } = schema.properties;
  const tools = [{ type: 'function', function: { name: 'interpret_workspace', description: 'Optional request metadata, or an observation-only/clarification plan.',
    parameters: { type: 'object', additionalProperties: false, properties: slim(metadata) } } }];
  tools.push({ type: 'function', function: { name: 'plan_conversation', description: 'Answer an ordinary question about Lina, an error or the conversation. Use alone.',
    parameters: { type: 'object', additionalProperties: false, required: ['goal'], properties: { goal: { type: 'string' } } } } });
  for (const branch of actions.anyOf) {
    const kind = branch.properties.kind.enum[0];
    const offeredFields = Object.keys(branch.properties).filter(key => key !== 'kind' && !withheldFields.has(key));
    const properties = slim(Object.fromEntries(offeredFields.map(key => [key, { ...actions.properties[key], ...branch.properties[key] }])));
    const required = branch.required.filter(key => key !== 'kind' && !withheldFields.has(key));
    const add = (name, description, props = properties, req = required) => tools.push({ type: 'function', function: { name, description,
      parameters: { type: 'object', additionalProperties: false, properties: props, ...(req.length && { required: req }) } } });
    if (kind === 'create_session') {
      const { text, ...blank } = properties;
      add('plan_open_blank_terminal', 'Open an idle terminal with no task.', blank, required.filter(key => key !== 'text'));
      add('plan_prepare_terminal_draft', 'Open a terminal holding an explicitly requested UNSENT draft.', properties, [...new Set([...required, 'text'])]);
    } else if (kind === 'delegate_task') {
      const names = ['cwd', 'text', 'kindOfSession', 'workItemId', 'assignmentMode', 'promptMode', 'permissionMode', 'sourceUserId'];
      const props = Object.fromEntries(Object.entries(properties).filter(([name]) => names.includes(name)));
      add('plan_delegate_task', 'Delegate the complete objective; assignment chooses the worker.', props, required.filter(name => names.includes(name)));
      const { assignmentMode, ...continuation } = props;
      if (context.replyWorkItem?.id && (!context.targetId || context.replyWorkItem.binding?.target?.id === context.targetId)) {
        continuation.workItemId = { ...continuation.workItemId, enum: [context.replyWorkItem.id] };
      }
      add('plan_continue_task', 'Continue the same task in its existing agent, busy or not.', continuation, required.filter(name => name !== 'assignmentMode' && names.includes(name)));
    } else add(`plan_${kind}`, KIND_DESCRIPTIONS[kind] || `Plan the user-requested ${kind} operation.`);
  }
  const withheld = withheldPlannerTools(context);
  return tools.filter(tool => !withheld.has(tool.function.name));
}
function decodePlannerCalls(calls, tools, instruction) {
  if (!Array.isArray(calls) || !calls.length || calls.length > 25) throw new Error('The Brain did not return a valid command interpretation. No command was dispatched.');
  const allowed = new Set(tools.map(tool => tool.function.name)), actions = []; let metadata;
  for (const call of calls) {
    const name = call.function?.name;
    if (!allowed.has(name)) throw new Error(`The Brain selected an unavailable planning operation. This request offers only: ${[...allowed].join(', ')}. No command was dispatched.`);
    let args;
    try { args = JSON.parse(call.function.arguments); } catch { throw new Error('The Brain returned malformed command interpretation JSON. No command was dispatched.'); }
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Planning arguments must be an object.');
    if (name === 'plan_conversation') {
      if (calls.length !== 1 || Object.keys(args).some(key => key !== 'goal')) throw new Error('A conversation plan must stand alone with only its goal and no terminal effects.');
      return { goal: args.goal, actions: [], access: 'read-only', executionMode: 'reason' };
    }
    if (name === 'interpret_workspace') {
      // Preserve older adapter responses, always through the same complete-plan
      // normalization and ownership checks. Never merge two authority formats.
      if (Object.hasOwn(args, 'actions')) { if (calls.length !== 1) throw new Error('Do not mix a legacy plan with operation calls.'); return args; }
      if (metadata) throw new Error('Supply request metadata only once.'); metadata = args;
    } else {
      if (Object.hasOwn(args, 'kind')) throw new Error('The planning tool name determines its operation; omit kind from its arguments.');
      if (name === 'plan_continue_task' && args.workItemId === undefined) {
        const candidates = tools.find(tool => tool.function.name === name)?.function.parameters.properties.workItemId?.enum;
        if (candidates?.length === 1) args.workItemId = candidates[0];
      }
      const kind = ['plan_open_blank_terminal', 'plan_prepare_terminal_draft'].includes(name) ? 'create_session' : name === 'plan_continue_task' ? 'delegate_task' : name.slice('plan_'.length);
      if (name === 'plan_open_blank_terminal' && args.text !== undefined) throw new Error('A blank terminal cannot carry task text. Use plan_delegate_task for execution or plan_prepare_terminal_draft for an unsent draft.');
      if (name === 'plan_continue_task') {
        if (args.assignmentMode !== undefined) throw new Error('Continuation selects an existing owner; omit assignmentMode.');
        args.assignmentMode = 'existing';
      }
      actions.push({ kind, ...args });
    }
  }
  return { goal: instruction.slice(0, 4000), ...metadata, actions };
}
module.exports = { PLANNER_TOOL_PROTOCOL, plannerTools, decodePlannerCalls, withheldPlannerTools, withheldPlannerFields, MENTION_GATES, AVAILABILITY_MENTION };
