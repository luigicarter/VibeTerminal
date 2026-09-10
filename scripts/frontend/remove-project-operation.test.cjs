'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),ts=require('typescript');
const filename=path.resolve(__dirname,'../../frontend/removeProjectOperation.ts'),loaded=new Module(filename,module);loaded.filename=filename;
loaded._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,filename);
const {removeProjectOperation}=loaded.exports;
const {createProjectRemovalController}=loaded.exports;
function fixture(){let project={id:'p',path:'C:/Folder',sessions:[{id:'a',launchToken:1},{id:'b',launchToken:1}]};const snapshot={id:'p',path:'C:/Folder',targets:structuredClone(project.sessions)},closed=[];
  const options={snapshot,current:()=>project,close:async target=>{closed.push(target.id);project.sessions=project.sessions.filter(s=>s.id!==target.id);return {ok:true};},remove:()=>{project=undefined;}};
  return {options,closed,get:()=>project,set:p=>{project=p;},run:()=>removeProjectOperation(options)};}
test('project is removed only after its panes stop, with files explicitly preserved',async()=>{const f=fixture();const result=await f.run();assert.equal(result.ok,true);assert.equal(result.filesDeleted,false);assert.equal(result.status,'project-removed');assert.deepEqual(f.closed,['a','b']);assert.equal(f.get(),undefined);});
test('a new terminal during removal preserves the project and that terminal',async()=>{const f=fixture(),close=f.options.close;f.options.close=async target=>{const result=await close(target);f.get().sessions.push({id:'new',launchToken:1});return result;};const result=await f.run();assert.equal(result.ok,false);assert.equal(result.filesDeleted,false);assert.deepEqual(f.closed,['a']);assert.ok(f.get().sessions.some(s=>s.id==='new'));});
test('an unverified stop leaves the project present',async()=>{const f=fixture();f.options.close=async()=>({ok:false,error:'Unconfirmed process stop.'});const result=await f.run();assert.equal(result.ok,false);assert.match(result.error,/Unconfirmed/);assert.ok(f.get());});
test('replacement projects and restarted panes cannot be removed by stale snapshots',async()=>{for(const change of [p=>{p.path='C:/Other';},p=>{p.sessions[0].launchToken=2;}]){const f=fixture();change(f.get());assert.equal((await f.run()).ok,false);assert.deepEqual(f.closed,[]);assert.ok(f.get());}});
test('uncommitted project-state removal is not reported as success',async()=>{const f=fixture();f.options.remove=()=>{};assert.equal((await f.run()).ok,false);assert.ok(f.get());});
test('retry observes the original uncertain stop even when its pane already disappeared',async()=>{
  const f=fixture(),controller=createProjectRemovalController(),calls=[];let confirmed=false;
  const options={...f.options,close:async(target,operationId,observeOnly)=>{calls.push({id:target.id,operationId,observeOnly});f.get().sessions=f.get().sessions.filter(s=>s.id!==target.id);return {ok:confirmed,error:confirmed?undefined:'Stop unconfirmed.'};}};
  assert.equal((await controller.run(options)).ok,false);assert.equal(f.get().sessions.length,1);
  confirmed=true;
  const result=await controller.run({...options,snapshot:{...options.snapshot,targets:structuredClone(f.get().sessions)}});
  assert.equal(result.ok,true);assert.equal(result.filesDeleted,false);
  assert.equal(calls[0].id,'a');assert.equal(calls[1].id,'a');assert.equal(calls[0].operationId,calls[1].operationId);
  assert.equal(calls[0].observeOnly,false);assert.equal(calls[1].observeOnly,true);assert.equal(calls[2].id,'b');
});
