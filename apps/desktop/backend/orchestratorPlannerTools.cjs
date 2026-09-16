'use strict';
const { interpretationTool } = require('./orchestratorInterpretationSchema.cjs');
const { readReference, terminalsOf } = require('./orchestratorReference.cjs');

const PLANNER_TOOL_PROTOCOL = 'Each plan_* call describes one operation and nothing happens during planning. interpret_workspace carries optional request metadata (goal, access, dependencies, clarification, or an observation-only request), never an actions array, and a clarification uses it alone. To open a worker AND run work, use plan_delegate_task once; do not also open a blank or draft terminal. Return every requested operation in one response.';

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
// Which pane, how many, whether it must be free, and whether the work wants a
// fresh pane are facts the application reads off the sentence and the terminal
// model (orchestratorReference.cjs). None of them is offered to the model: an
// offered enum field gets filled, and a single unasked "idle" used to turn a
// pane the user named by name into "no selected terminal is currently free".
// The model names panes by their roster handles ("T3"); decodePlannerCalls
// turns them into ids and derives the rest.
const APP_OWNED_FIELDS = new Set(['targetIds', 'selection', 'targetAvailability', 'assignmentMode', 'statusTargetIds']);
const HANDLES = { type: 'array', items: { type: 'string' } };
function modelFacing(properties, required = []) {
  const offered = Object.fromEntries(Object.entries(properties).filter(([key]) => !APP_OWNED_FIELDS.has(key)).map(([key, definition]) => [key,
    key === 'scope' && Array.isArray(definition.anyOf) ? { ...definition, anyOf: definition.anyOf.map(branch => branch.properties?.targetIds
      ? { ...branch, required: ['type', 'handles'], properties: { type: branch.properties.type, handles: HANDLES } } : branch) } : definition]));
  if (properties.targetIds) offered.handles = HANDLES;
  if (properties.statusTargetIds) offered.statusHandles = HANDLES;
  return { properties: offered, required: required.filter(key => !APP_OWNED_FIELDS.has(key)).map(key => key === 'targetIds' ? 'handles' : key) };
}
function pendingGrants(context) {
  return [context.previousCommand, context.replyContext, ...(Array.isArray(context.pendingCommands) ? context.pendingCommands : [])]
    .flatMap(command => command?.grants || []).filter(Boolean);
}
function pendingGrantKinds(context) {
  const kinds = new Set();
  for (const grant of pendingGrants(context)) if (grant.kind) kinds.add(grant.kind);
  return kinds;
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
  operate_terminal: 'Perform the task or interaction on user-selected existing terminals; "stop", "interrupt" or "pause" that terminal is this with lifecycleMode interrupt, keeping the pane.',
  close: 'Close panes the user asked to close, quit, kill or remove. Not for "stop" or "interrupt": stopping current work keeps the pane (operate_terminal, lifecycleMode interrupt).',
  inspect_terminal: 'Read existing output or native usage/status; provider comes from terminalCapabilities.',
  add_project: 'Open an existing folder as a Lina project.',
  remove_project: 'Remove the project entry and stop its panes; deletes no files.',
  open_folder: 'Reveal an existing folder in the file manager.',
};
function plannerTools(context) {
  const legacy = interpretationTool(context), schema = legacy.function.parameters, actions = schema.properties.actions.items;
  const { actions: omitted, ...metadata } = schema.properties;
  const tools = [{ type: 'function', function: { name: 'interpret_workspace', description: 'Optional request metadata, or an observation-only/clarification plan.',
    parameters: { type: 'object', additionalProperties: false, properties: slim(modelFacing(metadata).properties) } } }];
  tools.push({ type: 'function', function: { name: 'plan_conversation', description: 'Answer an ordinary question about Lina, an error or the conversation. Use alone.',
    parameters: { type: 'object', additionalProperties: false, required: ['goal'], properties: { goal: { type: 'string' } } } } });
  for (const branch of actions.anyOf) {
    const kind = branch.properties.kind.enum[0];
    const fields = Object.keys(branch.properties).filter(key => key !== 'kind');
    const { properties, required } = modelFacing(slim(Object.fromEntries(fields.map(key => [key, { ...actions.properties[key], ...branch.properties[key] }]))),
      branch.required.filter(key => key !== 'kind'));
    const add = (name, description, props = properties, req = required) => tools.push({ type: 'function', function: { name, description,
      parameters: { type: 'object', additionalProperties: false, properties: props, ...(req.length && { required: req }) } } });
    if (kind === 'create_session') {
      const { text, ...blank } = properties;
      add('plan_open_blank_terminal', 'Open an idle terminal with no task.', blank, required.filter(key => key !== 'text'));
      add('plan_prepare_terminal_draft', 'Open a terminal holding an explicitly requested UNSENT draft.', properties, [...new Set([...required, 'text'])]);
    } else if (kind === 'delegate_task') {
      // workItemId is not offered. Which task record owns this work is a fact
      // the application already holds — the reply's work item, the pending
      // command, the resolver's own match — and a model asked for an opaque ID
      // invents one, which then fails ownership validation and kills the
      // request. The app fills it in decodePlannerCalls from its own authority.
      const names = ['cwd', 'text', 'kindOfSession', 'promptMode', 'permissionMode', 'sourceUserId'];
      const props = Object.fromEntries(Object.entries(properties).filter(([name]) => names.includes(name)));
      add('plan_delegate_task', 'Delegate the complete objective; assignment chooses the worker.', props, required.filter(name => names.includes(name)));
      add('plan_continue_task', 'Continue the same task in its existing agent, busy or not.', props, required.filter(name => names.includes(name)));
    } else add(`plan_${kind}`, KIND_DESCRIPTIONS[kind] || `Plan the user-requested ${kind} operation.`);
  }
  const withheld = withheldPlannerTools(context);
  return tools.filter(tool => !withheld.has(tool.function.name));
}
// The work item the application itself can name for this request: the reply's
// own work item, when the request is not addressed to a different pane. This is
// the only source of a workItemId on the continuation path; nothing a model
// returns is read.
function ownedWorkItemId(context = {}) {
  const item = context.replyWorkItem;
  if (!item?.id) return undefined;
  return !context.targetId || item.binding?.target?.id === context.targetId ? item.id : undefined;
}
// The panes a plan names, by the handles the roster showed ("T3"); an exact
// pane id is accepted too, because the memory block still carries ids. Anything
// else is a pane the model made up, and the plan is refused before any effect.
function handleResolver(context) {
  const byHandle = new Map();
  for (const terminal of terminalsOf(context)) {
    if (terminal.handle) byHandle.set(String(terminal.handle).toUpperCase(), terminal.id);
    byHandle.set(terminal.id, terminal.id);
  }
  return (list, { lenient = false } = {}) => {
    if (!Array.isArray(list)) throw new Error('Name each terminal by the handle of its roster row (T1, T2, …). No command was dispatched.');
    const ids = [];
    for (const item of list) {
      const id = byHandle.get(String(item ?? '').trim().toUpperCase()) ?? byHandle.get(String(item ?? ''));
      if (!id) { if (lenient) continue; throw new Error(`The plan named "${String(item).slice(0, 40)}", which is not a handle in the roster. Use the handle of a roster row (T1, T2, …). No command was dispatched.`); }
      if (!ids.includes(id)) ids.push(id);
    }
    return ids;
  };
}
const TARGETED_PLANS = new Set(['plan_operate_terminal', 'plan_send_prompt', 'plan_terminal_interact', 'plan_answer_question', 'plan_permission']);
function decodePlannerCalls(calls, tools, instruction, context = {}) {
  if (!Array.isArray(calls) || !calls.length || calls.length > 25) throw new Error('The Brain did not return a valid command interpretation. No command was dispatched.');
  const allowed = new Set(tools.map(tool => tool.function.name)), actions = []; let metadata;
  const owned = ownedWorkItemId(context);
  const resolveHandles = handleResolver(context);
  const reading = readReference(instruction, { launchers: context.launchers || [] });
  const pendingIds = new Set([context.previousCommand?.requestId, ...(Array.isArray(context.pendingCommands) ? context.pendingCommands : []).map(command => command?.requestId)].filter(Boolean));
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
      if (Object.hasOwn(args, 'actions')) {
        if (calls.length !== 1) throw new Error('Do not mix a legacy plan with operation calls.');
        // Same rule for the legacy shape: ownership is the application's, so a
        // supplied workItemId is dropped rather than validated and refused.
        return { ...args, ...(Array.isArray(args.actions) && { actions: args.actions.map(action => {
          if (!action || typeof action !== 'object') return action;
          // Panes named by handle are turned into ids here too.
          if (Object.hasOwn(action, 'handles')) { const { handles, ...rest } = action; action = { ...rest, targetIds: resolveHandles(handles) }; }
          if (!Object.hasOwn(action, 'workItemId')) return action;
          const { workItemId, ...rest } = action; // eslint-disable-line no-unused-vars
          return owned && rest.kind === 'delegate_task' && rest.assignmentMode === 'existing' ? { ...rest, workItemId: owned } : rest;
        }) }) };
      }
      if (metadata) throw new Error('Supply request metadata only once.'); metadata = args;
    } else {
      if (Object.hasOwn(args, 'kind')) throw new Error('The planning tool name determines its operation; omit kind from its arguments.');
      // A workItemId is never model-facing, so one that arrives anyway is a
      // guess. Drop it silently and let the application name the owner: the
      // continuation carries the reply's own work item, and everything else
      // reaches the deterministic resolver with no ownership claim at all.
      if (Object.hasOwn(args, 'workItemId')) delete args.workItemId;
      // A sourceUserId that names a request with nothing pending (a finished
      // reply, an earlier delivery) transfers no authority and used to end the
      // request twice over as "the unfinished request is unavailable". It says
      // nothing, so it is dropped and the sentence is read as the new request
      // it is; a source that names a pending command is validated as before.
      if (typeof args.sourceUserId === 'string' && args.sourceUserId !== context.requestId && !pendingIds.has(args.sourceUserId)) delete args.sourceUserId;
      // Which panes, how many, whether they must be free and whether the work
      // wants a fresh pane are the application's to say: the model names
      // handles, the sentence says the rest, and anything the model wrote into
      // those fields is dropped.
      for (const key of ['selection', 'targetAvailability', 'assignmentMode']) delete args[key];
      // A literal prompt is the user's own words. A model that labels its own
      // composition "literal" is wrong about the label, not about the work (on
      // the ladder that label alone killed three requests): the text stays, as
      // the composed prompt it is. The normalizer's refusal of a literal the
      // user never said still stands for every plan that reaches it as one.
      if (args.promptMode === 'literal' && typeof args.text === 'string' && !instruction.includes(args.text)) args.promptMode = 'compose';
      if (args.handles !== undefined || args.targetIds !== undefined) {
        args.targetIds = resolveHandles(args.handles ?? args.targetIds); delete args.handles;
        if (args.targetIds.length > 1) args.selection = 'all';
      }
      if (args.scope?.type === 'explicit' && (args.scope.handles !== undefined || args.scope.targetIds !== undefined)) {
        const { handles, targetIds, ...scope } = args.scope;
        args.scope = { ...scope, targetIds: resolveHandles(handles ?? targetIds) };
      }
      if (name === 'plan_delegate_task' && reading.kind === 'new') args.assignmentMode = 'new';
      if (TARGETED_PLANS.has(name) && reading.kind === 'idle') args.targetAvailability = 'idle';
      if (name === 'plan_inspect_terminal' && args.targetIds === undefined && (reading.fanOut || reading.all)) args.selection = 'all';
      if (name === 'plan_continue_task') args.assignmentMode = 'existing';
      if (owned && name === 'plan_continue_task') args.workItemId = owned;
      const kind = ['plan_open_blank_terminal', 'plan_prepare_terminal_draft'].includes(name) ? 'create_session' : name === 'plan_continue_task' ? 'delegate_task' : name.slice('plan_'.length);
      if (name === 'plan_open_blank_terminal' && args.text !== undefined) throw new Error('A blank terminal cannot carry task text. Use plan_delegate_task for execution or plan_prepare_terminal_draft for an unsent draft.');
      actions.push({ kind, ...args });
    }
  }
  if (metadata && (metadata.statusHandles !== undefined || metadata.statusTargetIds !== undefined)) {
    const { statusHandles, statusTargetIds, ...rest } = metadata;
    metadata = { ...rest, statusTargetIds: resolveHandles(statusHandles ?? statusTargetIds, { lenient: true }) };
  }
  // A blank goal is no goal: the request's own sentence stays the goal rather
  // than being overwritten with an empty string that fails validation.
  if (metadata && typeof metadata.goal === 'string' && !metadata.goal.trim()) delete metadata.goal;
  if (metadata && typeof metadata.continuationOf === 'string' && metadata.continuationOf !== context.requestId && !pendingIds.has(metadata.continuationOf)) delete metadata.continuationOf;
  return { goal: instruction.slice(0, 4000), ...metadata, actions };
}
module.exports = { PLANNER_TOOL_PROTOCOL, plannerTools, decodePlannerCalls, ownedWorkItemId, withheldPlannerTools, MENTION_GATES, APP_OWNED_FIELDS };
