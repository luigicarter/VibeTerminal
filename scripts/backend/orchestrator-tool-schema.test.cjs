'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildWorkspaceParameters, scopedWorkspaceTool } = require('../../backend/orchestratorToolSchema.cjs');
const { fitMessages } = require('../../backend/orchestratorBudget.cjs');
const { normalizeIntent, authorizeIntentAction } = require('../../backend/orchestratorIntent.cjs');

// Supply shared property definitions separately, just as the workspace tool does.
const names = 'kind grantId targetId stepId observationToken text observationSequence inputRevision editInput keys mouse inputPurpose submit requestId revision answerText answerTexts decision outcome view cwd query provider offset limit beforeSequence maxChars reference cursor root parent name kindOfSession path preferenceId responseTurn'.split(' ');
const kinds = 'navigate list_roots list_sessions read_session list_conversations read_conversation search_conversation resume_conversation search_files create_project focus_session stage_draft send_prompt interrupt restart close create_session add_project list_setups read_setup launch_setup save_setup list_preferences remember_preference forget_preference ask_user respond list_work answer_question permission terminal_interact finish_terminal'.split(' ');
const flat = { properties: Object.fromEntries(names.map(name => [name, { type: 'string', description: name }])) };
flat.properties.kind.enum = kinds;
flat.properties.keys = { type: 'array', maxItems: 16, items: { type: 'string' } };
const schema = buildWorkspaceParameters(flat);
const branch = kind => schema.anyOf.find(item => item.properties.kind.enum[0] === kind);

test('every advertised operation has one closed schema and preserves independent property constraints', () => {
  assert.deepEqual(schema.anyOf.map(item => item.properties.kind.enum[0]), kinds);
  for (const item of schema.anyOf) {
    assert.equal(item.additionalProperties, false);
    for (const name of item.required) assert.ok(Object.hasOwn(item.properties, name));
  }
  assert.deepEqual(branch('terminal_interact').properties.keys, flat.properties.keys);
  const copied = buildWorkspaceParameters(flat);
  copied.anyOf.find(item => item.properties.kind.enum[0] === 'terminal_interact').properties.keys.items.type = 'number';
  assert.equal(flat.properties.keys.items.type, 'string');
  assert.throws(() => buildWorkspaceParameters({ properties: { kind: { enum: ['future_action'] } } }), /Missing workspace schema/);
});

test('finish advertises the accepted operator payload and excludes native input evidence', () => {
  assert.deepEqual(Object.keys(branch('finish_terminal').properties), ['kind', 'grantId', 'targetId', 'stepId', 'observationToken', 'text', 'outcome']);
  assert.deepEqual(branch('finish_terminal').required, ['kind', 'stepId', 'observationToken', 'text', 'outcome']);
  const sessions = [{ id: 'a', generation: 'g', kind: 'codex' }];
  const plan = normalizeIntent({ goal: 'Review.', actions: [{ kind: 'operate_terminal', targetIds: ['a'], text: 'Review.' }] }, { requestId: 'user1', instruction: 'Review.', sessions });
  // doAction removes the opaque observationToken before intent authorization.
  const finish = { kind: 'finish_terminal', grantId: plan.grants[0].id, targetId: 'a', stepId: 'finish', text: 'Review started.', outcome: 'completed' };
  assert.equal(authorizeIntentAction(finish, plan, sessions).outcome, 'completed');
  for (const name of ['observationSequence', 'inputRevision', 'keys', 'submit']) {
    assert.equal(Object.hasOwn(branch('finish_terminal').properties, name), false);
    assert.throws(() => authorizeIntentAction({ ...finish, [name]: 1 }, plan, sessions), /unexpected.*fields/);
  }
});

test('native evidence is explicit without requiring operator arguments on legacy and chat actions', () => {
  for (const kind of ['send_prompt', 'interrupt', 'terminal_interact']) {
    assert.match(branch(kind).description, /observationSequence copied exactly from observation.sequence/);
    assert.match(branch(kind).description, /inputRevision copied exactly from observation.inputRevision/);
    assert.match(branch(kind).description, /unique stepId.*observationToken/);
    for (const name of ['stepId', 'observationToken', 'inputRevision']) assert.equal(branch(kind).required.includes(name), false);
  }
  assert.equal(branch('terminal_interact').required.includes('observationSequence'), true);
  assert.equal(branch('send_prompt').required.includes('text'), false);
  assert.equal(branch('send_prompt').properties.keys, undefined);
  assert.equal(branch('focus_session').properties.inputRevision, undefined);
});

test('read paging, saved-title clarification and response fields stay scoped to their actual handlers', () => {
  assert.deepEqual(Object.keys(branch('ask_user').properties), ['kind', 'text', 'reference', 'grantId']);
  assert.deepEqual(Object.keys(branch('respond').properties), ['kind', 'text', 'responseTurn']);
  assert.deepEqual(branch('respond').required, ['kind', 'text', 'responseTurn']);
  assert.deepEqual(Object.keys(branch('resume_conversation').properties), ['kind', 'grantId', 'provider', 'cwd', 'reference']);
  assert.deepEqual(Object.keys(branch('read_conversation').properties), ['kind', 'reference', 'cursor', 'maxChars', 'limit']);
  assert.deepEqual(Object.keys(branch('search_conversation').properties), ['kind', 'reference', 'query', 'cursor', 'limit']);
  assert.deepEqual(Object.keys(branch('list_work').properties), ['kind', 'cwd', 'query', 'offset', 'limit']);
  assert.deepEqual(Object.keys(branch('list_roots').properties), ['kind']);
});

const tool = { type: 'function', function: { name: 'workspace', description: 'Workspace controls.', parameters: schema } };
test('request scope always retains reads and conversation, and exposes only granted effects', () => {
  const none = scopedWorkspaceTool(tool);
  const kindsFor = result => result.function.parameters.properties.kind.enum;
  assert.ok(kindsFor(none).includes('read_session'));
  assert.ok(kindsFor(none).includes('read_conversation'));
  assert.ok(kindsFor(none).includes('list_work'));
  assert.ok(kindsFor(none).includes('respond'));
  assert.ok(kindsFor(none).includes('ask_user'));
  assert.equal(kindsFor(none).includes('close'), false);
  assert.deepEqual(kindsFor(scopedWorkspaceTool(tool, [{ kind: 'close' }])).filter(kind => !kindsFor(none).includes(kind)), ['close']);
  const operator = scopedWorkspaceTool(tool, [{ kind: 'operate_terminal' }]);
  assert.deepEqual(new Set(kindsFor(operator).filter(kind => !kindsFor(none).includes(kind))), new Set(['send_prompt', 'terminal_interact', 'answer_question', 'permission', 'interrupt', 'focus_session', 'finish_terminal']));
  assert.equal(kindsFor(operator).includes('restart'), false);
  assert.equal(schema.anyOf.length, kinds.length, 'Scoping must not mutate the global tool.');
});

test('compact scopes retain root constraints and exact per-kind field boundaries', () => {
  const compact = scopedWorkspaceTool(tool, [{ kind: 'operate_terminal' }]).function.parameters;
  assert.equal(compact.additionalProperties, false);
  assert.deepEqual(compact.required, ['kind']);
  assert.deepEqual(compact.properties.keys, flat.properties.keys);
  assert.match(compact.properties.inputRevision.description, /observation.inputRevision/);
  for (const item of compact.anyOf) {
    const original = branch(item.properties.kind.enum[0]);
    assert.equal(item.additionalProperties, false);
    assert.deepEqual(Object.keys(item.properties), Object.keys(original.properties));
    assert.deepEqual(['kind', ...(item.required || [])], original.required);
  }
  const finish = compact.anyOf.find(item => item.properties.kind.enum[0] === 'finish_terminal');
  assert.equal(Object.hasOwn(finish.properties, 'inputRevision'), false);
});

test('schema compaction fits a constrained request without changing immutable-input rejection', () => {
  const scoped = scopedWorkspaceTool(tool, [{ kind: 'close' }]);
  const messages = [{ role: 'system', content: 'Protected policy. '.repeat(100) }, { role: 'user', content: 'Close terminal a.' }];
  const compactBytes = Buffer.byteLength(JSON.stringify({ messages, tools: [scoped] }));
  assert.ok(compactBytes < Buffer.byteLength(JSON.stringify({ messages, tools: [tool] })));
  assert.deepEqual(fitMessages({ messages, tools: [scoped], maxBytes: compactBytes }), messages);
  assert.throws(() => fitMessages({ messages, tools: [tool], maxBytes: compactBytes }), /Local context limit/);
  assert.throws(() => fitMessages({ messages, tools: [scoped], contextLength: 2048 }), /Local context limit/);
  assert.equal(messages[1].content, 'Close terminal a.');
});
