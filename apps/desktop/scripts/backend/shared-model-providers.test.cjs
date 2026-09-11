'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const providers=require('../../backend/modelProviders.cjs'),claude=require('../../backend/providerProfiles.cjs'),codex=require('../../backend/openCodexProviders.cjs');
const {createClaudeGateway}=require('../../backend/claudeProviderGateway.cjs');
const {createAdapter,sseData}=require('../../backend/openCodexAdapter.cjs');
const {toResponses}=require('../../backend/anthropicProtocol.cjs');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'lina-shared-models-'));
const old={};for(const key of ['LINA_MODEL_PROVIDERS_FILE','VIBE_CLAUDE_PROVIDERS_FILE','LINA_OPEN_CODEX_PROVIDERS_FILE']){old[key]=process.env[key];delete process.env[key];}
process.env.LINA_MODEL_PROVIDERS_FILE=path.join(root,'model-providers.json');
test.after(()=>{for(const[key,value]of Object.entries(old)){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
const sse=values=>new Response(values.map(value=>`data: ${JSON.stringify(value)}\n\n`).join(''),{headers:{'Content-Type':'text/event-stream'}});
const chunk=(delta,finish_reason=null)=>({choices:[{index:0,delta,finish_reason}]});
const model={id:'custom-model',label:'Custom Model',contextWindow:32768,reasoning:false,imageInput:false};
function store(mode='chat-completions') {return {listProfiles:()=>({models:[{...model,key:'provider/custom-model',providerId:'provider',providerName:'Fixture'}]}),resolveModel:key=>{assert.equal(key,'provider/custom-model');return {...model,key,apiMode:mode,baseUrl:'https://fixture.invalid/v1',apiKey:'upstream-secret'};}};}
async function message(gateway,body) {return fetch(`${gateway.baseUrl}/v1/messages`,{method:'POST',headers:{'x-api-key':gateway.token,'Content-Type':'application/json'},body:JSON.stringify(body)});}
const body={model:'provider/custom-model',messages:[{role:'user',content:'Hello'}],max_tokens:1024,stream:true};
async function collect(response){const events=[];for await(const data of sseData(response.body))events.push(JSON.parse(data));return events;}

test('both legacy stores migrate once with IDs, models, defaults, ciphertext, and original files preserved',()=>{
  const claudeFile=path.join(root,'claude-providers.json'),codexFile=path.join(root,'open-codex-providers.json');
  const legacyClaude={version:1,defaultProfileId:'prov_legacy',profiles:[{id:'prov_legacy',name:'Legacy Claude',baseUrl:'https://fixture.invalid/anthropic',model:'claude-test',smallFastModel:'claude-fast',apiKey:'encrypted-original',encrypted:true}]};
  const legacyCodex={version:1,defaultModel:'oc_legacy/custom-model',profiles:[{id:'oc_legacy',name:'Legacy Codex',baseUrl:'https://fixture.invalid/v1',apiMode:'auto',models:[model],apiKey:'test-key',encrypted:false}]};
  fs.writeFileSync(claudeFile,JSON.stringify(legacyClaude));fs.writeFileSync(codexFile,JSON.stringify(legacyCodex));
  const list=providers.listProfiles();assert.equal(list.profiles.length,2);assert.equal(list.models.length,3);assert.equal(list.defaultModel,'prov_legacy/claude-test');
  assert.deepEqual(JSON.parse(fs.readFileSync(claudeFile)),legacyClaude);assert.deepEqual(JSON.parse(fs.readFileSync(codexFile)),legacyCodex);
  const saved=JSON.parse(fs.readFileSync(providers.storePath()));assert.equal(saved.profiles[0].apiKey,'encrypted-original');assert.equal(saved.profiles[0].apiMode,'anthropic');
  assert.ok(!JSON.stringify(list).includes('encrypted-original'));assert.equal(claude.listProfiles().profiles.length,codex.listProfiles().profiles.length);
  providers.deleteProfile('oc_legacy');assert.equal(codex.listProfiles().profiles.length,1,'deletion cannot re-import the old file');
});
test('a shared model/default change is immediately visible to both runtimes',()=>{
  const created=providers.upsertProfile({name:'Shared',baseUrl:'https://fixture.invalid/v1',apiKey:'shared-secret',models:[model,{...model,id:'second'}]});assert.equal(created.ok,true);
  const key=providers.modelKey(created.profile.id,'second');providers.setDefaultModel(key);
  assert.equal(codex.listProfiles().defaultModel,key);assert.equal(claude.getProfileConnection('default-custom').model,'second');
  assert.equal(claude.listProfiles().defaultProfileId,created.profile.id);
  assert.deepEqual(claude.listProfiles().profiles.find(row=>row.id===created.profile.id).models.map(row=>row.id),['custom-model','second']);
});
test('Claude message/tool-result history translates without changing tool identities',()=>{
  const result=toResponses({...body,messages:[{role:'assistant',content:[{type:'tool_use',id:'call_a',name:'Read',input:{file_path:'file'}}]},{role:'user',content:[{type:'tool_result',tool_use_id:'call_a',content:'file text'},{type:'text',text:'Continue'}]}],tools:[{name:'Read',input_schema:{type:'object'}}]});
  assert.equal(result.input[0].call_id,'call_a');assert.equal(result.input[1].call_id,'call_a');assert.equal(result.input[1].output,'file text');assert.equal(result.input[2].content[0].text,'Continue');
});
test('Claude uses an OpenAI Chat Completions model, including streaming tools and their follow-up',async t=>{
  let calls=0;
  const gateway=await createClaudeGateway({defaultKey:body.model,store:store(),fetchImpl:async(url,options)=>{
    assert.equal(url,'https://fixture.invalid/v1/chat/completions');assert.equal(options.headers.Authorization,'Bearer upstream-secret');
    const request=JSON.parse(options.body);assert.equal(request.model,'custom-model');calls++;
    if(calls===1){assert.equal(request.tools[0].function.name,'Read');return sse([chunk({tool_calls:[{index:0,id:'call_read',function:{name:'Read',arguments:'{"file_path":"test"}'}}]},'tool_calls')]);}
    assert.ok(request.messages.some(row=>row.role==='tool'&&row.tool_call_id==='call_read'));return sse([chunk({content:'Done'},'stop')]);
  }});t.after(()=>gateway.close());
  const events=await collect(await message(gateway,{...body,tools:[{name:'Read',input_schema:{type:'object',properties:{file_path:{type:'string'}}}}]}));
  assert.equal(events[0].type,'message_start');assert.equal(events.at(-1).type,'message_stop');
  const use=events.find(event=>event.content_block?.type==='tool_use').content_block;assert.equal(use.id,'call_read');
  const next=await message(gateway,{...body,stream:false,messages:[...body.messages,{role:'assistant',content:[{...use,input:{file_path:'test'}}]},{role:'user',content:[{type:'tool_result',tool_use_id:use.id,content:'file content'}]}],tools:[{name:'Read',input_schema:{type:'object'}}]});
  const final=await next.json();assert.equal(final.content[0].text,'Done');assert.equal(final.stop_reason,'end_turn');
});
test('Claude can use a Responses-only provider from the same catalog',async t=>{
  const gateway=await createClaudeGateway({defaultKey:body.model,store:store('responses'),fetchImpl:async(url,options)=>{
    assert.equal(url,'https://fixture.invalid/v1/responses');assert.equal(JSON.parse(options.body).model,'custom-model');
    const item={id:'m1',type:'message',role:'assistant',content:[{type:'output_text',text:'Responses works'}]};
    return sse([{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response:{status:'completed',output:[item],usage:{input_tokens:4,output_tokens:3}}}]);
  }});t.after(()=>gateway.close());
  const value=await(await message(gateway,{...body,stream:false})).json();assert.equal(value.content[0].text,'Responses works');assert.equal(value.usage.input_tokens,4);
});
test('native Anthropic connections preserve Claude wire fields and credentials',async t=>{
  const gateway=await createClaudeGateway({defaultKey:body.model,store:store('anthropic'),fetchImpl:async(url,options)=>{
    assert.equal(url,'https://fixture.invalid/v1/messages');assert.equal(options.headers['x-api-key'],'upstream-secret');assert.equal(JSON.parse(options.body).model,'custom-model');
    assert.equal(JSON.parse(options.body).thinking.type,'enabled');return new Response(JSON.stringify({type:'message',content:[{type:'text',text:'Native'}],stop_reason:'end_turn'}),{headers:{'content-type':'application/json'}});
  }});t.after(()=>gateway.close());
  assert.equal((await(await message(gateway,{...body,stream:false,thinking:{type:'enabled',budget_tokens:1000}})).json()).content[0].text,'Native');
});
test('Open Codex can use a migrated Anthropic provider',async t=>{
  const adapter=await createAdapter({resolveModel:store('anthropic').resolveModel,listModels:()=>[],fetchImpl:async(url,options)=>{
    const request=JSON.parse(options.body);assert.equal(request.model,'custom-model');assert.equal(request.tools[0].name,'shell');
    return sse([{type:'message_start',message:{usage:{input_tokens:5}}},{type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'Native Anthropic works'}},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:3}},{type:'message_stop'}]);
  }});t.after(()=>adapter.close());
  const response=await fetch(`${adapter.baseUrl}/responses`,{method:'POST',headers:{Authorization:`Bearer ${adapter.token}`,'Content-Type':'application/json'},body:JSON.stringify({model:body.model,input:'Hello',tools:[{type:'function',name:'shell',parameters:{type:'object'}}],stream:true})});
  const events=await collect(response);assert.equal(events.at(-1).type,'response.completed');assert.equal(events.at(-1).response.output[0].content[0].text,'Native Anthropic works');
});
test('unknown models, unauthorized clients, and failed streams cannot claim success',async t=>{
  const gateway=await createClaudeGateway({defaultKey:body.model,store:store(),fetchImpl:async()=>sse([chunk({content:'partial'})])});t.after(()=>gateway.close());
  assert.equal((await fetch(`${gateway.baseUrl}/v1/models`)).status,401);
  assert.equal((await message(gateway,{...body,model:'unconfigured'})).status,400);
  const events=await collect(await message(gateway,body));assert.equal(events.at(-1).type,'error');assert.ok(!events.some(row=>row.type==='message_stop'));
});
