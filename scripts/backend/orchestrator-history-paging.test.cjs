const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const os=require('os');
const path=require('path');
const {createConversationReader}=require('../../backend/conversationReader.cjs');
function setup(t, records) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'history-page-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const file=path.join(root,'chat.jsonl');fs.writeFileSync(file,records.map(JSON.stringify).join('\n'));
 const reader=createConversationReader();const source={file,binding:'provider/home/cwd/native-id',decode:rows=>rows.filter(r=>['user','assistant'].includes(r.role)&&typeof r.text==='string')};
 return {reader,source,file};
}
test('successive older pages reconstruct every Unicode character and oversized message',t=>{
 const originals=[{role:'user',text:'early 😀 question'},{role:'assistant',text:'Ω😀middle'.repeat(5000)},{role:'user',text:'last question'}];
 const {reader,source}=setup(t,originals);let cursor;const pages=[];
 do {const p=reader.read({reference:'a',cursor,maxChars:503},source);assert.ok(p.messages.reduce((n,m)=>n+m.text.length,0)<=503);assert.equal(p.direction,'older');pages.unshift(p);cursor=p.nextCursor;}while(cursor);
 assert.equal(pages.flatMap(p=>p.messages).map(m=>m.text).join(''),originals.map(m=>m.text).join(''));
 for(const p of pages)for(const m of p.messages)assert.equal(m.text.includes('\uFFFD'),false);
});
test('local search reaches earliest prose in file beyond2MB and scan pagination reaches latest',t=>{
 const records=[{role:'user',text:'EARLIEST needle'}];for(let i=0;i<500;i++)records.push({role:'tool',text:'needle'+ 'x'.repeat(6000)});records.push({role:'assistant',text:'latest needle'});
 const {reader,source}=setup(t,records);let p=reader.search({reference:'a',query:'needle'},source);
 assert.equal(p.matches.length,1);assert.match(p.matches[0].snippet,/EARLIEST/);assert.equal(p.coverage.complete,false);assert.ok(p.nextCursor);
 assert.match(reader.read({reference:'a',cursor:p.matches[0].readCursor},source).messages[0].text,/EARLIEST/);
 p=reader.search({reference:'a',query:'needle',cursor:p.nextCursor},source);assert.equal(p.coverage.complete,true);assert.equal(p.matches.length,1);assert.match(p.matches[0].snippet,/latest/);
 const nohit=reader.search({reference:'a',query:'not present'},source);assert.equal(nohit.matches.length,0);assert.equal(nohit.coverage.complete,false);
});
test('forged, mismatched, rewritten and grown snapshot cursors fail closed',t=>{
 const {reader,source,file}=setup(t,[{role:'user',text:'needle'.repeat(100)}]);const p=reader.read({reference:'a',maxChars:10},source);
 for(const input of [{reference:'a',cursor:'forged'},{reference:'b',cursor:p.nextCursor}])assert.throws(()=>reader.read(input,source),/cursor/);
 assert.throws(()=>reader.read({reference:'a',cursor:p.nextCursor},{...source,binding:'other-home'}),/cursor/);
 const s=reader.search({reference:'a',query:'needle',limit:1},source);assert.throws(()=>reader.search({reference:'a',query:'other',cursor:s.matches[0].readCursor},source),/cursor/);
 fs.appendFileSync(file,'\n');assert.throws(()=>reader.read({reference:'a',cursor:p.nextCursor},source),/cursor/);
 const fresh=reader.read({reference:'a',maxChars:10},source);fs.writeFileSync(file,JSON.stringify({role:'user',text:'rewritten'.repeat(100)}));assert.throws(()=>reader.read({reference:'a',cursor:fresh.nextCursor},source),/cursor/);
});
test('search limit resumes inside record and queries are literal, without regex evaluation',t=>{
 const reader=createConversationReader();const source={binding:'export',messages:[{role:'user',text:'a.* 😀'},{role:'assistant',text:'a.* second'}]};
 const p=reader.search({reference:'a',query:'a.*',limit:1},source);assert.equal(p.matches.length,1);assert.equal(p.coverage.complete,false);
 assert.throws(()=>reader.search({reference:'a',query:'changed',cursor:p.nextCursor},source),/cursor/);
 const second=reader.search({reference:'a',query:'a.*',cursor:p.nextCursor},source);assert.equal(second.coverage.complete,true);assert.equal(second.matches.length,1);
 assert.equal(reader.search({reference:'a',query:'a.+'},source).matches.length,0);
});
test('oversized JSON and JSONL records fail explicitly instead of silently losing access',t=>{
 const {reader,source,file}=setup(t,[{role:'user',text:'x'.repeat(8*1024*1024)}]);assert.throws(()=>reader.read({reference:'a'},source),/8 MB/);
 const json=file.replace('.jsonl','.json');fs.copyFileSync(file,json);assert.throws(()=>reader.read({reference:'a'},{...source,file:json}),/8 MB/);
});
test('escaped byte budgets preserve all fragments without dropping text',t=>{
 const original='\u0000"\\😀Ω'.repeat(200);const {reader,source}=setup(t,[{role:'assistant',text:original}]);let cursor;const texts=[];
 do{const p=reader.read({reference:'a',cursor,maxChars:500,maxBytes:37},source);assert.ok(p.messages.reduce((n,m)=>n+Buffer.byteLength(JSON.stringify(m.text))-2,0)<=37);texts.unshift(p.messages.map(m=>m.text).join(''));cursor=p.nextCursor;}while(cursor);
 assert.equal(texts.join(''),original);
 const search=reader.search({reference:'a',query:'Ω',maxBytes:20},source);assert.ok(search.matches.reduce((n,m)=>n+Buffer.byteLength(JSON.stringify(m.snippet))-2,0)<=20);
});
test('leading and trailing empty lines cannot trap continuation paging',t=>{
 const {reader,source,file}=setup(t,[]);fs.writeFileSync(file,'\n\n'+JSON.stringify({role:'user',text:'hello'})+'\n\n');
 const p=reader.read({reference:'a'},source);assert.equal(p.messages[0].text,'hello');assert.equal(p.hasMore,false);
 fs.writeFileSync(file,'\n');assert.equal(reader.read({reference:'a'},source).hasMore,false);
});
test('service search scans only root human prose and forwards stable read cursors',async t=>{
 const {createOrchestratorHistory}=require('../../backend/orchestratorHistory.cjs');const {qwenChatsDir}=require('../../backend/agentThreadHost.cjs');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'history-service-page-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const cwd=path.join(root,'project');fs.mkdirSync(cwd);const qwen=path.join(root,'qwen');const dir=qwenChatsDir(cwd,qwen);fs.mkdirSync(dir,{recursive:true});
 fs.writeFileSync(path.join(dir,'root.jsonl'),[
 {role:'user',content:'visible needle'},
 {role:'assistant',content:[{type:'tool_result',text:'hidden needle'},{type:'thinking',text:'hidden needle'},{type:'text',synthetic:true,text:'hidden needle'}]},
 {role:'user',parent_thread_id:'other',content:'child needle'}
 ].map(JSON.stringify).join('\n'));
 const service=createOrchestratorHistory({homes:{qwen},getKnownScopes:()=>[{provider:'qwen',cwd}],lookupThreads:async()=>({status:'found',threads:[{id:'root'}]})});const reference=(await service.list()).conversations[0].reference;
 const s=await service.search({reference,query:'needle'});assert.equal(s.matches.length,1);assert.equal(s.coverage.complete,true);assert.equal(s.matches[0].snippet,'visible needle');assert.equal((await service.read({reference,cursor:s.matches[0].readCursor})).text,'user: visible needle');
});
