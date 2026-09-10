'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createGoalReviewer}=require('../../backend/orchestratorGoalReview.cjs');
const response=value=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}]});
const model={id:'fixture',contextLength:128000};
test('goal completion requires cited observed evidence and caches unchanged judgments per request',async()=>{
  let calls=0;const reviewer=createGoalReviewer({complete:async()=>{calls++;return response({decision:'complete',evidenceIds:['page']});},recordDiagnostic(){}});
  const request={owner:{},goal:'Inspect quota',evidence:[{id:'page',text:'23% used'}],model};
  assert.equal((await reviewer.inspect(request)).decision,'complete');
  assert.equal((await reviewer.inspect(request)).decision,'complete');assert.equal(calls,1);
  await reviewer.inspect({...request,owner:{}});assert.equal(calls,2);
});
test('invented citations, malformed judgments and aborted reviews cannot complete a goal',async()=>{
  for(const value of [{decision:'complete',evidenceIds:['invented']},{decision:'complete',evidenceIds:[]},{decision:'complete'},'complete']){
    const reviewer=createGoalReviewer({complete:async()=>response(value),recordDiagnostic(){}});
    const request={owner:{},goal:'Inspect quota',evidence:[{id:'page',text:'Ready'}],model};
    assert.equal((await reviewer.inspect(request)).decision,'unresolved');
    await assert.rejects(()=>reviewer.inspect({...request,signal:AbortSignal.abort()}),/Cancelled/);
  }
});
