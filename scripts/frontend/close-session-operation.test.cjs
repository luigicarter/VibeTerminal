'use strict';
const assert=require('node:assert/strict'),test=require('node:test'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),ts=require('typescript');
const filename=path.resolve(__dirname,'../../frontend/closeSessionOperation.ts');
const loaded=new Module(filename,module); loaded.filename=filename;loaded._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,filename);
const {closeSessionOperation}=loaded.exports;
const target={id:'pane',launchToken:1,generation:'g'};
const stopped={ok:true,operationId:'operation',process:'stopped',launchSettled:true};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(patch={}) { let current={...target},effects=[];const options={operationId:'operation',target,current:()=>current,cancelLaunch:()=>effects.push('cancel'),stop:async()=>{effects.push('stop');return stopped;},remove:()=>{effects.push('remove');current=undefined;},...patch};return {options,effects,set:value=>{current=value;},run:()=>closeSessionOperation(options)}; }
test('success waits for actual state commitment after stop evidence',async()=>{
  let commit;const f=fixture();f.options.remove=()=>new Promise(resolve=>{commit=()=>{f.set(undefined);resolve();};});
  let done=false;const work=f.run().then(value=>{done=true;return value;});await tick();assert.equal(done,false);assert.deepEqual(f.effects,['cancel','stop']);commit();
  const result=await work;assert.equal(result.ok,true);assert.equal(result.close.pane,'removed');
});
test('scheduled but uncommitted state is not success',async()=>{const f=fixture({remove:()=>{}});const result=await f.run();assert.equal(result.ok,false);assert.equal(result.close.pane,'unknown');});
test('restarted pane before stop is untouched',async()=>{const f=fixture();f.set({...target,launchToken:2,generation:'new'});assert.equal((await f.run()).status,'superseded');assert.deepEqual(f.effects,[]);});
test('replacement appearing during observed stop is preserved',async()=>{let settle;const f=fixture({stop:()=>new Promise(resolve=>{settle=resolve;})});const work=f.run();f.set({...target,launchToken:2,generation:'new'});settle(stopped);assert.equal((await work).status,'superseded');assert(!f.effects.includes('remove'));});
test('stop rejection removes pane but preserves unconfirmed process evidence',async()=>{const f=fixture({stop:async()=>{throw Error('host lost');}});const result=await f.run();assert.equal(result.ok,false);assert.equal(result.close.pane,'removed');assert.equal(result.close.process,'unknown');assert.match(result.error,/host lost/);});
test('pending launch fence is required even with process absence',async()=>{const f=fixture({stop:async()=>({...stopped,process:'already-absent',launchSettled:false})});assert.equal((await f.run()).ok,false);});
test('absent pane still verifies process and exact launch cancellation',async()=>{const f=fixture({stop:async()=>({...stopped,process:'already-absent'})});f.set(undefined);const result=await f.run();assert.equal(result.ok,true);assert.equal(result.close.pane,'already-absent');assert.deepEqual(f.effects,['cancel']);});
test('unrelated stop receipt cannot authorize pane removal',async()=>{const f=fixture({stop:async()=>({...stopped,operationId:'other'})});assert.equal((await f.run()).ok,false);assert(!f.effects.includes('remove'));});
test('a rejected stop cannot become success through contradictory process fields',async()=>{const f=fixture({stop:async()=>({...stopped,ok:false})});assert.equal((await f.run()).ok,false);});
test('pending pane may acquire a runtime in its same launch before cancellation',async()=>{const f=fixture({target:{...target,generation:'paused:pane:1'}});assert.equal((await f.run()).ok,true);});
test('unrelated synthetic-looking generation does not bypass runtime replacement fencing',async()=>{const f=fixture({target:{...target,generation:'paused:other:1'}});assert.equal((await f.run()).status,'superseded');assert.deepEqual(f.effects,[]);});
