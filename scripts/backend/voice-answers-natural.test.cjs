'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { matchAnswer, questionSpeech } = require('../../backend/voiceAnswers.cjs');
const question = { options: [{ label: 'Keep files' }, { label: 'Delete files' }], custom: true };

test('natural explicit selections resolve without another model or clarification turn', () => {
  for (const text of ['the second one', 'go with option two', 'Please choose the second option.', 'I’d like the second one please', "I'll take Delete files", 'use number 2']) {
    assert.deepEqual(matchAnswer(text, question), { ok: true, value: 'Delete files' }, text);
  }
  assert.deepEqual(matchAnswer('the first one and the second option', { ...question, multiple: true }), { ok: true, value: ['Keep files', 'Delete files'] });
  assert.deepEqual(matchAnswer('go with Keep files please', question), { ok: true, value: 'Keep files' });
});

test('qualified, negative, conflicting and unrelated replies stay with the semantic router', () => {
  for (const text of ['not the second one', 'the second one if the backup is ready', 'the second one but keep logs', 'the one', 'two one', 'one or two', 'one and two', 'choose three', 'go with the safest one', 'tell another terminal to use option two']) {
    assert.equal(matchAnswer(text, question).ok, false, text);
  }
  const duplicate = { options: [{ label: 'Keep files' }, { label: 'keep files!' }] };
  assert.equal(matchAnswer('keep files', duplicate).ok, false);
  assert.equal(matchAnswer('go with keep files', duplicate).ok, false);
  assert.deepEqual(matchAnswer('the second one', duplicate), { ok: true, value: 'keep files!' });
});

test('whole option labels with conjunctions take precedence over splitting', () => {
  const q = { options: [{ label: 'Build and test' }, { label: 'Review, then commit' }] };
  assert.deepEqual(matchAnswer('go with Build and test', q), { ok: true, value: 'Build and test' });
  assert.deepEqual(matchAnswer('Review, then commit', q), { ok: true, value: 'Review, then commit' });
});

test('permissions retain explicit vocabulary and never inherit choice wrappers', () => {
  for (const text of ['yes', 'sure', 'go ahead', 'the first one', 'go with allow always', 'allow once but only after review']) {
    assert.equal(matchAnswer(text, {}, 'permission').ok, false, text);
  }
  assert.deepEqual(matchAnswer('allow once', {}, 'permission'), { ok: true, value: 'once' });
  assert.deepEqual(matchAnswer('reject', {}, 'permission'), { ok: true, value: 'reject' });
});

test('question speech offers natural custom answers without repeating a command incantation', () => {
  const speech = questionSpeech({ sessionName: 'Coder', questions: [{ ...question, question: 'Which files?' }] }, 0);
  assert.match(speech, /Option 1: Keep files.*Option 2: Delete files/);
  assert.match(speech, /give your own answer/);
  assert.doesNotMatch(speech, /say custom answer/i);
  assert.deepEqual(matchAnswer('custom answer keep only logs', question), { ok: true, value: 'keep only logs' });
});
