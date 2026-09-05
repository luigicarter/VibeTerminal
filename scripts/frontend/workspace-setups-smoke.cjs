const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const crypto = require('node:crypto');
const cache = new Map();
function load(file) {
  file = path.resolve(file); if (cache.has(file)) return cache.get(file);
  const exports = {}; cache.set(file,exports);
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,
    {exports,crypto,require: name => name.startsWith('.') ? load(path.resolve(path.dirname(file),`${name}.ts`)) : require(name)});
  return exports;
}
const {createWorkspaceSetup,instantiateWorkspaceSetup,freezeHandoff,handoffTargetIsCurrent} = load(path.join(__dirname,'../../frontend/workspaceSetups.ts'));
const {createWorkspaceSetupStore,sanitizeSetup} = require('../../backend/workspaceSetups.cjs');
const {requireSetupSuccess} = load(path.join(__dirname,'../../frontend/components/WorkspaceSetups.tsx'));
const {exactRecentOutput} = load(path.join(__dirname,'../../frontend/components/HandoffPanel.tsx'));
const plain = value => JSON.parse(JSON.stringify(value));
async function main() {
  const a = {id:'live-a',name:'Named planner',kind:'claude',command:'claude',cwd:'C:/repo',fusion:true,fusionPlannerFamily:'codex',fusionPlannerModel:'model-a',fusionPlannerEffort:'high',fusionRunMode:'plan',providerProfileId:'profile-ref',
    layout:{x:0,y:0,w:80,h:500,unit:'fluid',secret:'no'},tileId:'live-a',splitTree:{dir:'row',ratio:.7,a:{id:'live-a'},b:{id:'live-b'}},
    threadRef:{id:'secret-thread'},resumeRef:{id:'old-thread'},generation:'live-generation',launchToken:99,started:true,status:'running',attention:{unread:true},detachedTaskIds:['task'],apiKey:'secret-key'};
  const b = {...a,id:'live-b',kind:'opencode',fusion:undefined,openFusion:true,openFusionPlannerModel:'provider/brain',openFusionExecutorModel:'provider/executor',openFusionRunMode:'plan',splitTree:undefined};
  const recipe = createWorkspaceSetup({name:'Pair',scope:'project',projectPath:'C:/repo',sessions:[a,b],prompts:{'live-a':'Exact starting prompt\n'}});
  const json = JSON.stringify(recipe);
  for (const forbidden of ['live-a','live-b','secret-thread','old-thread','live-generation','secret-key','launchToken','attention','detachedTaskIds','secret']) assert(!json.includes(forbidden),forbidden);
  assert.equal(recipe.panes[0].config.fusionPlannerModel,'model-a'); assert.equal(recipe.panes[0].prompt,'Exact starting prompt\n');
  assert.equal(recipe.panes[1].config.openFusionRunMode,'plan'); assert.deepEqual(plain(recipe.panes[0].path),{kind:'project'});
  const first = instantiateWorkspaceSetup(recipe,{projectPath:'C:/repo'}), second = instantiateWorkspaceSetup(recipe,{projectPath:'C:/repo'});
  assert.notEqual(first.sessions[0].id,second.sessions[0].id);
  for(const output of [first,second]) {
    assert.equal(output.sessions[1].tileId,output.sessions[0].id);
    assert.deepEqual(plain(output.sessions[0].splitTree),{dir:'row',ratio:.7,a:{id:output.sessions[0].id},b:{id:output.sessions[1].id}});
    assert.equal(output.sessions[0].status,'idle');assert.equal(output.sessions[0].launchToken,0);assert.equal(output.sessions[0].started,false);assert.equal(output.sessions[0].threadRef,undefined);
    assert.equal(output.prompts[output.sessions[0].id],'Exact starting prompt\n');
  }
  assert.throws(() => instantiateWorkspaceSetup(recipe,{projectPath:'C:/different'}),/project folder/);
  const old = plain(recipe);old.panes[0].config.kind='aider';old.panes[0].config.command='aider';
  assert.equal(instantiateWorkspaceSetup(old,{projectPath:'C:/repo'}).sessions[0].command,'');
  assert.equal(sanitizeSetup(old).panes[0].config.kind,'terminal');
  assert.equal(sanitizeSetup(old).panes[0].migratedFrom,'aider');
  const migrated = createWorkspaceSetup({name:'Old',scope:'global',sessions:[{...a,kind:'aider',tileId:undefined,splitTree:undefined}]});
  assert.equal(migrated.panes[0].migratedFrom,'aider');assert.equal(migrated.panes[0].config.kind,'terminal');
  const ordinary = createWorkspaceSetup({name:'Shell',scope:'global',sessions:[{...a,kind:'terminal',command:'',tileId:undefined,splitTree:undefined}]});
  assert.equal(ordinary.panes[0].migratedFrom,undefined);assert.equal(sanitizeSetup(ordinary).panes[0].migratedFrom,undefined);
  assert.throws(() => requireSetupSuccess({ok:false,error:'Cannot write setup'}),/Cannot write setup/);
  assert.throws(() => requireSetupSuccess({ok:false}),/operation failed/);
  requireSetupSuccess({ok:true});requireSetupSuccess(recipe);
  const dirty = plain(recipe);dirty.panes[0].config.apiKey='bad';dirty.panes[0].threadRef={id:'bad'};dirty.panes[0].layout.key='bad';
  assert(!JSON.stringify(sanitizeSetup(dirty)).includes('bad'));
  assert.throws(() => sanitizeSetup({...recipe,projectPath:'relative'}),/absolute/);
  assert.throws(() => sanitizeSetup({...recipe,version:2}),/version/);
  const source={id:'source',generation:'generation-1'}, target={id:'target',generation:'generation-2'}, paths=['C:/repo/file.ts'];
  assert.equal(exactRecentOutput({ok:true,observation:{...source,text:'  exact output\r\n'}},source),'  exact output\r\n');
  assert.throws(() => exactRecentOutput({ok:true,observation:{...source,generation:'later',text:'stale'}},source),/source session changed/);
  assert.throws(() => exactRecentOutput({ok:true,observation:{...source,id:'other',text:'wrong'}},source),/source session changed/);
  assert.throws(() => exactRecentOutput({ok:false,error:'Read failed'},source),/Read failed/);
  const draft=freezeHandoff({source,target,paths,selectedText:'  exact\ntext  ',instruction:'Do only this.\n'});
  paths.push('later');source.generation='changed';
  assert.equal(draft.source.generation,'generation-1');assert.equal(draft.paths.length,1);assert.equal(draft.selectedText,'  exact\ntext  ');assert.equal(draft.instruction,'Do only this.\n');assert(Object.isFrozen(draft));assert(Object.isFrozen(draft.paths));
  assert.equal(freezeHandoff({...draft,text:'My exact edited preview\n'}).text,'My exact edited preview\n');
  assert(!handoffTargetIsCurrent(draft,[source,target]));assert(handoffTargetIsCurrent(draft,[{id:'source',generation:'generation-1'},target]));
  assert.throws(() => freezeHandoff({...draft,target:{id:'target',generation:''}}),/Select/);
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'vibe-setup-test-'));
  try {
    const store=createWorkspaceSetupStore({userDataPath:directory});
    await Promise.all([store.save(recipe),store.save({...recipe,id:crypto.randomUUID(),scope:'global',name:'Global'})]);
    assert.equal((await store.list({projectPath:'C:/repo'})).length,2);
    assert.equal((await store.list({projectPath:'C:/other'})).length,1);
    assert.equal((await createWorkspaceSetupStore({userDataPath:directory}).list({projectPath:'C:/repo'})).length,2);
    await store.remove(recipe.id);assert.equal((await store.list({projectPath:'C:/repo'})).length,1);
    await store.save(migrated);await store.save(ordinary);
    const reloaded = await createWorkspaceSetupStore({userDataPath:directory}).list();
    assert.equal(reloaded.find(r => r.id === migrated.id).panes[0].migratedFrom,'aider');
    assert.equal(reloaded.find(r => r.id === ordinary.id).panes[0].migratedFrom,undefined);
    assert(!fs.readFileSync(path.join(directory,'workspace-setups.json'),'utf8').includes('generation'));
  } finally { if(path.dirname(directory)!==os.tmpdir() || !path.basename(directory).startsWith('vibe-setup-test-')) throw new Error('Unsafe cleanup'); fs.rmSync(directory,{recursive:true,force:true}); }
  console.log('workspace setups and frozen handoff smoke passed');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
