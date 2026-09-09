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
