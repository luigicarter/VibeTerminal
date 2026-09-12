'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {plannerTools,decodePlannerCalls}=require('../../backend/orchestratorPlannerTools.cjs');
const call=(name,args)=>({function:{name,arguments:JSON.stringify(args)}});

test('agent continuation binds an explicitly addressed work item without rediscovering terminal IDs', () => {
  const context = { sessions: [], replyWorkItem: { id: 'work-auth', binding: { target: { id: 'worker-auth' } } } };
  const tools = plannerTools(context);
  const request = { cwd: 'C:/App', text: 'Also test expired refresh tokens.' };
  const continued = decodePlannerCalls([call('plan_continue_task', request)], tools, request.text);
  assert.equal(continued.actions[0].workItemId, 'work-auth');
  assert.equal(continued.actions[0].kind, 'delegate_task', 'Continuation still uses normal task ownership validation.');
  assert.equal(continued.actions[0].assignmentMode, 'existing');
  assert.throws(() => decodePlannerCalls([call('plan_continue_task', { ...request, assignmentMode: 'new' })], tools, request.text), /existing owner/);
  const independent = decodePlannerCalls([call('plan_delegate_task', request)], tools, request.text);
  assert.equal(independent.actions[0].workItemId, undefined, 'A reply is not authority to reuse a conversation for independent work.');
  const otherTools = plannerTools({ ...context, targetId: 'different-worker' });
  assert.equal(decodePlannerCalls([call('plan_continue_task', request)], otherTools, request.text).actions[0].workItemId, undefined);
});
test('planner calls separate blank opening, unsent drafts, task assignment and request metadata',()=>{
  const tools=plannerTools({sessions:[]});
  const blank=tools.find(tool=>tool.function.name==='plan_open_blank_terminal');
  const draft=tools.find(tool=>tool.function.name==='plan_prepare_terminal_draft');
  assert.equal(blank.function.parameters.properties.text,undefined);assert(draft.function.parameters.required.includes('text'));
  assert.equal(tools[0].function.parameters.properties.actions,undefined);
  const result=decodePlannerCalls([call('plan_add_project',{path:'C:/App'}),call('plan_delegate_task',{cwd:'C:/App',text:'Review without editing.'}),call('interpret_workspace',{access:'read-only'})],tools,'Add and review.');
  assert.equal(result.goal,'Add and review.');assert.equal(result.access,'read-only');assert.deepEqual(result.actions.map(action=>action.kind),['add_project','delegate_task']);
});
test('planner decoder rejects unoffered functions, discriminator overrides and mixed authority formats',()=>{
  const tools=plannerTools({sessions:[]});
  for(const calls of [[call('plan_operate_terminal',{targetIds:['invented'],text:'Work'})],
    [call('plan_open_blank_terminal',{text:'Run work.'})], [call('plan_add_project',{kind:'remove_project',path:'C:/App'})],
    [call('interpret_workspace',{goal:'Mixed',actions:[]}),call('plan_add_project',{path:'C:/App'})]])assert.throws(()=>decodePlannerCalls(calls,tools,'Original request'));
});
test('conversation planning grants no effects and rejects mixed or extra authority',()=>{
  const tools=plannerTools({sessions:[]});
  assert.deepEqual(decodePlannerCalls([call('plan_conversation',{goal:'Explain the earlier error.'})],tools,'What was that error?'),
    {goal:'Explain the earlier error.',actions:[],access:'read-only',executionMode:'reason'});
  for(const calls of [[call('plan_conversation',{goal:'Explain',targetIds:['worker']})],
    [call('plan_conversation',{goal:'Explain'}),call('plan_close',{scope:{type:'workspace'}})]])assert.throws(()=>decodePlannerCalls(calls,tools,'Explain'));
});
