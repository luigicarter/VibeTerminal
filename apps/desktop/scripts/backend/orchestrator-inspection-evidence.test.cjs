'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createInspectionEvidence}=require('../../backend/orchestratorInspectionEvidence.cjs');
const target={id:'pane',generation:'g1',agentPid:10,conversationId:'thread'};
test('inspection completion cannot replace observed figures with invented quota or ceremonial prose',()=>{
  const evidence=createInspectionEvidence(),source='Session statistics: 2300 input tokens. Subscription quota is unavailable.';
  evidence.observe(target,{ok:true,id:'pane',generation:'g1',text:source});
  assert.equal(evidence.report(target,'Session statistics: 2300 input tokens.'),'Session statistics: 2300 input tokens.');
  assert.equal(evidence.report(target,'Your quota is 2300 tokens.'),'Observed terminal output:\n'+source);
  assert.equal(evidence.report(target,'Inspecting usage.'),'Observed terminal output:\n'+source);
});
test('evidence cannot cross a generation, process, conversation or failed read',()=>{
  const evidence=createInspectionEvidence();
  evidence.observe(target,{ok:true,id:'another',text:'Wrong target'});
  assert.throws(()=>evidence.report(target,'Wrong target'),/No current/);
  evidence.observe(target,{ok:true,text:'Observed limits'});
  for(const patch of [{generation:'g2'},{agentPid:11},{conversationId:'other'}])assert.throws(()=>evidence.report({...target,...patch},'Observed limits'),/No current/);
});
