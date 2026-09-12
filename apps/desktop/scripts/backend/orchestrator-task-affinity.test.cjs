'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { SCHEMA, evidence, decision } = require('../../backend/orchestratorTaskAffinity.cjs');
const response = body => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(body) } }] });

test('a title provides context but cannot replace the required observed task quotation', () => {
  const input = evidence({ currentInstruction: 'Tell the agent working on the project chat section to continue.',
    requestedObjective: 'Continue its work.', existingTitle: 'Add project chat section', existingObjective: '' });
  assert.equal(decision(response({ relation: 'same-task', userEvidence: 'project chat section', workEvidence: 'project chat section' }), input), 'unclear');
  const observed = evidence({ ...input, existingObjective: 'Conversation list done; next connect the message composer.' });
  assert.equal(decision(response({ relation: 'same-task', userEvidence: 'project chat section', workEvidence: 'connect the message composer' }), observed), 'same-task');
});

test('a fenced reply is judged exactly like the bare JSON it wraps', () => {
  const input = evidence({ currentInstruction: 'Tell the agent working on the project chat section to continue.',
    requestedObjective: 'Continue its work.', existingTitle: 'Add project chat section',
    existingObjective: 'Conversation list done; next connect the message composer.' });
  const fenced = text => ({ choices: [{ finish_reason: 'stop', message: { content: text } }] });
  const body = JSON.stringify({ relation: 'same-task', userEvidence: 'project chat section', workEvidence: 'connect the message composer' });
  assert.equal(decision(fenced('```json\n' + body + '\n```'), input), 'same-task');
  assert.equal(decision(fenced('```json\nThe agent is continuing the same task.\n```'), input), 'unclear');
});

test('the exported schema is strict-mode friendly and encodes the relation contract', () => {
  assert.equal(SCHEMA.type, 'object');
  assert.equal(SCHEMA.additionalProperties, false);
  assert.equal(SCHEMA.oneOf, undefined); assert.equal(SCHEMA.anyOf, undefined);
  assert.deepEqual([...SCHEMA.required].sort(), Object.keys(SCHEMA.properties).sort());
  assert.deepEqual(SCHEMA.required, ['relation', 'userEvidence', 'workEvidence']);
  assert.deepEqual(SCHEMA.properties.relation.enum, ['same-task', 'independent', 'unclear']);
  assert.equal(SCHEMA.properties.userEvidence.type, 'string');
  assert.equal(SCHEMA.properties.workEvidence.type, 'string');
});
