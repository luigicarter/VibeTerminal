'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createModelRuntime}=require('../../backend/orchestratorModelRuntime.cjs');
const {OpenRouterError}=require('../../backend/openRouterErrors.cjs');
function fixture(sequence){const calls=[],events=[];let usage=0;const runtime=createModelRuntime({request:async(_url,options)=>{calls.push(JSON.parse(options.body));const next=sequence.shift();if(next instanceof Error)throw next;return next;},getContext:()=>undefined,assertBudget(){},recordUsage:cost=>{usage+=cost;},recordDiagnostic:event=>events.push(event)});return {runtime,calls,events,usage:()=>usage};}
test('transient HTTP failure and request-option repair have independent bounded allowances',async()=>{
  const f=fixture([new OpenRouterError('upstream',502),new OpenRouterError('upstream',400),{choices:[],usage:{cost:0.02}}]);
  const result=await f.runtime.complete({model:'fixture',reasoning:{effort:'low'},messages:[]});
  assert(result);assert.equal(f.calls.length,3);assert.equal(f.calls[2].reasoning,undefined);assert.equal(f.usage(),0.02);
});
test('repeated server errors stop after one retry and cancellation prevents retry',async()=>{
  const f=fixture([new OpenRouterError('upstream',503),new OpenRouterError('upstream',503)]);
  await assert.rejects(()=>f.runtime.complete({model:'fixture',messages:[]}));assert.equal(f.calls.length,2);
  const cancelled=fixture([]);await assert.rejects(()=>cancelled.runtime.complete({model:'fixture'},AbortSignal.abort()),/Cancelled/);assert.equal(cancelled.calls.length,0);
});
