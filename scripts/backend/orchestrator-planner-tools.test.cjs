'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {plannerTools,decodePlannerCalls}=require('../../backend/orchestratorPlannerTools.cjs');
const call=(name,args)=>({function:{name,arguments:JSON.stringify(args)}});
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
