'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { interpretTestIntent } = require('./orchestrator-test-intent.cjs');
test('scripted interpreter uses the slim native roster without consulting executor plans', () => {
  const prompt = "Write-Output ('HELLO_' + 'WORLD'); Write-Output (Get-Location)";
  const intent = interpretTestIntent({ instruction: `Send shell-one: ${prompt}`,
    roster: [{ id: 'shell-one', generation: 'g1', name: 'Terminal 1', provider: 'terminal', cwd: 'C:/fixture', state: 'free' }],
    roots: { documents: 'C:/fixture', projects: [{ name: 'Fixture', path: 'C:/fixture' }] } });
  assert.equal(intent.actions.length, 1);
  assert.equal(intent.actions[0].kind, 'send_prompt');
  assert.equal(intent.actions[0].text, prompt);
  assert.deepEqual(intent.actions[0].targetIds, ['shell-one']);
});
