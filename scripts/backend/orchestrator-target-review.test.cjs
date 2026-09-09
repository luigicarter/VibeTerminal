'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createOrchestrator}=require('../../backend/orchestrator.cjs');
const {TARGET_REVIEW_SYSTEM,targetReviewPayload,targetReviewDecision}=require('../../backend/orchestratorTargetReview.cjs');
async function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'vibe-target-review-'));
  const f={root,sessions:[],effects:[],plans:[],markers:[],checks:[],interpretations:[],phases:new Map()};let sequence=0;
  const response=body=>new Response(JSON.stringify(body));
  const tool=(name,args)=>response({choices:[{finish_reason:'tool_calls',message:{tool_calls:[{id:`call-${++sequence}`,type:'function',function:{name,arguments:JSON.stringify(args)}}]}}]});
  f.operation=(text,targetId='existing')=>({kind:'operate_terminal',targetIds:[targetId],text});
  f.work=text=>({kind:'delegate_task',kindOfSession:'codex',assignmentMode:'auto',cwd:root,text});
  f.sessions.push({id:'existing',name:'Unrelated product discussion',generation:'generation-existing',launchToken:1,cwd:root,kind:'codex',provider:'codex',status:'idle',started:true,processState:'running',agentProcessState:'running',agentPid:11,turnState:'completed',observation:'observed',conversationId:'conversation-existing'});
  f.plan=actions=>({goal:'Preserve the original requested work.',access:'read-only',actions});
  f.relay=createOrchestrator({userDataPath:root,getSessions:()=>f.sessions,getRoots:()=>({projects:[root]}),getLaunchers:()=>[{kind:'codex',available:true,configured:true}],
    routeTask:async(context,api)=>f.route?f.route(context,api):({kind:'choose',decision:'create',kindOfSession:'codex',reason:'Independent task needs a separate conversation.'}),
    readSession:async target=>({ok:true,id:target.id,generation:target.generation,text:f.readText||'Ready.',sequence:4,observationSequence:4,inputRevision:0}),
    dispatchAction:async action=>{
      f.effects.push(action);
      if(action.kind==='create_session'){
        const id=`worker-${f.sessions.length}`,generation=`generation-${id}`;
        f.sessions.push({id,generation,launchToken:1,cwd:root,kind:'codex',provider:'codex',status:'idle',started:true,processState:'running',agentProcessState:'running',agentPid:12,turnState:'idle',observation:'observed',conversationId:`conversation-${id}`});
        return {ok:true,status:'created',id,target:{id,generation},launchToken:1,processState:'running',draftStaged:Boolean(action.prompt||action.text)};
      }
      assert.equal(action.kind,'send_prompt');return {ok:true,status:'written'};
    },fetch:async(url,options)=>{try{
      if(url.endsWith('/key'))return response({data:{}});
      if(url.endsWith('/models'))return response({data:[{id:'scripted',context_length:128000,supported_parameters:['tools','tool_choice']}]});
      const body=JSON.parse(options.body);
      if(body.messages[0].content===TARGET_REVIEW_SYSTEM){
        assert(!body.tools?.length);f.checks.push(JSON.parse(body.messages[1].content));
        let marker=f.markers.shift();assert.notEqual(marker,undefined,'Every target review is scripted');if(typeof marker==='function')marker=await marker(options);if(marker instanceof Error)throw marker;
        return response(marker?.choices?marker:{choices:[{finish_reason:'stop',message:{content:JSON.stringify(marker==='DIRECT'?{decision:'DIRECT',evidenceIds:JSON.parse(body.messages[1].content).selectionEvidence.map(item=>item.id)}:{decision:'ASSIGN'})}}]});
      }
      if(body.tools?.some(tool=>tool.function.name==='interpret_workspace')){
        f.interpretations.push(body);const plan=f.plans.shift();assert(plan,'Every interpretation is scripted');return tool('interpret_workspace',typeof plan==='function'?plan(body):plan);
      }
      const context=JSON.parse(body.messages.find(message=>message.role==='user').content);
      const grant=context.authorizedCommands.grants.find(grant=>(f.phases.get(grant.id)||0)<(grant.kind==='create_session'?1:4));
      if(!grant)return response({choices:[{finish_reason:'stop',message:{content:'Requested effects observed.'}}]});
      const phase=f.phases.get(grant.id)||0;f.phases.set(grant.id,phase+1);
      if(grant.kind==='create_session')return tool('workspace',{kind:'create_session',grantId:grant.id});
      assert.equal(grant.kind,'operate_terminal');const targetId=grant.targets[0].id;
      if(phase%2===0)return tool('workspace',{kind:'read_session',targetId});
      const observed=JSON.parse(body.messages.filter(message=>message.role==='tool').at(-1).content);
      return tool('workspace',{kind:phase===1?'send_prompt':'finish_terminal',targetId,grantId:grant.id,stepId:`step-${phase}`,observationToken:observed.observationToken,
        ...(phase===1?{text:grant.text,observationSequence:observed.observation.sequence,inputRevision:observed.observation.inputRevision}:{outcome:'completed',text:'Submission inspected.'})});
    }catch(error){f.fetchError=error;throw error;}}});
  t.after(async()=>{await f.relay.cancel();await f.relay.dispose();assert.equal(path.dirname(root),os.tmpdir());fs.rmSync(root,{recursive:true,force:true});});
  await f.relay.configure({apiKey:'fixture-secret-never-in-task-text',model:'scripted',sessionOnly:true});assert.equal((await f.relay.setEnabled(true)).ok,true);
  f.run=(text,extra={})=>f.relay.send({text,origin:'text',...extra});return f;
}

test('provider/project request misbound to an unrelated conversation repairs before any input', async t => {
  const f = await fixture(t), objective = 'Fix full-screen pane height; preserve width and verify the change.';
  f.plans.push(f.plan([f.operation(objective)]), body => {
    assert.match(body.messages[0].content, /did not select the proposed existing conversation/);
    assert.deepEqual(f.effects, []);
    return f.plan([f.work(objective)]);
  });
  f.markers.push('ASSIGN');
  const result = await f.run(`Prompt a Codex terminal in ${f.root} to ${objective}`);
  assert.equal(result.ok, true, f.fetchError?.stack || JSON.stringify(result));
  assert.deepEqual(f.effects.map(effect => effect.kind), ['create_session', 'send_prompt']);
  assert.notEqual(f.effects[1].targetId, 'existing');
  assert.equal(f.effects[1].text, objective);
  assert.equal(f.checks.length, 0, 'no target-selection evidence means no model can approve the unrelated pane');
  await f.relay.flushDiagnostics();
  const log = fs.readFileSync(path.join(f.root, 'logs', 'orchestrator-errors.jsonl'), 'utf8');
  assert.ok(log.trim().split('\n').map(JSON.parse).some(event => event.stage === 'existing_target' && event.status === 'assign'));
  assert.equal(log.includes(objective), false);
});

test('assignment repair can discover the same task started directly in an existing agent', async t => {
  const f = await fixture(t), objective = 'Also test the full-screen height fix.';
  f.sessions[0].name = 'Fix full-screen pane height';
  f.readText = 'User task: fix full-screen pane height. Agent: I am repairing that height constraint and adding regression coverage.';
  f.plans.push(f.plan([f.operation(objective)]), f.plan([f.work(objective)]));
  f.markers.push('ASSIGN');
  f.route = async (context, api) => {
    assert.equal(context.instruction, objective);
    const observed = await api.read({ kind: 'read_session', targetId: 'existing' });
    assert.ok(JSON.stringify(observed).includes(f.readText));
    return { kind: 'choose', decision: 'reuse', targetId: 'existing', reason: 'Observed the same full-screen repair in this conversation.' };
  };
  const result = await f.run(`Have a Codex in ${f.root} continue the full-screen repair with regression tests.`);
  assert.equal(result.ok, true, f.fetchError?.stack || JSON.stringify(result));
  assert.deepEqual(f.effects.map(effect => effect.kind), ['send_prompt']);
  assert.equal(f.effects[0].targetId, 'existing');
});

for (const instruction of ['Ask Unrelated product discussion to fix the pane height.', 'Prompt one of the existing Codex terminals to check the height.']) {
  test(`explicit existing selection remains valid: ${instruction}`, async t => {
    const f = await fixture(t);
    f.plans.push(f.plan([f.operation('Check the pane height.')])); f.markers.push('DIRECT');
    const result = await f.run(instruction);
    assert.equal(result.ok, true, f.fetchError?.stack || JSON.stringify(result));
    assert.deepEqual(f.effects.map(effect => effect.kind), ['send_prompt']);
    assert.equal(f.effects[0].targetId, 'existing');
  });
}

test('same-task follow-up retains the existing busy owner and the prior exchange in the review', async t => {
  const f = await fixture(t);
  f.plans.push(f.plan([f.operation('Fix the pane height.')])); f.markers.push('DIRECT');
  const first = await f.run('Ask Unrelated product discussion to fix the pane height.');
  assert.equal(first.ok, true, JSON.stringify(first));
  Object.assign(f.sessions[0], { turnState: 'running', status: 'running', turnId: 'active-fix', turnStartedAt: Date.now(), actionId: f.effects[0].actionId });
  await f.relay.refresh();
  f.plans.push(f.plan([f.operation('Also add regression coverage for that fix.')])); f.markers.push('DIRECT');
  const second = await f.run('Tell that agent to also add regression coverage for that fix.', { replyToRequestId: first.requestId });
  assert.equal(second.ok, true, f.fetchError?.stack || JSON.stringify(second));
  assert.deepEqual(f.effects.map(effect => effect.targetId), ['existing', 'existing']);
  assert.ok(f.checks[1].replyContext);
});

test('mixed requests retain the explicitly selected sibling when unassigned work is repaired', async t => {
  const f = await fixture(t);
  const named = f.operation('Continue the product discussion.');
  f.plans.push(f.plan([named, f.operation('Fix full-screen height.')]), f.plan([named, f.work('Fix full-screen height.')]));
  f.markers.push('ASSIGN', 'DIRECT');
  const result = await f.run('Continue the product discussion in Unrelated product discussion and get a Codex in this project to fix full-screen height.');
  assert.equal(result.ok, true, f.fetchError?.stack || JSON.stringify(result));
  assert.equal(f.effects.filter(effect => effect.kind === 'create_session').length, 1);
  const sends = f.effects.filter(effect => effect.kind === 'send_prompt');
  assert.equal(sends.length, 2);
  assert.equal(sends.find(effect => effect.targetId === 'existing').text, named.text);
  assert.equal(sends.find(effect => effect.targetId !== 'existing').text, 'Fix full-screen height.');
});

for (const replacement of ['same-target', 'drop-task', 'empty-pane']) test(`assignment veto cannot be bypassed by ${replacement}`, async t => {
  const f = await fixture(t), operation = f.operation('Fix pane height.');
  f.plans.push(f.plan([operation]), f.plan(replacement === 'same-target' ? [operation] : replacement === 'empty-pane' ? [{ kind: 'create_session', kindOfSession: 'codex', cwd: f.root }] : []));
  f.markers.push('ASSIGN');
  const result = await f.run(`Prompt a Codex in ${f.root} to fix pane height.`);
  assert.equal(result.ok, false); assert.deepEqual(f.effects, []);
  assert.equal(f.checks.length, 0, 'unsupported target selection cannot reach model approval');
});

test('incomplete, malformed and tool-bearing review replies cannot approve an existing target', () => {
  for (const choice of [undefined, { message: { content: 'DIRECT but also create' } }, { finish_reason: 'length', message: { content: 'DIRECT' } },
    { finish_reason: 'content_filter', message: { content: 'DIRECT' } }, { message: { content: 'DIRECT', tool_calls: [{}] } }]) {
    assert.equal(targetReviewDecision({ choices: [choice] }), 'UNRESOLVED');
  }
});

test('DIRECT requires actual application evidence covering every operation', () => {
  const payload = { proposedOperations: [{}, {}], selectionEvidence: [{ id: 'named-0', operation: 0 }, { id: 'reply-1', operation: 1 }] };
  const response = evidenceIds => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ decision: 'DIRECT', evidenceIds }) } }] });
  for (const ids of [[], ['named-0'], ['named-0', 'invented'], ['named-0', 'named-0']]) assert.equal(targetReviewDecision(response(ids), payload), 'UNRESOLVED');
  assert.equal(targetReviewDecision(response(['named-0', 'reply-1']), payload), 'DIRECT');
});

test('generic provider/project and creation wording cannot mint existing-selection evidence', () => {
  const session = { id: 'pane', generation: 'g1', name: 'Unrelated discussion', kind: 'codex', cwd: 'C:/QA' };
  const plan = { grants: [{ sourceUserId: 'r', kind: 'operate_terminal', targets: [{ id: 'pane', generation: 'g1' }], text: 'Fix full-screen height.' }] };
  for (const instruction of ['Prompt a Codex terminal in QA to fix full-screen height.', 'Open a Codex terminal in QA to fix full-screen height.']) {
    const payload = targetReviewPayload(plan, { requestId: 'r', instruction, sessions: [session] });
    assert.deepEqual(payload.selectionEvidence, []);
  }
  const payload = targetReviewPayload(plan, { requestId: 'r', instruction: 'Tell that agent to also test its fix.', sessions: [session],
    replyContext: { requestId: 'old', conversationTarget: { id: 'pane', generation: 'replaced-generation' } } });
  assert.deepEqual(payload.selectionEvidence, [], 'a replaced reply target cannot supply selection evidence');
  plan.grants[0].targets = [];
  assert.doesNotThrow(() => targetReviewPayload(plan, { requestId: 'r', instruction: 'Prompt an idle Codex terminal.', sessions: [session] }));
});

test('target review network failure stops before effects', async t => {
  const f = await fixture(t);
  f.plans.push(f.plan([f.operation('Fix the height.')])); f.markers.push(new TypeError('Synthetic network unavailable'));
  const result = await f.run('Ask the existing agent to fix the height.');
  assert.equal(result.ok, false); assert.ok(result.upstreamError); assert.deepEqual(f.effects, []);
  assert.equal(f.interpretations.length, 1);
});

test('an inconclusive review cannot reroute an explicitly selected conversation', async t => {
  const f = await fixture(t);
  f.plans.push(f.plan([f.operation('Fix the height.')]));
  f.markers.push({ choices: [{ finish_reason: 'length', message: { content: '{"decision":"DIRECT"}' } }] });
  const result = await f.run('Ask Unrelated product discussion to fix the height.');
  assert.equal(result.ok, false); assert.match(result.error, /selection could not be verified/);
  assert.deepEqual(f.effects, []); assert.equal(f.interpretations.length, 1);
});

test('cancelling while reviewing target selection cannot send input', async t => {
  const f = await fixture(t); let entered = false;
  f.plans.push(f.plan([f.operation('Fix the height.')]));
  f.markers.push(options => new Promise((resolve, reject) => { entered = true; options.signal.addEventListener('abort', () => reject(Object.assign(new Error('Cancelled'), { name: 'AbortError' })), { once: true }); }));
  const pending = f.run('Ask the existing agent to fix the height.');
  const deadline = Date.now() + 1000;
  while (!entered) { assert.ok(Date.now() < deadline); await new Promise(resolve => setImmediate(resolve)); }
  await f.relay.cancel(); assert.equal((await pending).ok, false); assert.deepEqual(f.effects, []);
});
