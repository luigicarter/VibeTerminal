'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const {createTerminalInput}=require('../../backend/orchestratorTerminalInput.cjs');
const {isObservedBusyPrompt,isBusyPromptSubmission,canQueueBusyPrompt}=require('../../backend/orchestratorBusyInput.cjs');
function fixture(patch={},readPatch={},writeResult={ok:true,status:'written'},sequence=2) {
 const session={id:'s',generation:'g',kind:'codex',provider:'codex',agentPid:42,processState:'running',agentProcessState:'running',turnId:'t',turnState:'running',observation:'observed',revision:1,childActivity:true,...patch};
 const action={target:{id:'s',generation:'g'},actionId:'a',operator:true,promptSubmission:true,text:'Review remaining changes',submit:true,requestId:'r',observationSequence:1,inputRevision:0};
 const writes=[]; const input=createTerminalInput({getSession:()=>session,readSession:async()=>{Object.assign(session,readPatch);return {ok:true,id:'s',generation:'g',sequence,inputRevision:0,cols:100,rows:28};},write:async payload=>{writes.push(payload);return writeResult;},now:()=>100});
 return {session,action,writes,input};
}
test('pure busy Codex submission survives output churn and logical children with fresh host evidence',async()=>{
 const h=fixture({},{revision:9}); const result=await h.input.handle(h.action); assert.equal(result.status,'written'); assert.equal(result.inputDisposition,'submitted-while-running'); assert.equal(result.turnId,undefined); assert.deepEqual(result.deliveryBaseline,{submittedAt:100,kind:'codex',turnId:'t',turnState:'running'}); assert.equal(h.writes[0].interactionEvidence.sequence,2); assert.equal(h.writes[0].interactionEvidence.revision,9);
});
test('busy capability cannot apply to keys, input overrides, questions, stale input, or changed root',async()=>{
 for(const patch of [{keys:['ctrl-c']},{editInput:true},{promptSubmission:false},{mouse:{}}]) {const h=fixture();Object.assign(h.action,patch);assert.equal(isBusyPromptSubmission(h.action,h.session),false);assert.equal((await h.input.handle(h.action)).ok,false);assert.equal(h.writes.length,0);}
 for(const patch of [{turnState:'waiting'},{pendingInteraction:true},{agentProcessState:'exited'},{binding:{status:'ambiguous'}},{provider:'claude',kind:'claude'}]) {const h=fixture(patch);assert.equal((await h.input.handle(h.action)).ok,false);assert.equal(h.writes.length,0);}
 for(const patch of [{agentPid:43},{turnId:'new'},{agentProcessState:'exited'}]) {const h=fixture({},patch);assert.equal((await h.input.handle(h.action)).ok,false);assert.equal(h.writes.length,0);}
 const h=fixture();h.action.inputRevision=2;const stale=await h.input.handle(h.action);assert.equal(stale.status,'stale-observation');assert.equal(canQueueBusyPrompt(h.action,h.session,stale),false);
});
test('only proven unsent busy failures can queue; ownership and uncertain writes never replay',async()=>{
 const h=fixture({provider:'claude',kind:'claude'});const result=await h.input.handle(h.action);assert.equal(canQueueBusyPrompt(h.action,h.session,result),true);
 for(const status of ['unknown','written','input-buffer-occupied','blocked','not-running']) assert.equal(canQueueBusyPrompt(h.action,h.session,{status,delivery:status==='unknown'?undefined:'not-dispatched'}),false);
 assert.equal(canQueueBusyPrompt(h.action,{...h.session,pendingInteraction:true},result),false);
 const unknown=fixture({}, {}, {ok:false,status:'unknown'});const first=await unknown.input.handle(unknown.action);await unknown.input.handle(unknown.action);assert.equal(canQueueBusyPrompt(unknown.action,unknown.session,first),false);assert.equal(unknown.writes.length,1);
});

test('all app prompt writes carry actual ready or busy baseline and reject unstable fresh evidence',async()=>{
 const idle=fixture({turnState:'idle',childActivity:false});idle.action.observationSequence=2;
 const ready=await idle.input.handle(idle.action);assert.equal(ready.inputDisposition,'submitted-when-ready');assert.deepEqual(ready.deliveryBaseline,{submittedAt:100,kind:'codex',turnId:'t',turnState:'idle'});
 for(const sequence of [null,-1,NaN,Infinity,1.5,'2']) {const h=fixture({}, {}, {ok:true,status:'written'},sequence);const result=await h.input.handle(h.action);assert.equal(result.status,'stale-observation');assert.equal(h.writes.length,0);}
 const changed=fixture({turnStartedAt:1},{turnStartedAt:2});assert.equal((await changed.input.handle(changed.action)).status,'recipient-unavailable');assert.equal(changed.writes.length,0);
 const zero=fixture({generation:0});zero.action.target.generation=0;assert.equal(isBusyPromptSubmission(zero.action,zero.session),true);
 const refused=fixture({}, {}, {ok:false,status:'input-buffer-occupied',delivery:'not-dispatched'});const blocked=await refused.input.handle(refused.action);assert.equal(blocked.deliveryBaseline,undefined);assert.equal(blocked.inputDisposition,undefined);
});

test('observed busy queue eligibility tolerates unsupported provider but never expands direct input capability',()=>{
 const h=fixture({provider:'claude',kind:'claude'}); assert.equal(isObservedBusyPrompt(h.action,h.session),true); assert.equal(isBusyPromptSubmission(h.action,h.session),false);
 for(const patch of [{observation:'unknown'},{turnState:'idle'},{turnId:undefined},{pendingInput:'submit'},{pendingInteraction:true},{manualInputPending:true},{interactionInputPending:true},{heldMouseButton:'left'},{kind:'terminal'},{agentPid:undefined}]) assert.equal(isObservedBusyPrompt(h.action,{...h.session,...patch}),false);
 for(const patch of [{promptSubmission:false},{editInput:true},{keys:['ctrl-u']},{submit:false}]) assert.equal(isObservedBusyPrompt({...h.action,...patch},h.session),false);
});
test('original busy prompt observation rejects changed turn before adapter and remains queue eligible',async()=>{
 const h=fixture({turnId:'B',turnStartedAt:2});h.action.promptObservation={agentPid:42,turnId:'A',turnStartedAt:1};
 const result=await h.input.handle(h.action);assert.equal(result.delivery,'not-dispatched');assert.equal(h.writes.length,0);assert.equal(canQueueBusyPrompt(h.action,h.session,result),true);
 const same=fixture({turnStartedAt:1});same.action.promptObservation={agentPid:42,turnId:'t',turnStartedAt:1};assert.equal((await same.input.handle(same.action)).status,'written');
});

test('idle-only intent cannot become a native busy submission or its queued fallback', async () => {
  const h = fixture(); h.action.targetAvailability = 'idle';
  assert.equal(isBusyPromptSubmission(h.action, h.session), false);
  assert.equal(canQueueBusyPrompt(h.action, h.session, { ok: false, status: 'recipient-unavailable', delivery: 'not-dispatched' }), false);
  const result = await h.input.handle(h.action);
  assert.equal(result.delivery, 'not-dispatched'); assert.equal(h.writes.length, 0);
});
test('actual prompt baseline is installed synchronously before write can publish terminal events',async()=>{
 const h=fixture({turnStartedAt:1});const calls=[];
 const input=createTerminalInput({getSession:()=>h.session,readSession:async()=>({ok:true,id:'s',generation:'g',sequence:2,inputRevision:0,cols:100,rows:28}),onBeforeWrite:metadata=>{calls.push(['prepare',metadata]);},write:async()=>{assert.equal(calls.length,1);assert.equal(calls[0][1].deliveryBaseline.turnId,'t');calls.push(['write']);return {ok:true,status:'written'};},now:()=>100});
 const result=await input.handle(h.action);assert.equal(result.status,'written');assert.equal(calls[0][1].status,'unconfirmed');assert.equal(calls[0][1].inputDisposition,'submitted-while-running');assert.equal(calls[0][1].actionId,'a');
});

test('busy write failure without no-write proof stays unknown and cannot replay', async () => {
  const h = fixture({}, {}, { ok: false, status: 'write-failed', error: 'Transport closed during write.' });
  const result = await h.input.handle(h.action);
  assert.equal(result.status, 'unknown'); assert.equal(result.inputDisposition, 'submitted-while-running');
  assert.equal(canQueueBusyPrompt(h.action, h.session, result), false);
  await h.input.handle(h.action); assert.equal(h.writes.length, 1);
});
