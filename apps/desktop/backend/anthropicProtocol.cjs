'use strict';
const { randomUUID } = require('node:crypto');
const OPAQUE = 'lina_responses_v1:';
function failure(message) { return Object.assign(new Error(message),{status:400}); }
function textContent(content) {
  if(typeof content==='string') return content;
  return (content||[]).map(part=>{if(part.type!=='text')throw failure(`The configured API cannot represent ${part.type} in this text field.`);return part.text||'';}).join('\n');
}
function toResponses(body) {
  const input=[];
  for(const message of body.messages||[]) {
    let content=[];
    const flush=()=>{if(content.length){input.push({role:message.role,content});content=[];}};
    for(const part of typeof message.content==='string'?[{type:'text',text:message.content}]:message.content||[]) {
      if(part.type==='text') content.push({type:message.role==='assistant'?'output_text':'input_text',text:part.text||''});
      else if(part.type==='image') {
        const url=part.source?.type==='base64'?`data:${part.source.media_type};base64,${part.source.data}`:part.source?.url;
        if(!url)throw failure('The provider bridge cannot represent this image.');content.push({type:'input_image',image_url:url});
      } else if(part.type==='tool_use') {flush();input.push({type:'function_call',call_id:part.id,name:part.name,arguments:JSON.stringify(part.input||{})});}
      else if(part.type==='tool_result') {flush();input.push({type:'function_call_output',call_id:part.tool_use_id,output:(part.is_error?'Tool error: ':'')+textContent(part.content)});}
      else if(part.type==='thinking') {
        flush();
        if(part.signature?.startsWith(OPAQUE)) {
          try{input.push(JSON.parse(Buffer.from(part.signature.slice(OPAQUE.length),'base64url').toString()));}catch{throw failure('Saved model reasoning could not be decoded.');}
        }
      } else if(part.type!=='redacted_thinking') throw failure(`The configured API cannot represent Claude content type ${part.type}.`);
    }
    flush();
  }
  const request={model:body.model,instructions:textContent(body.system),input,stream:true,store:false,
    tools:(body.tools||[]).map(tool=>{
      if(!tool.input_schema)throw failure(`The configured API cannot represent hosted tool ${tool.name}.`);
      return {type:'function',name:tool.name,description:tool.description||'',parameters:tool.input_schema};
    })};
  if(body.max_tokens)request.max_output_tokens=body.max_tokens;
  if(body.temperature!=null)request.temperature=body.temperature;
  if(body.top_p!=null)request.top_p=body.top_p;
  if(body.output_config?.effort)request.reasoning={effort:body.output_config.effort};
  if(body.output_config?.format?.type==='json_schema') request.text={format:{...body.output_config.format,name:'result'}};
  if(body.tool_choice) request.tool_choice=body.tool_choice.type==='tool'?{type:'function',name:body.tool_choice.name}:body.tool_choice.type==='any'?'required':body.tool_choice.type;
  return request;
}
function chatToAnthropic(body) {
  const messages=[],system=[];
  for(const message of body.messages||[]) {
    if(['system','developer'].includes(message.role)){system.push(textContent(message.content));continue;}
    if(message.role==='tool') {
      const block={type:'tool_result',tool_use_id:message.tool_call_id,content:message.content||''};
      if(messages.at(-1)?.role==='user')messages.at(-1).content.push(block);else messages.push({role:'user',content:[block]});continue;
    }
    const content=[];
    for(const detail of message.reasoning_details||[]) if(detail.type==='lina_anthropic' && detail.signature) content.push({type:'thinking',thinking:detail.text||'',signature:detail.signature});
    for(const part of typeof message.content==='string'?[{type:'text',text:message.content}]:message.content||[]) {
      if(part.type==='text') {if(part.text)content.push({type:'text',text:part.text});}
      else if(part.type==='image_url') {
        const match=/^data:([^;]+);base64,([\s\S]+)$/.exec(part.image_url.url);
        content.push({type:'image',source:match?{type:'base64',media_type:match[1],data:match[2]}:{type:'url',url:part.image_url.url}});
      }else throw failure(`Unsupported image/message content: ${part.type}.`);
    }
    for(const call of message.tool_calls||[]) content.push({type:'tool_use',id:call.id,name:call.function.name,input:JSON.parse(call.function.arguments||'{}')});
    if(content.length)messages.push({role:message.role,content});
  }
  const request={model:body.model,messages,max_tokens:body.max_tokens||8192,stream:true,system:system.join('\n\n'),
    tools:(body.tools||[]).map(tool=>({name:tool.function.name,description:tool.function.description,input_schema:tool.function.parameters}))};
  if(body.tool_choice)request.tool_choice=typeof body.tool_choice==='object'?{type:'tool',name:body.tool_choice.function.name}:{type:body.tool_choice==='required'?'any':body.tool_choice};
  return request;
}
function anthropicUrl(base, resource='messages') { return `${base}${base.endsWith('/v1')?'':'/v1'}/${resource}`; }
async function fetchAnthropicAsChat(chat,route,options,fetchImpl) {
  const upstream=await fetchImpl(anthropicUrl(route.baseUrl),{...options,headers:{'Content-Type':'application/json','anthropic-version':'2023-06-01',...(route.apiKey?{'x-api-key':route.apiKey,Authorization:`Bearer ${route.apiKey}`}:{})},body:JSON.stringify(chatToAnthropic(chat))});
  if(!upstream.ok)return upstream;
  async function* chunks() {
    const {sseData}=require('./openCodexAdapter.cjs');
    let stopReason,usage={},sawStop=false;
    for await(const raw of sseData(upstream.body)) {
      const event=JSON.parse(raw);
      if(event.type==='error')throw new Error('Provider stream failed.');
      let delta;
      if(event.type==='message_start')usage=event.message.usage||{};
      if(event.type==='content_block_start' && event.content_block.type==='tool_use')delta={tool_calls:[{index:event.index,id:event.content_block.id,type:'function',function:{name:event.content_block.name,arguments:''}}]};
      if(event.type==='content_block_delta') {
        const change=event.delta;
        if(change.type==='text_delta')delta={content:change.text};
        if(change.type==='input_json_delta')delta={tool_calls:[{index:event.index,function:{arguments:change.partial_json}}]};
        if(change.type==='thinking_delta')delta={reasoning_content:change.thinking,reasoning_details:[{index:event.index,type:'lina_anthropic',text:change.thinking}]};
        if(change.type==='signature_delta')delta={reasoning_details:[{index:event.index,type:'lina_anthropic',signature:change.signature}]};
      }
      if(delta)yield {choices:[{index:0,delta,finish_reason:null}]};
      if(event.type==='message_delta'){stopReason=event.delta?.stop_reason;usage={...usage,...event.usage};}
      if(event.type==='message_stop') {
        sawStop=true;
        const input=(usage.input_tokens||0)+(usage.cache_read_input_tokens||0)+(usage.cache_creation_input_tokens||0);
        yield {choices:[{index:0,delta:{},finish_reason:stopReason==='tool_use'?'tool_calls':stopReason==='max_tokens'?'length':'stop'}],usage:{prompt_tokens:input,completion_tokens:usage.output_tokens||0,total_tokens:input+(usage.output_tokens||0),prompt_tokens_details:{cached_tokens:usage.cache_read_input_tokens||0}}};
      }
    }
    if(!sawStop)throw new Error('Provider stream ended before message_stop.');
  }
  const iterator=chunks()[Symbol.asyncIterator](),encoder=new TextEncoder();
  return new Response(new ReadableStream({async pull(controller){try{const next=await iterator.next();if(next.done)controller.close();else controller.enqueue(encoder.encode(`data: ${JSON.stringify(next.value)}\n\n`));}catch(error){controller.error(error);}},async cancel(){await iterator.return?.();}}),{headers:{'Content-Type':'text/event-stream'}});
}
async function responsesToMessage(upstream,response,model,stream=true) {
  const {sseData}=require('./openCodexAdapter.cjs');
  const id=`msg_${randomUUID().replace(/-/g,'')}`,blocks=new Map(),output=[],usage={input_tokens:0,output_tokens:0};let finished=false;
  const message={id,type:'message',role:'assistant',model,content:output,stop_reason:null,stop_sequence:null,usage};
  async function write(value) {
    if(response.destroyed)throw new Error('Claude client disconnected.');
    if(!response.write(value))await new Promise((resolve,reject)=>{const done=()=>{cleanup();resolve();},close=()=>{cleanup();reject(new Error('Claude client disconnected.'));},cleanup=()=>{response.off('drain',done);response.off('close',close);};response.once('drain',done);response.once('close',close);});
  }
  const emit=async(type,value={})=>{if(stream)await write(`event: ${type}\ndata: ${JSON.stringify({type,...value})}\n\n`);};
  if(stream){response.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'});await emit('message_start',{message});}
  async function add(key,block) {
    const index=output.length;output.push(block);blocks.set(key,index);await emit('content_block_start',{index,content_block:block});return index;
  }
  for await(const raw of sseData(upstream.body)) {
    const event=JSON.parse(raw);
    if(event.type==='response.output_text.delta') {
      let index=blocks.get(event.item_id);if(index===undefined)index=await add(event.item_id,{type:'text',text:''});
      output[index].text+=event.delta;await emit('content_block_delta',{index,delta:{type:'text_delta',text:event.delta}});
    }
    if(event.type==='response.output_item.done') {
      const item=event.item;
      if(item.type==='function_call') {
        const index=await add(item.id,{type:'tool_use',id:item.call_id,name:item.name,input:{}});
        const args=JSON.parse(item.arguments||'{}');output[index].input=args;
        await emit('content_block_delta',{index,delta:{type:'input_json_delta',partial_json:JSON.stringify(args)}});
      }else if(item.type==='reasoning' && item.encrypted_content) {
        const index=await add(item.id,{type:'thinking',thinking:'',signature:''});
        const thinking=(item.summary||[]).map(part=>part.text||'').join('\n'),signature=OPAQUE+Buffer.from(JSON.stringify(item)).toString('base64url');
        output[index].thinking=thinking;output[index].signature=signature;
        if(thinking)await emit('content_block_delta',{index,delta:{type:'thinking_delta',thinking}});
        await emit('content_block_delta',{index,delta:{type:'signature_delta',signature}});
      }else if(item.type==='message' && !blocks.has(item.id)) {
        const text=(item.content||[]).map(part=>part.text||part.refusal||'').join('');
        if(text){const index=await add(item.id,{type:'text',text:''});output[index].text=text;await emit('content_block_delta',{index,delta:{type:'text_delta',text}});}
      }
      const index=blocks.get(item.id);if(index!==undefined)await emit('content_block_stop',{index});
    }
    if(event.type==='response.failed' || event.type==='error')throw new Error('The configured model failed to complete the response.');
    if(['response.completed','response.incomplete'].includes(event.type)) {
      const result=event.response;if(result.status==='failed')throw new Error('The configured model failed.');finished=true;
      usage.input_tokens=result.usage?.input_tokens||0;usage.output_tokens=result.usage?.output_tokens||0;
      message.stop_reason=result.status==='incomplete'?'max_tokens':output.some(block=>block.type==='tool_use')?'tool_use':'end_turn';
      await emit('message_delta',{delta:{stop_reason:message.stop_reason,stop_sequence:null},usage});await emit('message_stop');
    }
  }
  if(!finished)throw new Error('The configured model stream ended before completion.');
  if(!stream){response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify(message));}else response.end();
}
module.exports={toResponses,chatToAnthropic,anthropicUrl,fetchAnthropicAsChat,responsesToMessage};
