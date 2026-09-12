'use strict';
const { interpretationTool } = require('./orchestratorInterpretationSchema.cjs');

const PLANNER_TOOL_PROTOCOL = 'Use the supplied planning tools. Each plan_* call describes one operation; no effect happens during planning. interpret_workspace supplies optional request metadata (goal, access, dependencies, clarification, or an observation-only request), not an actions array. Most action requests need only operation calls. To open a worker AND run work, use plan_delegate_task once with assignmentMode new; do not additionally open a blank or draft terminal. A clarification uses interpret_workspace alone. Return the complete set of requested operations in one response.';
function plannerTools(context) {
  const legacy = interpretationTool(context), schema = legacy.function.parameters, actions = schema.properties.actions.items;
  const { actions: omitted, ...metadata } = schema.properties;
  const tools = [{ type: 'function', function: { name: 'interpret_workspace', description: 'Optional request metadata or an observation-only/clarification plan. Use plan_* tools for operations.',
    parameters: { type: 'object', additionalProperties: false, properties: metadata } } }];
  tools.push({ type: 'function', function: { name: 'plan_conversation', description: 'Answer an ordinary question about Lina, its capabilities, an error, or conversation history. No terminal targets, actions, or continuation. Use alone.',
    parameters: { type: 'object', additionalProperties: false, required: ['goal'], properties: { goal: { type: 'string', minLength: 1, maxLength: 4000 } } } } });
  for (const branch of actions.anyOf) {
    const kind = branch.properties.kind.enum[0];
    const properties = Object.fromEntries(Object.keys(branch.properties).filter(key => key !== 'kind').map(key => [key, { ...actions.properties[key], ...branch.properties[key] }]));
    const required = branch.required.filter(key => key !== 'kind');
    const add = (name, description, props = properties, req = required) => tools.push({ type: 'function', function: { name, description,
      parameters: { type: 'object', additionalProperties: false, properties: props, ...(req.length && { required: req }) } } });
    if (kind === 'create_session') {
      const { text, ...blank } = properties;
      add('plan_open_blank_terminal', 'Open an idle terminal with no task. To run work in a new worker use plan_delegate_task.', blank, required.filter(key => key !== 'text'));
      add('plan_prepare_terminal_draft', 'Open a terminal with an explicitly requested UNSENT draft. This never executes work.', properties, [...new Set([...required, 'text'])]);
    } else if (kind === 'delegate_task') {
      const names = ['cwd', 'text', 'kindOfSession', 'workItemId', 'assignmentMode', 'promptMode', 'permissionMode', 'sourceUserId'];
      const props = Object.fromEntries(Object.entries(properties).filter(([name]) => names.includes(name)));
      add('plan_delegate_task', 'Delegate the complete objective in this project. Assignment chooses a suitable configured worker; independent work gets a fresh conversation.', props, required.filter(name => names.includes(name)));
      const { assignmentMode, ...continuation } = props;
      if (context.replyWorkItem?.id && (!context.targetId || context.replyWorkItem.binding?.target?.id === context.targetId)) {
        continuation.workItemId = { ...continuation.workItemId, enum: [context.replyWorkItem.id], description: 'The work item explicitly addressed by this reply.' };
      }
      add('plan_continue_task', 'Continue the same specific task in its EXISTING agent, including while busy. Use this when asked to tell the agent working on a named task to continue. Use the known workItemId when supplied; otherwise discover the owner. Never replace an unresolved owner with a new agent. Preserve the full follow-up and constraints.', continuation, required.filter(name => name !== 'assignmentMode' && names.includes(name)));
    } else add(`plan_${kind}`, branch.description || ({
      delegate_task: 'Assign the complete coding objective to an automatically chosen or new worker. Preserve all user constraints.',
      operate_terminal: 'Perform the complete task or interaction on user-selected existing terminals.',
      inspect_terminal: 'Read existing terminal output or inspect native usage/status without starting coding work. provider uses CLI IDs from terminalCapabilities.',
      add_project: 'Open an existing folder as a Lina project; no folder creation.',
      remove_project: 'Remove a project from Lina and stop its captured panes. Never delete files or folders.',
      open_folder: 'Reveal the requested existing folder in the system file manager.',
    }[kind] || `Plan the user-requested ${kind} operation.`));
  }
  return tools;
}
function decodePlannerCalls(calls, tools, instruction) {
  if (!Array.isArray(calls) || !calls.length || calls.length > 25) throw new Error('The Brain did not return a valid command interpretation. No command was dispatched.');
  const allowed = new Set(tools.map(tool => tool.function.name)), actions = []; let metadata;
  for (const call of calls) {
    const name = call.function?.name;
    if (!allowed.has(name)) throw new Error('The Brain selected an unavailable planning operation. No command was dispatched.');
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
module.exports = { PLANNER_TOOL_PROTOCOL, plannerTools, decodePlannerCalls };
