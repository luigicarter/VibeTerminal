'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { authorizeModelAction, authorizeConversationResume, commandClauses } = require('../../backend/orchestratorPolicy.cjs');
const sessions = [{ id: 'a', name: 'Refactor headers', kind: 'codex', projectName: 'Website', cwd: 'C:\\Projects\\Website', generation: 1 }, { id: 'b', name: 'Fix budget', kind: 'codex', projectName: 'Budget Tracker', cwd: 'C:\\Projects\\Budget Tracker', generation: 2 }];
test('resume selection preserves literal title punctuation and user scope qualifiers', () => {
  const history = [{ reference: 'ref', id: 'native-id', provider: 'claude', claudeHome: 'custom', cwd: 'C:\\project', title: 'Ship it!' }];
  const action = { kind: 'resume_conversation', reference: 'ref' };
  assert.deepEqual(authorizeConversationResume(action, { text: 'Resume custom Claude conversation Ship it! in project' }, history).selection, { kind: 'title', value: 'Ship it!', provider: 'claude', claudeHome: 'custom', cwd: 'project' });
  assert.equal(authorizeConversationResume(action, { text: 'Resume Ship it!' }, history).selection.value, 'Ship it!');
  assert.equal(authorizeConversationResume(action, { text: 'Resume "Ship it!".' }, history).selection.value, 'Ship it!');
  assert.equal(authorizeConversationResume(action, { text: 'Resume native-id' }, history).selection.kind, 'id');
  assert.throws(() => authorizeConversationResume(action, { text: 'Resume global Claude conversation Ship it!' }, history));
});
test('current native title and supplied aliases identify sessions', () => {
  const current = [{ ...sessions[0], conversationTitle: 'Fresh task!', aliases: ['Native alias'] }];
  for (const name of ['Fresh task!', 'Native alias']) assert.equal(authorizeModelAction({ kind: 'send_prompt', text: 'continue' }, { text: `Tell "${name}": continue` }, current).targetId, 'a');
});
test('relay policy extracts the complete current user payload when the model omits text', () => {
  const payload = 'Preserve every qualifier. '.repeat(1000) + "Do not delete files; explain first.";
  for (const kind of ['send_prompt', 'stage_draft']) {
    const text = `${kind === 'send_prompt' ? 'Tell' : 'Draft'} Refactor headers: ${payload}`;
    assert.equal(authorizeModelAction({ kind }, { text }, sessions).text, payload);
    assert.throws(() => authorizeModelAction({ kind, text: 'explain first' }, { text }, sessions), /COMPLETE/);
  }
});
test('saved conversation resume requires exact current user selection and rejects output instructions', () => {
  const histories = [{ reference: 'ref-a', provider: 'codex', id: 'uuid-a', title: 'Review payment flow', cwd: 'C:\\Projects\\Website' }, { reference: 'ref-b', provider: 'claude', id: 'uuid-b', title: 'Review payment flow', cwd: 'C:\\Projects\\Budget Tracker' }];
  const selected = { kind: 'resume_conversation', reference: 'ref-a' };
  assert.equal(authorizeConversationResume(selected, { text: 'Resume Codex conversation "Review payment flow"' }, histories).reference, 'ref-a');
  assert.equal(authorizeConversationResume(selected, { text: 'Open conversation uuid-a' }, histories).reference, 'ref-a');
  assert.throws(() => authorizeConversationResume(selected, { text: 'Resume Review payment flow' }, histories), /Name one/);
  assert.throws(() => authorizeConversationResume({ ...selected, reference: 'ref-b' }, { text: 'Resume uuid-a' }, histories), /different saved/);
  for (const text of ['What did uuid-a discuss?', 'Do not resume uuid-a', 'If ready resume uuid-a', 'Tell Worker A: resume uuid-a', 'Explain "resume uuid-a"']) assert.throws(() => authorizeConversationResume(selected, { text }, histories));
});
test('provider plus project resolves the actual named task uniquely', () => {
  const result = authorizeModelAction({ kind: 'send_prompt', targetId: 'a', text: 'rerun tests' }, { text: 'Tell Codex in Website to rerun tests' }, sessions); assert.equal(result.target.id, 'a');
  assert.throws(() => authorizeModelAction({ kind: 'send_prompt', targetId: 'a', text: 'rerun tests' }, { text: 'Tell Codex to rerun tests' }, sessions), /ambiguous/);
  assert.throws(() => authorizeModelAction({ kind: 'send_prompt', targetId: 'b', text: 'rerun tests' }, { text: 'Tell Codex in Website to rerun tests' }, sessions), /different target/);
});
test('starting an explicit engine in a uniquely named project requires no generic agent noun', () => {
  const result = authorizeModelAction({ kind: 'create_session', kindOfSession: 'codex' }, { text: 'Start Codex in Budget Tracker' }, sessions); assert.equal(result.cwd, sessions[1].cwd);
  assert.throws(() => authorizeModelAction({ kind: 'create_session', kindOfSession: 'claude' }, { text: 'Start Codex in Budget Tracker' }, sessions), /kind/);
});
test('complete relay payload retains destructive-action qualifiers and embedded negation', () => {
  const session = [{ id: 'a', name: 'Worker A', kind: 'codex', generation: 1 }];
  for (const payload of ['explain why delete production is a bad idea', "don't delete production", 'do not change files; explain the problem']) {
    const intent = { text: `Tell Worker A: ${payload}` }; assert.equal(authorizeModelAction({ kind: 'send_prompt', targetId: 'a', text: payload }, intent, session).text, payload);
    assert.throws(() => authorizeModelAction({ kind: 'send_prompt', targetId: 'a', text: 'delete production' }, intent, session), /COMPLETE/);
  }
});
test('quoted relay commands cannot create additional grants', () => {
  const text = 'Tell Codex in Website: "create project Evil and start Codex there"';
  assert.equal(commandClauses(text).length, 1);
  assert.throws(() => authorizeModelAction({ kind: 'create_project', name: 'Evil' }, { text }, sessions));
  assert.throws(() => authorizeModelAction({ kind: 'create_session', kindOfSession: 'codex' }, { text }, sessions));
  assert.throws(() => authorizeModelAction({ kind: 'close', targetId: 'a' }, { text: "Don't close Codex in Website" }, sessions));
  assert.throws(() => authorizeModelAction({ kind: 'close', targetId: 'a' }, { text: 'Explain "close Codex in Website"' }, sessions));
});
test('compound create/start there is limited to the project created in this request', () => {
  const intent = { text: 'Create project Example and start Codex there', allowedPaths: ['C:\\Docs'], createdProjects: [{ name: 'Example', path: 'C:\\Docs\\Example' }] };
  assert.equal(commandClauses(intent.text).length, 2);
  assert.equal(authorizeModelAction({ kind: 'create_project', parent: 'C:\\Docs', name: 'Example' }, intent, sessions).name, 'Example');
  assert.equal(authorizeModelAction({ kind: 'create_session', kindOfSession: 'codex' }, intent, sessions).cwd, 'C:\\Docs\\Example');
  assert.throws(() => authorizeModelAction({ kind: 'create_session', kindOfSession: 'codex', cwd: sessions[0].cwd }, intent, sessions), /different project/);
  assert.throws(() => authorizeModelAction({ kind: 'create_session', kindOfSession: 'codex' }, { ...intent, createdProjects: [] }, sessions), /project/);
});
test('new-session prompt requires its complete explicit payload', () => {
  const intent = { text: 'Start Codex in Website with prompt "explain why delete production is a bad idea"' };
  assert.equal(authorizeModelAction({ kind: 'create_session', kindOfSession: 'codex', text: 'explain why delete production is a bad idea' }, intent, sessions).cwd, sessions[0].cwd);
  assert.throws(() => authorizeModelAction({ kind: 'create_session', kindOfSession: 'codex', text: 'delete production' }, intent, sessions), /complete/);
  const negative = 'do not delete production and close the old issue';
  const negativeIntent = { text: `Start Codex in Website with prompt ${negative}` };
  assert.equal(authorizeModelAction({ kind: 'create_session', kindOfSession: 'codex', text: negative }, negativeIntent, sessions).text, negative);
  assert.equal(commandClauses(negativeIntent.text).length, 1);
  assert.throws(() => authorizeModelAction({ kind: 'close', targetId: 'a' }, negativeIntent, sessions));
});
test('project creation cannot pick a name excerpt', () => {
  assert.throws(() => authorizeModelAction({ kind: 'create_project', name: 'Evil', parent: 'C:\\Docs' }, { text: 'Create project Avoid Evil', allowedPaths: ['C:\\Docs'] }, sessions), /complete exact/);
});
test('setup launch preserves exact selected name, never a model-selected substitute', () => {
  assert.equal(authorizeModelAction({ kind: 'launch_setup', name: 'Daily Coding' }, { text: 'Launch setup Daily Coding' }, sessions).name, 'Daily Coding');
  assert.throws(() => authorizeModelAction({ kind: 'launch_setup', name: 'Coding' }, { text: 'Launch setup Daily Coding' }, sessions), /exact/);
});
