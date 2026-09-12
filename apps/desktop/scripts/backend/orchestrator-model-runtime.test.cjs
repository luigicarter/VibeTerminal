'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createModelRuntime,parseModelJson}=require('../../backend/orchestratorModelRuntime.cjs');
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
const schemaOption=name=>({type:'json_schema',json_schema:{name,strict:true,schema:{type:'object',additionalProperties:false,required:[],properties:{}}}});
test('a rejected reviewer schema is dropped once and the retry keeps the prose reply path',async()=>{
  const f=fixture([new OpenRouterError('upstream',400),{choices:[{finish_reason:'stop',message:{content:'{"decision":"ASSIGN"}'}}],usage:{cost:0.01}}]);
  const result=await f.runtime.complete({model:'fixture',response_format:schemaOption('target_review'),messages:[]});
  assert(result);assert.equal(f.calls.length,2);
  assert.equal(f.calls[0].response_format.json_schema.name,'target_review');
  assert.equal(f.calls[1].response_format,undefined);
  assert.deepEqual(f.events.filter(e=>e.stage==='model_started').map(e=>e.optionRepair),[undefined,'response_format']);
});
test('reasoning and schema rejections are repaired in sequence within the attempt bound',async()=>{
  const f=fixture([new OpenRouterError('upstream',400),new OpenRouterError('upstream',422),{choices:[],usage:{cost:0.02}}]);
  const result=await f.runtime.complete({model:'fixture',reasoning:{effort:'low'},response_format:schemaOption('close_review'),messages:[]});
  assert(result);assert.equal(f.calls.length,3);
  assert.equal(f.calls[1].reasoning,undefined);assert.equal(f.calls[1].response_format.json_schema.name,'close_review');
  assert.equal(f.calls[2].reasoning,undefined);assert.equal(f.calls[2].response_format,undefined);
});
test('a server failure never downgrades the reviewer schema',async()=>{
  const f=fixture([new OpenRouterError('upstream',500)]);
  await assert.rejects(()=>f.runtime.complete({model:'fixture',response_format:schemaOption('goal_review'),messages:[]}));
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].response_format.json_schema.name,'goal_review');
});
const signature=id=>[{type:'reasoning.encrypted',data:`OPAQUE_${id}`,format:'google-gemini-v1',id,index:0}];
const signed=(id,name)=>({role:'assistant',content:null,tool_calls:[{type:'function',index:0,id,function:{name,arguments:'{}'}}],reasoning_details:signature(id)});
const applicationTurn=(id,name)=>({role:'assistant',content:null,tool_calls:[{id,type:'function',function:{name,arguments:'{}'}}]});
const history=()=>[{role:'system',content:'rules'},{role:'user',content:'go'},
  signed('call_1','read_session'),{role:'tool',tool_call_id:'call_1',content:'{}'},
  signed('call_2','send_prompt'),{role:'tool',tool_call_id:'call_2',content:'{}'},
  applicationTurn('app-observation','workspace'),{role:'tool',tool_call_id:'app-observation',content:'{}'},
  signed('call_3','respond'),{role:'tool',tool_call_id:'call_3',content:'{}'},
  {role:'assistant',content:'Sent.'},{role:'system',content:'unfinished work'}];
const corrupted=()=>{const error=new OpenRouterError('request',400);error.reason='invalid-request';
  error.providerMessage='Provider returned error: {"error":{"code":400,"message":"Corrupted thought signature.","status":"INVALID_ARGUMENT"}}';return error;};
test('an application-authored turn stops signature replay without changing the history it is sent with',async()=>{
  const f=fixture([{choices:[{message:{content:'ok'}}]}]);
  const messages=history(),original=structuredClone(messages);
  await f.runtime.complete({model:'fixture',messages,tools:[{type:'function',function:{name:'workspace'}}]});
  assert.deepEqual(messages,original,'the caller history was mutated');
  const sent=f.calls[0].messages;
  assert.equal(sent.length,messages.length);
  assert.deepEqual(sent.map(m=>m.role),messages.map(m=>m.role));
  assert.deepEqual(sent.filter(m=>m.reasoning_details),[],'a partial signature replay was sent');
  // Only reasoning_details are withheld: content, tool calls and order are the caller's.
  assert.deepEqual(sent,original.map(({reasoning_details,...rest})=>rest));
  assert.deepEqual(f.events.filter(e=>e.stage==='model_started').map(e=>e.reasoningReplay),['aligned']);
});
test('a history the model authored alone keeps every replayed signature',async()=>{
  const f=fixture([{choices:[{message:{content:'ok'}}]}]);
  const messages=history().filter((_,index)=>![6,7].includes(index)).filter(m=>!(m.role==='assistant'&&!m.tool_calls));
  await f.runtime.complete({model:'fixture',messages});
  assert.deepEqual(f.calls[0].messages,messages);
  assert.deepEqual(f.events.filter(e=>e.stage==='model_started').map(e=>e.reasoningReplay),[undefined]);
});
test('a corrupted-signature rejection is retried once without replayed reasoning and nothing else changes',async()=>{
  const f=fixture([corrupted(),{choices:[{message:{content:'ok'}}]}]);
  const messages=history().filter((_,index)=>![6,7].includes(index)).filter(m=>!(m.role==='assistant'&&!m.tool_calls));
  const result=await f.runtime.complete({model:'fixture',messages,reasoning:{effort:'low'}});
  assert(result);assert.equal(f.calls.length,2);
  assert.equal(f.calls[0].messages.filter(m=>m.reasoning_details).length,3);
  assert.deepEqual(f.calls[1].messages,messages.map(({reasoning_details,...rest})=>rest));
  assert.deepEqual(f.calls[1].reasoning,{effort:'low'});
  assert.deepEqual(f.events.filter(e=>e.stage==='model_started').map(e=>e.optionRepair),[undefined,'reasoning_details']);
});
test('a corrupted-signature rejection is retried only once, and an unrelated 400 never strips reasoning',async()=>{
  const plain=history().filter((_,index)=>![6,7].includes(index)).filter(m=>!(m.role==='assistant'&&!m.tool_calls));
  const repeated=fixture([corrupted(),corrupted(),{choices:[{message:{content:'ok'}}]}]);
  await assert.rejects(()=>repeated.runtime.complete({model:'fixture',messages:plain}),{status:400});
  assert.equal(repeated.calls.length,2);
  // An application-authored turn already suppressed replay: there is no signature to repair.
  const aligned=fixture([corrupted()]);
  await assert.rejects(()=>aligned.runtime.complete({model:'fixture',messages:history()}),{status:400});
  assert.equal(aligned.calls.length,1);
  const unrelated=fixture([new OpenRouterError('request',400)]);
  await assert.rejects(()=>unrelated.runtime.complete({model:'fixture',messages:plain}),{status:400});
  assert.equal(unrelated.calls.length,1);
  assert.equal(unrelated.calls[0].messages.filter(m=>m.reasoning_details).length,3);
});
// Each repair is single-shot, but three rejections in a row must still leave an
// attempt for the request every repair has been applied to.
test('signature, reasoning and schema rejections are all repaired before the attempts run out',async()=>{
  const f=fixture([corrupted(),new OpenRouterError('upstream',400),new OpenRouterError('upstream',422),{choices:[],usage:{cost:0.03}}]);
  const messages=history().filter((_,index)=>![6,7].includes(index)).filter(m=>!(m.role==='assistant'&&!m.tool_calls));
  const result=await f.runtime.complete({model:'fixture',messages,reasoning:{effort:'low'},response_format:schemaOption('goal_review')});
  assert(result);assert.equal(f.calls.length,4);
  assert.equal(f.calls[0].messages.filter(m=>m.reasoning_details).length,3);
  assert.equal(f.calls[1].messages.filter(m=>m.reasoning_details).length,0);
  assert.deepEqual(f.calls[1].reasoning,{effort:'low'});
  assert.equal(f.calls[2].reasoning,undefined);assert.equal(f.calls[2].response_format.json_schema.name,'goal_review');
  assert.equal(f.calls[3].response_format,undefined);assert.equal(f.usage(),0.03);
  assert.deepEqual(f.events.filter(e=>e.stage==='model_started').map(e=>e.optionRepair),[undefined,'reasoning_details','reasoning_details','response_format']);
});
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
test('model bodies are never written to disk unless the debug directory is configured',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'model-debug-off-')),previous=process.env.LINA_MODEL_DEBUG_DIR;
  delete process.env.LINA_MODEL_DEBUG_DIR;
  try{
    const f=fixture([new OpenRouterError('request',400),new OpenRouterError('request',400),new OpenRouterError('request',400)]);
    await assert.rejects(()=>f.runtime.complete({model:'fixture',messages:[{role:'user',content:'hello'}]}));
    assert.deepEqual(fs.readdirSync(dir),[]);
  } finally { if(previous===undefined) delete process.env.LINA_MODEL_DEBUG_DIR; else process.env.LINA_MODEL_DEBUG_DIR=previous; fs.rmSync(dir,{recursive:true,force:true}); }
});
test('a configured debug directory captures the rejected body and the earlier accepted one, with keys redacted',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'model-debug-on-')),previous=process.env.LINA_MODEL_DEBUG_DIR;
  process.env.LINA_MODEL_DEBUG_DIR=dir;
  try{
    const f=fixture([{choices:[{message:{content:'ok'}}]},new OpenRouterError('request',400),new OpenRouterError('upstream',500),new OpenRouterError('upstream',500)]);
    await f.runtime.complete({model:'fixture',messages:[{role:'user',content:'first sk-or-v1-0123456789abcdef'}]});
    await assert.rejects(()=>f.runtime.complete({model:'fixture',messages:[{role:'user',content:'second'}]}));
    const files=fs.readdirSync(dir).sort();
    assert.equal(files.length,2,files.join(','));
    const failed=files.find(name=>!name.includes('-prev')),earlier=files.find(name=>name.includes('-prev1'));
    assert(failed&&earlier,files.join(','));
    const rejected=JSON.parse(fs.readFileSync(path.join(dir,failed),'utf8'));
    assert.equal(rejected.status,400);assert.equal(rejected.body.messages[0].content,'second');
    const accepted=JSON.parse(fs.readFileSync(path.join(dir,earlier),'utf8'));
    assert.equal(accepted.body.messages[0].content,'first [REDACTED]');
    // A 5xx is transport, not a rejected request shape: it leaves no body behind.
    await assert.rejects(()=>f.runtime.complete({model:'fixture',messages:[{role:'user',content:'third'}]}));
    assert.equal(fs.readdirSync(dir).length,2);
  } finally { if(previous===undefined) delete process.env.LINA_MODEL_DEBUG_DIR; else process.env.LINA_MODEL_DEBUG_DIR=previous; fs.rmSync(dir,{recursive:true,force:true}); }
});
test('a fenced reply parses exactly like the bare JSON it wraps',()=>{
  const value={relation:'same-task'},body=JSON.stringify(value);
  for(const content of [body,'```json\n'+body+'\n```','```JSON\n'+body+'\n```','```\n'+body+'\n```','```json\r\n'+body+'\r\n```\r\n','  ```json\n'+body+'\n```  \n'])
    assert.deepEqual(parseModelJson(content),value,JSON.stringify(content));
});
test('non-string input and prose around JSON still fail closed',()=>{
  for(const content of [undefined,{},[],'Here is the answer: '+JSON.stringify({relation:'same-task'}),JSON.stringify({relation:'same-task'})+' — also note this','```json\nnot json\n```','```json {"relation":"same-task"} ```'])
    assert.throws(()=>parseModelJson(content),undefined,`${JSON.stringify(content)} parsed`);
});
