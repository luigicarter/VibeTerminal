'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { normalizeIntent, authorizeIntentAction, claimGrant, projectIntent, INTENT_TOOL } = require('../../backend/orchestratorIntent.cjs');
const { createSessionDirectory } = require('../../backend/orchestratorIntegration.cjs');
const { remainingCloseScope } = require('../../backend/orchestratorCloseScope.cjs');
function fixture() {
  const directory = createSessionDirectory({ getRuntime: () => ({ listSnapshots: () => Array.from({length:4}, (_,i) => ({id:`p${i}`,generation:`g${i}`,launchToken:1,provider:'codex',cwd:'C:/elsewhere'})) }) });
  directory.updateUi(Array.from({length:8}, (_,i) => ({id:`p${i}`,launchToken:1,kind:'codex',projectId:'project',cwd:'C:/repo'})).concat({id:'global',kind:'terminal',launchToken:1,cwd:'C:/repo'}), ['C:/repo'], [], [{id:'project',path:'C:/repo'},{id:'empty',path:'C:/empty'}]);
  const context = {requestId:'request',instruction:'Close all project terminals',sessions:directory.list(),projects:directory.projects(),requireCloseScope:true};
  const compile = action => normalizeIntent({goal:'Close requested panes',actions:[{kind:'close',...action}]},context);
  return {directory,context,compile};
}
test('project scope includes four live and four dormant; membership ignores current cwd', () => {
  const f=fixture(), grant=f.compile({scope:{type:'project',projectId:'project'}}).grants[0];
  assert.equal(grant.targets.length,8); assert.equal(grant.targets.filter(target=>String(target.generation).startsWith('paused:')).length,4);
  assert(!grant.targets.some(target=>target.id==='global'));
  assert(grant.targets.every(target=>target.launchToken===1));
});
test('model scope is mandatory; project omissions rejected while exact explicit subset remains exact', () => {
  const f=fixture();
  assert.throws(()=>f.compile({targetIds:['p0','p1'],selection:'all'}),/scope selector/);
  assert.throws(()=>f.compile({scope:{type:'project',projectId:'project'},targetIds:['p0','p1']}),/complete selected scope/);
  assert.equal(f.compile({scope:{type:'explicit',targetIds:['p0','p1']}}).grants[0].targets.length,2);
  const schema=INTENT_TOOL.function.parameters.properties.actions.items.anyOf.find(item=>item.properties.kind.enum[0]==='close');
  assert(schema.required.includes('scope'));
  assert.equal(Object.hasOwn(schema.properties,'targetIds'),false);
  assert.equal(Object.hasOwn(schema.properties,'selection'),false);
});
test('empty known project is a frozen no-op, unknown project is rejected', () => {
  const f=fixture(),plan=f.compile({scope:{type:'project',projectId:'empty'}});
  assert.equal(plan.grants[0].closeScope.targetCount,0);
  const action=authorizeIntentAction({kind:'close'},plan,f.context.sessions);
  assert.deepEqual(action.closeScope.targets,[]);
  claimGrant(action,plan);
  assert.equal(projectIntent(plan).grants[0].dispatched,true);
  assert.throws(()=>claimGrant(action,plan),/already dispatched/);
  assert.throws(()=>f.compile({scope:{type:'project',projectId:'missing'}}),/known project/);
});
test('scope excludes runtime orphans and keeps global board distinct', () => {
  const f=fixture(); f.context.sessions.push({id:'orphan',generation:'g',launchToken:1,projectId:'project',visiblePane:false});
  assert.equal(f.compile({scope:{type:'workspace'}}).grants[0].targets.length,9);
  assert.deepEqual(f.compile({scope:{type:'board'}}).grants[0].targets.map(target=>target.id),['global']);
});
test('frozen scope does not grow and newer replacements survive reconciliation', () => {
  const f=fixture(),plan=f.compile({scope:{type:'project',projectId:'project'}}),grant=plan.grants[0];
  const later=f.context.sessions.filter(session=>session.id==='p0').map(session=>({...session,generation:'replacement',launchToken:2}));
  later.push({id:'new',generation:'new',launchToken:1,visiblePane:true,projectId:'project',board:'project'});
  assert.deepEqual(remainingCloseScope(grant.closeScope,later),{remainingTargetCount:0,newTargetCount:2});
  const authorized=authorizeIntentAction({kind:'close',targetId:'p0'},plan,later);
  assert.equal(authorized.target.generation,'g0'); assert.equal(authorized.target.launchToken,1);
  assert.throws(()=>authorizeIntentAction({kind:'close',target:{id:'p0',generation:'g0',launchToken:2}},plan,later),/Stale pane/);
});
test('a restart does not attach stale runtime identity to the replacement pane', () => {
  const directory=createSessionDirectory({getRuntime:()=>({listSnapshots:()=>[{id:'pane',generation:'old',launchToken:1,provider:'codex'}]})});
  directory.updateUi([{id:'pane',launchToken:2,kind:'codex',projectId:'project'}]);
  const current=directory.get('pane');assert.equal(current.launchToken,2);assert.equal(current.generation,'paused:pane:2');assert.equal(current.visiblePane,true);
});
test('continued close retains original snapshot and reconciles only remaining frozen targets', () => {
  const f=fixture(), original=f.compile({scope:{type:'project',projectId:'project'}}).grants[0];
  const remaining={...original,targets:original.targets.slice(4)};
  const context={...f.context,requestId:'retry',previousCommand:{requestId:'request',instruction:'Close all project terminals',grants:[remaining]},sessions:[]};
  const plan=normalizeIntent({goal:'Finish original closure',continuationOf:'request',actions:[{kind:'close',sourceUserId:'request',scope:{type:'project',projectId:'project'}}]},context);
  assert.equal(plan.grants[0].targets.length,4);assert.equal(plan.grants[0].closeScope.targetCount,8);assert.deepEqual(plan.grants[0].targets,remaining.targets);
});
test('redundant explicit-subset selection receives precise repair without widening the subset', () => {
  const f=fixture(),scope={type:'explicit',targetIds:['p0','p1']};
  assert.throws(()=>f.compile({scope,selection:'one'}),/already identifies the complete set; omit selection/);
  const repaired=f.compile({scope});assert.deepEqual(repaired.grants[0].targets.map(target=>target.id),['p0','p1']);
  assert.deepEqual(scope,{type:'explicit',targetIds:['p0','p1']});
  assert.deepEqual(f.compile({scope,selection:'all',targetIds:['p0','p1']}).grants[0].targets,repaired.grants[0].targets);
});
test('close dispatch cannot change frozen membership or launch identity after authorization', () => {
  const f=fixture(),plan=f.compile({scope:{type:'project',projectId:'project'}});
  const action=authorizeIntentAction({kind:'close',targetId:'p0'},plan,f.context.sessions);
  assert.throws(()=>claimGrant({...action,target:{...action.target,launchToken:2}},plan),/bound to the authorized target/);
  assert.throws(()=>claimGrant({...action,closeScope:{...action.closeScope,targetCount:1}},plan),/frozen close scope/);
  claimGrant(action,plan);
});
test('pending-to-live transition in the same launch is an original pane rather than a newly created one', () => {
  const f=fixture(),grant=f.compile({scope:{type:'project',projectId:'project'}}).grants[0];
  const pending=f.context.sessions.find(session=>session.id==='p4');
  assert.deepEqual(remainingCloseScope(grant.closeScope,[{...pending,generation:'started-runtime'}]),{remainingTargetCount:1,newTargetCount:0});
});
test('complete model close scope executes directly without enumerated executor calls', () => {
  const f=fixture();assert.equal(f.compile({scope:{type:'project',projectId:'project'}}).executionMode,'direct');
  const raw={goal:'Close all project panes',executionMode:'reason',actions:[{kind:'close',scope:{type:'project',projectId:'project'}}]};
  assert.equal(normalizeIntent(raw,f.context).executionMode,'direct');
  assert.equal(normalizeIntent(raw,{...f.context,requireCloseScope:false}).executionMode,'reason');
  assert.equal(normalizeIntent({...raw,clarification:'Which group?'},f.context).executionMode,'reason');
  assert.equal(normalizeIntent({...raw,dependsOnRequestIds:['producer']},{...f.context,tasks:[{requestId:'producer'}]}).executionMode,'reason');
});
