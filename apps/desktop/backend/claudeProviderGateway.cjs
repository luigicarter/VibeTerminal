'use strict';
const http=require('node:http'),crypto=require('node:crypto');
const {once}=require('node:events');
const {createAdapter}=require('./openCodexAdapter.cjs');
const {toResponses,responsesToMessage,anthropicUrl}=require('./anthropicProtocol.cjs');
const providers=require('./modelProviders.cjs');
async function writeOutput(response,chunk) {
  if(response.destroyed)throw new Error('Client disconnected.');
  if(response.write(chunk))return;
  await new Promise((resolve,reject)=>{
    const cleanup=()=>{response.off('drain',done);response.off('close',closed);};
    const done=()=>{cleanup();resolve();},closed=()=>{cleanup();reject(new Error('Client disconnected.'));};
    response.once('drain',done);response.once('close',closed);
  });
}
async function createClaudeGateway({defaultKey,store=providers,fetchImpl=fetch}) {
  const token=crypto.randomBytes(32).toString('base64url'),active=new Set();
  const resolveModel=model=>{
    const current=store.listProfiles();
    const exact=current.models.find(row=>row.key===model);
    if(exact)return store.resolveModel(exact.key);
    const initial=current.models.find(row=>row.key===defaultKey);
    const candidate=current.models.find(row=>row.providerId===(initial?.providerId || defaultKey.split('/')[0]) && row.id===model);
    if(candidate)return store.resolveModel(candidate.key);
    throw Object.assign(new Error('Choose a model from the shared provider settings.'),{status:400});
  };
  const adapter=await createAdapter({resolveModel,listModels:()=>store.listProfiles().models,fetchImpl});
  const server=http.createServer(async(request,response)=>{
    const auth=String(request.headers.authorization||'').replace(/^Bearer /,'' ) || request.headers['x-api-key'] || '';
    const supplied=Buffer.from(auth),expected=Buffer.from(token);
    if(request.headers.origin||supplied.length!==expected.length||!crypto.timingSafeEqual(supplied,expected)){response.writeHead(401);response.end();return;}
    const controller=new AbortController();active.add(controller);response.once('close',()=>controller.abort());
    const timeout=setTimeout(()=>controller.abort(),600000);timeout.unref?.();
    const json=(status,value)=>{response.writeHead(status,{'Content-Type':'application/json'});response.end(JSON.stringify(value));};
    try{
      const pathname=new URL(request.url,'http://localhost').pathname;
      if(request.method==='GET'&&pathname==='/v1/models')return json(200,{data:store.listProfiles().models.map(row=>({id:row.key,type:'model',display_name:`${row.label} · ${row.providerName}`,created_at:'1970-01-01T00:00:00Z'})),has_more:false});
      if(request.method!=='POST'||!['/v1/messages','/v1/messages/count_tokens'].includes(pathname))return json(404,{type:'error',error:{type:'not_found_error',message:'Unknown provider route.'}});
      const chunks=[];let size=0;for await(const chunk of request){size+=chunk.length;if(size>32*1024*1024)throw Object.assign(new Error('Request is too large.'),{status:413});chunks.push(chunk);}
      const body=JSON.parse(Buffer.concat(chunks).toString());
      const route=resolveModel(body.model);
      if(pathname.endsWith('/count_tokens')&&route.apiMode!=='anthropic') { response.setHeader('X-Lina-Token-Count','estimate');return json(200,{input_tokens:Math.ceil(Buffer.byteLength(JSON.stringify({messages:body.messages,system:body.system,tools:body.tools}),'utf8')/3)}); }
      if(route.apiMode==='anthropic'){
        const upstream=await fetchImpl(anthropicUrl(route.baseUrl,pathname.endsWith('/count_tokens')?'messages/count_tokens':'messages'),{method:'POST',redirect:'error',signal:controller.signal,headers:{'Content-Type':'application/json','anthropic-version':request.headers['anthropic-version']||'2023-06-01',...(request.headers['anthropic-beta']?{'anthropic-beta':request.headers['anthropic-beta']}:{}),...(route.apiKey?{'x-api-key':route.apiKey,Authorization:`Bearer ${route.apiKey}`}:{})},body:JSON.stringify({...body,model:route.id})});
        if(!upstream.ok){await upstream.body?.cancel();throw Object.assign(new Error(`Provider returned HTTP ${upstream.status}.`),{status:upstream.status});}
        response.writeHead(200,{'Content-Type':upstream.headers.get('content-type')||'application/json'});
        let size=0;for await(const chunk of upstream.body){size+=chunk.byteLength;if(size>32*1024*1024)throw new Error('Provider response is too large.');await writeOutput(response,chunk);}response.end();return;
      }
      const upstream=await fetch(`${adapter.baseUrl}/responses`,{method:'POST',headers:{Authorization:`Bearer ${adapter.token}`,'Content-Type':'application/json'},signal:controller.signal,body:JSON.stringify(toResponses(body))});
      if(!upstream.ok){await upstream.body?.cancel();throw Object.assign(new Error(`Provider returned HTTP ${upstream.status}. Check its settings.`),{status:upstream.status});}
      await responsesToMessage(upstream,response,body.model,body.stream!==false);
    }catch(error){
      const message=error.status?error.message:'The configured model request failed. Check the provider settings.';
      if(!response.destroyed&&!response.headersSent)json(error.status||502,{type:'error',error:{type:'api_error',message}});
      else if(!response.destroyed){response.end(`event: error\ndata: ${JSON.stringify({type:'error',error:{type:'api_error',message}})}\n\n`);}
    }finally{clearTimeout(timeout);active.delete(controller);}
  });
  server.listen(0,'127.0.0.1');try{await once(server,'listening');}catch(error){await adapter.close();throw error;}
  return {baseUrl:`http://127.0.0.1:${server.address().port}`,token,async close(){for(const controller of active)controller.abort();server.closeAllConnections();await Promise.all([adapter.close(),new Promise(resolve=>server.close(resolve))]);}};
}
function createGatewayManager({store=providers}={}) {
  const gateways=new Map();
  return {
    async environment(profileId,modelOverride){
      const route=store.getProfileConnection(profileId,modelOverride);if(!route)return null;
      let pending=gateways.get(route.profileId);
      if(!pending){pending=createClaudeGateway({defaultKey:route.key,store}).catch(error=>{gateways.delete(route.profileId);throw error;});gateways.set(route.profileId,pending);}
      const gateway=await pending;
      const small=route.smallFastModel?store.modelKey(route.profileId,route.smallFastModel):route.key;
      return {ANTHROPIC_BASE_URL:gateway.baseUrl,ANTHROPIC_AUTH_TOKEN:gateway.token,ANTHROPIC_MODEL:route.key,
        ANTHROPIC_SMALL_FAST_MODEL:small,ANTHROPIC_DEFAULT_HAIKU_MODEL:small,ANTHROPIC_DEFAULT_SONNET_MODEL:route.key,ANTHROPIC_DEFAULT_OPUS_MODEL:route.key,
        ANTHROPIC_CUSTOM_MODEL_OPTION:route.key,ANTHROPIC_CUSTOM_MODEL_OPTION_NAME:`${route.label} · ${route.name}`,
        ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION:'Model configured in Lina Terminal',
        CLAUDE_CODE_MAX_CONTEXT_TOKENS:String(route.contextWindow),CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY:'1',
        ...(route.reasoning?{ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES:'effort'}:{}),DISABLE_PROMPT_CACHING:'1'};
    },
    async close(){const pending=[...gateways.values()];gateways.clear();await Promise.allSettled(pending.map(async item=>(await item).close()));}
  };
}
module.exports={createClaudeGateway,createGatewayManager};
