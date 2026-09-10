'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {createOrchestrator}=require('../../backend/orchestrator.cjs');
const tool=args=>({choices:[{message:{tool_calls:[{id:'file-read',type:'function',function:{name:'workspace',arguments:JSON.stringify(args)}}]}}]});
const reply={choices:[{message:{content:'Read the requested file page.'}}]};
const metadata=body=>JSON.parse(body.messages.find(message=>message.role==='user').content);
async function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'vibe-file-navigation-')),steps=[],file=path.join(root,'source.txt');fs.writeFileSync(file,'x'.repeat(20000));
  const relay=createOrchestrator({userDataPath:root,getRoots:()=>({projects:[root]}),interpretIntent:()=>({goal:'Read the requested source.',access:'read-only',actions:[]}),
    fetch:async(url,options)=>{if(url.endsWith('/key'))return Response.json({data:{}});if(url.endsWith('/models'))return Response.json({data:[{id:'fixture',context_length:128000,supported_parameters:['tools']}]});const next=steps.shift();assert(next,'Every model round is scripted');return Response.json(typeof next==='function'?next(JSON.parse(options.body)):next);}});
  t.after(async()=>{await relay.dispose();assert.equal(path.dirname(root),os.tmpdir());fs.rmSync(root,{recursive:true,force:true});});
  await relay.configure({apiKey:'fixture',model:'fixture',sessionOnly:true});await relay.setEnabled(true);return {relay,steps,file};}
test('file cursors and committed bookmarks continue beyond directory paging limits',async t=>{
  const f=await fixture(t);let reference,cursor;
  for(let page=0;page<4;page++){
    f.steps.push(body=>{if(page){const bookmark=metadata(body).readBookmarks.find(item=>item.kind==='read_file');assert.equal(bookmark.path,f.file);assert.equal(bookmark.cursor,cursor);}
      return tool({kind:'read_file',path:f.file,...(cursor&&{cursor,reference})});},body=>{const result=JSON.parse(body.messages.filter(message=>message.role==='tool').at(-1).content);assert.equal(result.text.length,4000);assert.equal(result.nextCursor,String((page+1)*4000));reference=result.reference;cursor=result.nextCursor;return reply;});
    const result=await f.relay.send({text:`Continue reading ${f.file}.`,origin:'text'});assert.equal(result.ok,true,JSON.stringify(result));
  }
  assert.equal(cursor,'16000');
});
test('a stale file reference recovers only after reading that same source successfully',async t=>{
  const f=await fixture(t);
  f.steps.push(tool({kind:'read_file',path:f.file,cursor:'0',reference:'stale'}),tool({kind:'read_file',path:f.file}),reply);
  const result=await f.relay.send({text:`Read ${f.file}.`,origin:'text'});
  assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.actions[0].status,'unavailable');
});
