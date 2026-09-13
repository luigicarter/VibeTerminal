'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {normalizeIntent}=require('../../backend/orchestratorIntent.cjs');
function fixture() {
  const previousCommand={requestId:'original',instruction:'Review only, then summarize.',access:'read-only',dependsOnRequestIds:['producer'],afterResults:{instruction:'then summarize'},
    candidates:[{id:'pane',generation:'g'}],grants:[{kind:'operate_terminal',targets:[{id:'pane',generation:'g'}],args:{},text:'Review only.',promptMode:'compose',answerMode:'delegated',permissionMode:'none',lifecycleMode:'preserve'}]};
  const context={requestId:'retry',instruction:'Action my previous request.',previousCommand,tasks:[{requestId:'producer'}],sessions:[{id:'pane',generation:'g',kind:'codex'}]};
  return {context,compile:patch=>normalizeIntent({goal:'Continue original review',continuationOf:'original',actions:[{kind:'operate_terminal',sourceUserId:'original'}],...patch},context)};
}
test('ordinary nonqueued continuation retains read-only, genuine prerequisites and deferred instruction',()=>{
  const f=fixture(),plan=f.compile({});assert.equal(plan.access,'read-only');assert.deepEqual(plan.dependsOnRequestIds,['producer']);assert.deepEqual(plan.afterResults,{instruction:'then summarize'});
  assert.equal(plan.grants[0].text,'Review only.');assert.equal(plan.grants[0].sourceUserId,'original');
});
test('continuation cannot widen access or rewrite deferred objective',()=>{const f=fixture();assert.throws(()=>f.compile({access:'mutation'}),/read-only scope/);assert.throws(()=>f.compile({afterResults:{instruction:'change files'}}),/deferred instruction/);});
test('clarification hops preserve constraints without inventing prerequisite on the source',()=>{const f=fixture(),plan=f.compile({actions:[],clarification:'Which report format?'});assert.equal(plan.access,'read-only');assert.deepEqual(plan.dependsOnRequestIds,['producer']);assert(!plan.dependsOnRequestIds.includes('original'));});
test('mixed continuation and current-source focus retain all original constraints',()=>{
  const f=fixture();
  const plan=f.compile({actions:[{kind:'operate_terminal',sourceUserId:'original'},{kind:'focus_session',sourceUserId:'retry',targetIds:['pane']}]});
  assert.equal(plan.access,'read-only');assert.deepEqual(plan.dependsOnRequestIds,['producer']);assert.deepEqual(plan.afterResults,{instruction:'then summarize'});
  assert.equal(plan.grants[0].sourceUserId,'original');assert.equal(plan.grants[1].sourceUserId,'retry');
  assert.throws(()=>f.compile({actions:[{kind:'operate_terminal',sourceUserId:'original'},{kind:'focus_session',targetIds:['pane']}],afterResults:{instruction:'change files'}}),/deferred instruction/);
});
test('mixed continuation cannot hide new code tasks behind inherited read-only access',()=>{
  const f=fixture();
  for(const access of [undefined,'read-only','mutation']) {
    assert.throws(()=>f.compile({...(access&&{access}),actions:[{kind:'operate_terminal',sourceUserId:'original'},
      {kind:'operate_terminal',sourceUserId:'retry',targetIds:['pane'],text:'Fix the failing tests and edit the files.'}]}),/mixed task access|read-only scope/);
  }
});
test('mixed continuation conservatively retains original and newly supplied prerequisites',()=>{
  const f=fixture();f.context.tasks.push({requestId:'second-producer'});
  const plan=f.compile({dependsOnRequestIds:['second-producer'],actions:[{kind:'operate_terminal',sourceUserId:'original'},{kind:'navigate',view:'history'}]});
  assert.deepEqual(plan.dependsOnRequestIds,['producer','second-producer']);assert.equal(plan.access,'read-only');assert.deepEqual(plan.afterResults,{instruction:'then summarize'});
});
test('claimed unbound creation preserves its exact deferred clause through clarification',()=>{
  const f=fixture();f.context.previousCommand.grants=[];f.context.previousCommand.unboundCreation=true;
  const plan=f.compile({actions:[],clarification:'Which launcher should finish starting?'});
  assert.deepEqual(plan.afterResults,{instruction:'then summarize'});assert.equal(plan.continuationOf,'original');
  delete f.context.previousCommand.unboundCreation;
  assert.throws(()=>f.compile({actions:[],clarification:'Which launcher?'}),/initial terminal task/);
  assert.throws(()=>f.compile({actions:[],unboundCreation:true}),/intent fields/);
});

// The reply that was refused outright on 2026-09-13. Lina had asked "Claude Code
// in vibeTerminal is running and waiting at the prompt. Would you like me to send
// the prompt to investigate the performance and voice detection cutoff issues
// now?" and the user answered it and added work in one breath. The whole request
// was rejected with "I could not interpret that request. Please try again."
const ANSWER_AND_NEW_WORK = 'Yes. And also make a new cloud code terminal to look at the conversations I have with the orchestrator and basically just get one of the cloud code terminals to work on that while the other works on the other things.';
function askedFixture() {
  const previousCommand = { requestId: 'asked', access: 'read-only', responseKind: 'terminal-inspection',
    instruction: 'Check whether the Claude terminal is ready for the performance and voice cutoff investigation.',
    grants: [{ kind: 'operate_terminal', targets: [{ id: 'claude-pane', generation: 'g' }], args: {},
      text: 'Investigate the performance and voice detection cutoff issues.', inspection: true,
      promptMode: 'compose', answerMode: 'delegated', permissionMode: 'none', lifecycleMode: 'preserve' }] };
  const context = { requestId: 'reply', instruction: ANSWER_AND_NEW_WORK, previousCommand,
    launchers: [{ kind: 'claude', label: 'Claude Code', available: true, configured: true }],
    sessions: [{ id: 'claude-pane', generation: 'g', kind: 'claude', cwd: 'C:/repo/vibeTerminal' }] };
  return { context, compile: patch => normalizeIntent({ goal: 'Answer the question and open a second Claude pane.',
    continuationOf: 'asked', ...patch }, context) };
}

test('answering a read-only question and asking for new work in one breath compiles as both', () => {
  const f = askedFixture();
  const plan = f.compile({ access: 'mutation', actions: [
    { kind: 'operate_terminal', sourceUserId: 'asked' },
    { kind: 'delegate_task', cwd: 'C:/repo/vibeTerminal', kindOfSession: 'claude',
      text: 'Review the saved Orchestrator conversations and report what they show.' }] });
  assert.deepEqual(plan.grants.map(grant => grant.kind), ['operate_terminal', 'delegate_task']);
  // The answer keeps the scope the question was asked under; the new work is an
  // ordinary task; the request as a whole is the wider of the two.
  assert.equal(plan.grants[0].sourceUserId, 'asked');
  assert.equal(plan.grants[0].access, 'read-only');
  assert.equal(plan.grants[0].inspection, true, 'the continued inspection keeps its informational scope');
  assert.equal(plan.grants[0].text, 'Investigate the performance and voice detection cutoff issues.');
  assert.equal(plan.grants[1].sourceUserId, 'reply');
  assert.equal(plan.grants[1].access, undefined);
  assert.equal(plan.grants[1].args.kindOfSession, 'claude');
  assert.equal(plan.access, 'mutation');
  assert.equal(plan.responseKind, undefined, 'a reply that adds work is no longer an informational request');
});

test('a reply that only answers the read-only question still cannot widen it', () => {
  const f = askedFixture();
  const plan = f.compile({ actions: [{ kind: 'operate_terminal', sourceUserId: 'asked' }] });
  assert.equal(plan.access, 'read-only');
  assert.equal(plan.responseKind, 'terminal-inspection');
  assert.equal(plan.grants[0].access, undefined, 'an unmixed continuation records no per-grant scope');
  assert.throws(() => f.compile({ access: 'mutation', actions: [{ kind: 'operate_terminal', sourceUserId: 'asked' }] }), /read-only scope/);
});

test('new work inside the pane the reply is only reading is still refused', () => {
  const f = askedFixture();
  assert.throws(() => f.compile({ access: 'mutation', actions: [
    { kind: 'operate_terminal', sourceUserId: 'asked' },
    { kind: 'operate_terminal', targetIds: ['claude-pane'], text: 'Fix the failing tests and edit the files.' }] }),
  /mixed task access/);
});
