'use strict';
const { INTENT_TOOL } = require('./orchestratorIntent.cjs');
const { eligibleExistingTargets } = require('./orchestratorTargetReview.cjs');

// Deduplicate shared action definitions while retaining each operation's closed
// field set. New commands advertise their required payloads; continuations may
// inherit those payloads from application-owned pending authority.
function interpretationTool(context) {
  const tool = structuredClone(INTENT_TOOL), schema = tool.function.parameters;
  const pending = Boolean(context.pendingCommands?.length || context.previousCommand);
  const legacy = new Set(['send_prompt', 'terminal_interact', 'answer_question', 'permission']);
  const selected = eligibleExistingTargets(context).length > 0;
  const branches = schema.properties.actions.items.anyOf.filter(branch => {
    const kind = branch.properties.kind.enum[0];
    return pending || !legacy.has(kind) && (kind !== 'operate_terminal' || selected);
  });
  const properties = {}, required = {
    inspect_terminal: ['text'], operate_terminal: ['targetIds', 'text'], delegate_task: ['cwd', 'text'], stage_draft: ['targetIds', 'text'],
    navigate: ['view'], focus_session: ['targetIds'], interrupt: ['targetIds'], restart: ['targetIds'],
    watch_terminal: ['targetIds'], remember_preference: ['text'], forget_preference: ['preferenceId'],
    open_folder: ['path'], remove_project: ['path'], add_project: ['path'], save_setup: ['name'], launch_setup: ['name'], create_project: ['name'],
  };
  if (!pending) delete schema.properties.continuationOf;
  for (const branch of branches) {
    if (!pending) delete branch.properties.sourceUserId;
    for (const [field, definition] of Object.entries(branch.properties)) {
      if (field === 'kind') continue;
      // create_session has a narrower enum than delegated discovery.
      if (field === 'kindOfSession' && definition.enum) continue;
      properties[field] = definition;
    }
  }
  properties.kind = { type: 'string', enum: branches.map(branch => branch.properties.kind.enum[0]) };
  schema.properties.actions.items = { type: 'object', additionalProperties: false, required: ['kind'], properties,
    anyOf: branches.map(branch => {
      const kind = branch.properties.kind.enum[0];
      return { additionalProperties: false,
        required: [...new Set([...branch.required, ...(!pending ? required[kind] || [] : [])])],
        ...(branch.description && { description: branch.description }),
        properties: Object.fromEntries(Object.entries(branch.properties).map(([field, definition]) => [field,
          field === 'kind' ? { enum: [kind] } : field === 'kindOfSession' && definition.enum ? { enum: definition.enum } : {}])),
      };
    }),
  };
  return tool;
}
function canonicalizeInterpretation(raw) {
  if (!raw || !Array.isArray(raw.actions)) return raw;
  const scoped = raw.actions.filter(action => action && Object.hasOwn(action, 'access'));
  if (!scoped.length || scoped.some(action => !['read-only', 'mutation'].includes(action.access))) return raw;
  const values = new Set([raw.access, ...scoped.map(action => action.access)].filter(value => value !== undefined));
  if (values.size !== 1) throw new Error('Conflicting action and request access. Preserve all read-only constraints and separate incompatible work; do not discard an access restriction.');
  // This is a lossless relocation of one known scope field, never a whitelist
  // that discards unknown model arguments. A supplied top-level scope must agree.
  return { ...raw, access: [...values][0], actions: raw.actions.map(action => {
    if (!action || !Object.hasOwn(action, 'access')) return action;
    const { access, ...command } = action;
    return command;
  }) };
}
module.exports = { interpretationTool, canonicalizeInterpretation };
