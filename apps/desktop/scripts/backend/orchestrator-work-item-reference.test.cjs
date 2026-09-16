'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createIntentInterpreter } = require('../../backend/orchestratorInterpreter.cjs');

// The work-item reference used to cost a second model call ("task affinity"),
// then a deterministic check and a repair round when the planner's claim did not
// stand. It now costs nothing at all: workItemId is not offered to the planner,
// so a claim cannot be made. Ownership is the application's own - the reply's
// work item on a continuation, and the assignment resolver's title match
// otherwise - and a claim that arrives anyway is dropped rather than refused.
// These cases replace scripts/backend/orchestrator-task-affinity.test.cjs.
const model = { id: 'scripted', contextLength: 128000, supportedParameters: ['tools', 'tool_choice'] };
const call = (args, name = 'plan_delegate_task') => ({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [
  { id: 'planner-1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] });

function harness(context, plans) {
  const asked = [], diagnostics = [];
  const interpret = createIntentInterpreter({
    complete: async body => { asked.push(body); const next = plans.shift(); assert.ok(next, 'every model call is scripted'); return next; },
    getTask: () => undefined, redact: value => value, cleanError: error => String(error?.message || error),
    recordDiagnostic: event => diagnostics.push(event), diagnosticError: (error, event) => diagnostics.push({ ...event, message: error?.message }),
  });
  return { asked, diagnostics, run: () => interpret(context, model, 512, new AbortController().signal, {}) };
}

const workItem = {
  id: 'work-chat', status: 'active', title: 'Add project chat section',
  objective: 'Add the project chat section to the sidebar dock; the conversation list is done and the composer is next.',
  cwd: 'C:/Projects/vibeTerminal', binding: { target: { id: 'pane-chat', generation: 2 } },
};
const context = instruction => ({ instruction, requestId: 'request-1', sessions: [], workItems: [workItem],
  roots: { projects: [{ id: 'project-1', name: 'vibeTerminal', path: 'C:/Projects/vibeTerminal' }] },
  projectContext: { id: 'project-1', name: 'vibeTerminal', path: 'C:/Projects/vibeTerminal' }, requests: [] });
const delegation = { cwd: 'C:/Projects/vibeTerminal', text: 'Connect the message composer.', workItemId: 'work-chat' };

test('an instruction that names the work item costs no call and makes no ownership claim', async () => {
  const fixture = harness(context('Tell the agent working on the project chat section to connect the composer.'), [call(delegation)]);
  const plan = await fixture.run();
  assert.equal(fixture.asked.length, 1, 'interpretation is the only model call the reference costs');
  assert.equal(plan.grants.length, 1);
  assert.equal(plan.grants[0].args.workItemId, undefined, 'the planner cannot claim an owner; assignment resolves one');
  assert.equal(plan.grants[0].args.assignmentMode, 'auto');
  assert.equal(plan.grants[0].text, 'Connect the message composer.');
});

test('an unrelated task cannot borrow an existing work item, and costs no repair round for it', async () => {
  const fixture = harness(context('Update the release checklist wording in vibeTerminal.'), [call(delegation)]);
  const plan = await fixture.run();
  assert.equal(fixture.asked.length, 1, 'a dropped claim is not a repair the model has to answer');
  assert.equal(plan.grants[0].args.workItemId, undefined);
  assert.equal(plan.grants[0].text, 'Connect the message composer.');
});

test('the reply this request answers is authority for its own work item without naming it', async () => {
  const replying = { ...context('Also cover expired coupons.'), replyWorkItem: workItem,
    replyContext: { requestId: 'request-0', status: 'finished', conversationTarget: { id: 'pane-chat', generation: 2 }, recentMessages: [] } };
  const fixture = harness(replying, [call({ cwd: delegation.cwd, text: delegation.text }, 'plan_continue_task')]);
  const plan = await fixture.run();
  assert.equal(fixture.asked.length, 1);
  assert.equal(plan.grants[0].args.workItemId, 'work-chat');
  assert.equal(plan.grants[0].args.assignmentMode, 'existing');
});
