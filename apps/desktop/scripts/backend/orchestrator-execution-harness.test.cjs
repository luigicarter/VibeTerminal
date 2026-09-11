'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { executeToolBatch, createHarnessProgress } = require('../../backend/orchestratorExecutionHarness.cjs');
const call = (id, args) => ({ id, type: 'function', function: { name: 'workspace', arguments: JSON.stringify(args) } });
const batch = (calls, overrides = {}) => {
  const conversation = [], executed = [], results = [];
  return { conversation, executed, results, run: () => executeToolBatch({ reply: { tool_calls: calls }, conversation,
    execute: async args => { executed.push(args); return { ok: true }; }, onResult: item => results.push(item),
    checkActive() {}, canContinue: () => true, formatResult: JSON.stringify, ...overrides }) };
};
test('duplicate identities reject the entire batch before the first effect', async () => {
  const f = batch([call('same', { kind: 'close' }), call('same', { kind: 'read_session' })]);
  await assert.rejects(f.run, /duplicate/); assert.deepEqual(f.executed, []);
});
test('malformed arguments are repairable without exposing the private argument payload', async () => {
  const malformed = call('bad', {}); malformed.function.arguments = '{PRIVATE_PROMPT';
  const f = batch([malformed, call('read', { kind: 'list_sessions' })]);
  await f.run();
  assert.equal(f.results[0].result.validationFailure, true);
  assert.equal(f.results[0].result.error.includes('PRIVATE_PROMPT'), false);
  assert.deepEqual(f.executed, [{ kind: 'list_sessions' }]);
  assert.deepEqual(f.conversation.filter(item => item.role === 'tool').map(item => item.tool_call_id), ['bad', 'read']);
});
test('cancellation between two actions prevents the second action', async () => {
  let active = true;
  const f = batch([call('one', { kind: 'focus_session' }), call('two', { kind: 'close' })], {
    checkActive() { if (!active) throw new Error('Cancelled.'); },
    onResult() { active = false; },
  });
  await assert.rejects(f.run, /Cancelled/); assert.equal(f.executed.length, 1);
});
test('fresh tokens and timestamps do not disguise repeated unchanged evidence', () => {
  const tracker = createHarnessProgress(); let result;
  for (let i = 0; i < 7; i++) result = tracker.observe([{ args: { kind: 'read_session', targetId: 'a' },
    result: { ok: true, observationToken: String(i), observedAt: i, observation: { text: 'Same menu', sequence: i } } }], { grants: [] });
  assert.equal(result.blocked, true);
});
test('new source pages and completed commands reset stagnation', () => {
  const tracker = createHarnessProgress();
  const read = { args: { kind: 'read_conversation', reference: 'saved' }, result: { text: 'page', nextCursor: '1' } };
  for (let i = 0; i < 5; i++) tracker.observe([read], { dispatched: false });
  assert.equal(tracker.observe([{ ...read, result: { text: 'next', nextCursor: '2' } }], { dispatched: false }).stagnantRounds, 0);
  assert.equal(tracker.observe([read], { dispatched: true }).stagnantRounds, 0);
});
test('repeated controls cannot manufacture progress solely by increasing step counters', () => {
  const tracker=createHarnessProgress();let result;
  for(let steps=1;steps<=7;steps++)result=tracker.observe([{args:{kind:'terminal_interact',keys:['tab'],stepId:String(steps)},result:{ok:true,status:'written'}}],{steps,remainingSteps:128-steps,dispatched:false});
  assert.equal(result.blocked,true);
});
