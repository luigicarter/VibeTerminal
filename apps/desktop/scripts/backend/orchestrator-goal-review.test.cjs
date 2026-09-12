'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createGoalReviewer,INSPECTION_GOAL_REVIEW_SCHEMA}=require('../../backend/orchestratorGoalReview.cjs');
const response=value=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}]});
const model={id:'fixture',contextLength:128000};
test('goal completion requires cited observed evidence and caches unchanged judgments per request',async()=>{
  let calls=0;const reviewer=createGoalReviewer({complete:async()=>{calls++;return response({decision:'complete',evidenceIds:['page']});},recordDiagnostic(){}});
  const request={owner:{},goal:'Inspect quota',evidence:[{id:'page',text:'23% used'}],model};
  assert.equal((await reviewer.inspect(request)).decision,'complete');
  assert.equal((await reviewer.inspect(request)).decision,'complete');assert.equal(calls,1);
  await reviewer.inspect({...request,owner:{}});assert.equal(calls,2);
});
test('a fenced review reply is read exactly like the bare JSON it wraps',async()=>{
  const request={owner:{},goal:'Inspect quota',evidence:[{id:'page',text:'23% used'}],model};
  const fenced=text=>({choices:[{finish_reason:'stop',message:{content:text}}]});
  const wrapped=createGoalReviewer({complete:async()=>fenced('```json\n'+JSON.stringify({decision:'complete',evidenceIds:['page']})+'\n```'),recordDiagnostic(){}});
  assert.equal((await wrapped.inspect(request)).decision,'complete');
  const prose=createGoalReviewer({complete:async()=>fenced('```json\nThe evidence answers the goal.\n```'),recordDiagnostic(){}});
  assert.equal((await prose.inspect(request)).decision,'unresolved');
});
test('invented citations, malformed judgments and aborted reviews cannot complete a goal',async()=>{
  for(const value of [{decision:'complete',evidenceIds:['invented']},{decision:'complete',evidenceIds:[]},{decision:'complete'},'complete']){
    const reviewer=createGoalReviewer({complete:async()=>response(value),recordDiagnostic(){}});
    const request={owner:{},goal:'Inspect quota',evidence:[{id:'page',text:'Ready'}],model};
    assert.equal((await reviewer.inspect(request)).decision,'unresolved');
    await assert.rejects(()=>reviewer.inspect({...request,signal:AbortSignal.abort()}),/Cancelled/);
  }
});

test('the exported goal-review schema is flat, strict-mode friendly and enumerates both decisions',()=>{
  assert.equal(INSPECTION_GOAL_REVIEW_SCHEMA.type,'object');
  assert.equal(INSPECTION_GOAL_REVIEW_SCHEMA.additionalProperties,false);
  assert.equal(INSPECTION_GOAL_REVIEW_SCHEMA.oneOf,undefined);assert.equal(INSPECTION_GOAL_REVIEW_SCHEMA.anyOf,undefined);
  assert.deepEqual([...INSPECTION_GOAL_REVIEW_SCHEMA.required].sort(),Object.keys(INSPECTION_GOAL_REVIEW_SCHEMA.properties).sort());
  assert.deepEqual(INSPECTION_GOAL_REVIEW_SCHEMA.required,['decision','evidenceIds']);
  assert.deepEqual(INSPECTION_GOAL_REVIEW_SCHEMA.properties.decision.enum,['complete','continue']);
  assert.equal(INSPECTION_GOAL_REVIEW_SCHEMA.properties.evidenceIds.type,'array');
  assert.equal(INSPECTION_GOAL_REVIEW_SCHEMA.properties.evidenceIds.items.type,'string');
});

test('the required evidence list the schema forces on continue changes nothing',async()=>{
  const request={owner:{},goal:'Inspect quota',evidence:[{id:'page',text:'Ready'}],model};
  const reviewer=createGoalReviewer({complete:async()=>response({decision:'continue',evidenceIds:[]}),recordDiagnostic(){}});
  assert.deepEqual(await reviewer.inspect(request),{decision:'continue'});
});

test('a structured schema is requested only from a model that advertises structured outputs',async()=>{
  const bodies=[];
  const reviewer=createGoalReviewer({complete:async body=>{bodies.push(body);return response({decision:'continue'});},recordDiagnostic(){}});
  const request={owner:{},goal:'Inspect quota',evidence:[{id:'page',text:'Ready'}]};
  await reviewer.inspect({...request,model});
  await reviewer.inspect({...request,owner:{},model:{...model,supportedParameters:['tools','structured_outputs']}});
  assert.equal(bodies[0].response_format,undefined);
  assert.equal(bodies[1].response_format.json_schema.name,'goal_review');
  assert.equal(bodies[1].response_format.json_schema.strict,true);
  assert.deepEqual(bodies[1].response_format.json_schema.schema,INSPECTION_GOAL_REVIEW_SCHEMA);
});
