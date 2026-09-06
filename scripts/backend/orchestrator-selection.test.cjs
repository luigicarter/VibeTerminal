'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { authorizeModelAction, commandClauses, captureRelay, clarifyRelay, selectRelay, identifySessionGroup } = require('../../backend/orchestratorPolicy.cjs');

const projects = [{ name: 'vibeTerminal', path: 'C:\\work\\vibeTerminal' }, { name: 'Other', path: 'C:\\work\\other' }];
const sessions = [
  ...Array.from({ length: 6 }, (_, i) => ({ id: `codex-${i + 1}`, name: `Codex ${i + 1}`, kind: 'codex', cwd: projects[0].path, projectName: projects[0].name, generation: i + 10 })),
  { id: 'other', name: 'Other Codex', kind: 'codex', cwd: projects[1].path, projectName: projects[1].name, generation: 1 },
];
const directory = text => identifySessionGroup({ text, projects }, sessions);
const group = directory('How many Vyp terminals do I have? in the Vibe terminal project.');
const prompt = 'Bye. Can you prompt one of them to do a review? on the last changes.';
const pending = () => captureRelay({ text: prompt, conversationGroup: group }, sessions);

test('spoken count binds six exact project generations and relay preserves the entire request', () => {
  assert.equal(group.projectPath, projects[0].path);
  assert.deepEqual(group.candidates, sessions.slice(0, 6).map(({ id, generation }) => ({ id, generation })));
  const relay = pending();
  assert.equal(relay.kind, 'send_prompt');
  assert.equal(relay.text, 'do a review? on the last changes.');
  assert.equal(relay.selection, 'any');
  for (let i = 0; i < 20; i++) {
    const selected = clarifyRelay("They're empty right now, so just pick a random one.", relay, sessions);
    assert.ok(group.candidates.some(c => c.id === selected.target.id && c.generation === selected.target.generation));
    assert.equal(selected.text, relay.text);
    assert.equal(selected.kind, 'send_prompt');
  }
});

test('directory scope preserves provider subset and rejects unsupported or quoted queries', () => {
  const mixed = [...sessions, { id: 'claude', kind: 'claude', cwd: projects[0].path, generation: 1 }];
  const codexGroup = identifySessionGroup({ text: 'How many Codex terminals do I have in vibeTerminal?', projects }, mixed);
  assert.deepEqual(codexGroup.candidates, group.candidates);
  assert.equal(codexGroup.provider, 'codex');
  assert.equal(identifySessionGroup({ text: 'List terminals in vibeTerminal', projects }, mixed).candidates.length, 7);
  for (const text of ['How many running terminals in vibeTerminal?', 'How many Codex terminals in vibeTerminal with errors?', 'Explain "list terminals in vibeTerminal"', 'Do not list terminals in vibeTerminal', 'If ready, list terminals in vibeTerminal', 'List terminals in vibeTerminal and Other', 'How many Codex or Claude terminals in vibeTerminal?']) {
    assert.equal(identifySessionGroup({ text, projects }, mixed), null, text);
  }
});

test('unbound pronouns never widen to project scope and explicit project group selects one', () => {
  assert.equal(captureRelay({ text: prompt, projectContext: projects[0] }, sessions), null);
  for (const locator of ['one of the Codex terminals in vibeTerminal', 'any terminal in the Vibe Terminal project', 'a random Codex terminal in vibeTerminal']) {
    const relay = captureRelay({ text: `Prompt ${locator} to review only; do not change files.`, projects }, sessions);
    assert.ok(relay, locator);
    assert.equal(relay.candidates.length, 6);
    assert.equal(relay.text, 'review only; do not change files.');
    assert.equal(selectRelay(relay, sessions).target.id === 'other', false);
  }
});

test('delegated selection cannot adopt a restarted, replacement, new or unrelated candidate', () => {
  const relay = pending();
  const changed = sessions.map(s => ({ ...s, generation: s.generation + 1 }));
  changed.push({ ...sessions[0], id: 'replacement' });
  assert.equal(selectRelay(relay, changed), null);
  assert.equal(clarifyRelay('pick any', relay, changed), null);
  const oneSurvivor = [...changed, sessions[2]];
  assert.deepEqual(selectRelay(relay, oneSurvivor).target, group.candidates[2]);
  assert.equal(selectRelay(relay, sessions, 'other'), null);
  assert.deepEqual(selectRelay(relay, sessions, 'codex-3').target, group.candidates[2]);
  assert.equal(captureRelay({ text: prompt, conversationGroup: group }, changed), null);
});

test('selection replies allow delegation and retain exact locator conflict checks', () => {
  for (const text of ['pick any', 'choose either', 'select any one', 'pick a random one', 'you choose', 'you pick', 'any one of them', "They are empty right now. Just choose a random one."]) assert.ok(clarifyRelay(text, pending(), sessions), text);
  assert.deepEqual(clarifyRelay('Codex 3', pending(), sessions).target, group.candidates[2]);
  assert.equal(clarifyRelay('Codex 3', pending(), sessions, 'codex-2'), null);
  assert.equal(clarifyRelay('pick any', pending(), sessions, 'other'), null);
  assert.deepEqual(clarifyRelay('pick any', pending(), sessions, 'codex-2').target, group.candidates[1]);
  for (const text of ['do not pick any', 'never choose either', 'if empty, pick a random one', 'pick any if empty', 'Explain "pick a random one"', '"pick a random one"', 'I said pick any', 'pick all of them', 'pick any and send it twice', "They're empty right now, so don't pick any", 'you choose unless busy']) assert.equal(clarifyRelay(text, pending(), sessions), null, text);
});

test('direct prompt and restricted speech lead-in retain payload and deny embedded action authority', () => {
  const payload = 'review the last changes; do not edit unless asked and then close Codex 1';
  const text = `Bye. Can you prompt Codex 1 to ${payload}`;
  assert.equal(commandClauses(text).length, 1);
  assert.equal(authorizeModelAction({ kind: 'send_prompt' }, { text }, sessions).text, payload);
  assert.throws(() => authorizeModelAction({ kind: 'close' }, { text }, sessions));
  assert.throws(() => authorizeModelAction({ kind: 'send_prompt', text: 'review the last changes' }, { text }, sessions), /COMPLETE/);
  for (const bad of ['Bye. Do not prompt Codex 1 to review', 'Bye. If empty, prompt Codex 1 to review', 'Bye. Explain how to prompt Codex 1 to review', 'Explain "prompt Codex 1 to review"', '"Prompt Codex 1 to review"', 'Never prompt one of them to review', 'Prompt one of them if empty to review', 'Prompt all of them to review', 'If empty, prompt one of them to review']) assert.equal(captureRelay({ text: bad, conversationGroup: group }, sessions), null, bad);
});
