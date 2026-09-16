'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createOrchestrator}=require('../../backend/orchestrator.cjs');
const {reviewExistingTargets}=require('../../backend/orchestratorTargetReview.cjs');
const {readReference}=require('../../backend/orchestratorReference.cjs');
async function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'vibe-target-review-'));
  const f={root,sessions:[],effects:[],plans:[],completions:[],interpretations:[],executions:[],phases:new Map()};let sequence=0;
  const response=body=>new Response(JSON.stringify(body));
  const tool=(name,args)=>response({choices:[{finish_reason:'tool_calls',message:{tool_calls:[{id:`call-${++sequence}`,type:'function',function:{name,arguments:JSON.stringify(args)}}]}}]});
  f.operation=(text,targetId='existing')=>({kind:'operate_terminal',targetIds:[targetId],text});
  f.work=text=>({kind:'delegate_task',kindOfSession:'codex',assignmentMode:'auto',cwd:root,text});
  f.sessions.push({id:'existing',name:'Unrelated product discussion',generation:'generation-existing',launchToken:1,cwd:root,kind:'codex',provider:'codex',status:'idle',started:true,processState:'running',agentProcessState:'running',agentPid:11,turnState:'completed',observation:'observed',conversationId:'conversation-existing'});
  f.plan=actions=>({goal:'Preserve the original requested work.',access:'read-only',actions});
  f.relay=createOrchestrator({userDataPath:root,getSessions:()=>f.sessions,getRoots:()=>({projects:[root]}),getLaunchers:()=>[{kind:'codex',available:true,configured:true}],
    routeTask:async(context,api)=>f.route?f.route(context,api):({kind:'choose',decision:'create',kindOfSession:'codex',reason:'Independent task needs a separate conversation.'}),
    readSession:async target=>({ok:true,id:target.id,generation:target.generation,text:f.readText||'Ready.',sequence:4,inputRevision:0}),
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
      const body=JSON.parse(options.body);f.completions.push(body);
      if (body.messages[0].content === require('../../backend/orchestratorGoalReview.cjs').INSPECTION_GOAL_REVIEW) {
        const evidence = JSON.parse(body.messages[1].content).evidence;
        return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ decision: 'complete', evidenceIds: [evidence.at(-1).id] }) } }] }));
      }

      if(body.messages[0].content.startsWith('Classify the ORIGINAL user request')) return response({choices:[{finish_reason:'stop',message:{content:f.inspectionDecision}}]});
      if(body.tools?.some(tool=>tool.function.name==='interpret_workspace')){
        f.interpretations.push(body);const plan=f.plans.shift();assert(plan,'Every interpretation is scripted');return tool('interpret_workspace',typeof plan==='function'?plan(body):plan);
      }
      f.executions.push(body);
      const context=JSON.parse(body.messages.find(message=>message.role==='user').content);
      const grant=context.authorizedCommands.grants.find(grant=>(f.phases.get(grant.id)||0)<(grant.kind==='create_session'?1:4));
      if(!grant)return response({choices:[{finish_reason:'stop',message:{content:'Requested effects observed.'}}]});
      const phase=f.phases.get(grant.id)||0;f.phases.set(grant.id,phase+1);
      if (grant.inspection && phase > 0) {
        const observed=JSON.parse(body.messages.filter(message=>message.role==='tool').at(-1).content);
        return tool('workspace',{kind:'finish_terminal',targetId:grant.targets[0].id,grantId:grant.id,stepId:`inspection-${phase}`,observationToken:observed.observationToken,outcome:'completed',text:f.readText});
      }
      if(f.omitFinish && phase>=2)return response({choices:[{finish_reason:'stop',message:{content:'The task was sent.'}}]});
      if(grant.kind==='create_session')return tool('workspace',{kind:'create_session',grantId:grant.id});
      assert.equal(grant.kind,'operate_terminal');const targetId=grant.targets[0].id;
      if(phase%2===0)return tool('workspace',{kind:'read_session',targetId});
      const observed=JSON.parse(body.messages.filter(message=>message.role==='tool').at(-1).content);
      return tool('workspace',{kind:phase===1?'send_prompt':'finish_terminal',targetId,grantId:grant.id,stepId:`step-${phase}`,observationToken:observed.observationToken,
        ...(phase===1?{text:grant.text}:{outcome:'completed',text:'Submission inspected.'})});
    }catch(error){f.fetchError=error;throw error;}}});
  t.after(async()=>{await f.relay.cancel();await f.relay.dispose();assert.equal(path.dirname(root),os.tmpdir());fs.rmSync(root,{recursive:true,force:true});});
  await f.relay.configure({apiKey:'fixture-secret-never-in-task-text',model:'scripted',sessionOnly:true});assert.equal((await f.relay.setEnabled(true)).ok,true);
  f.run=(text,extra={})=>f.relay.send({text,origin:'text',...extra});
  f.events=async()=>{await f.relay.flushDiagnostics();const file=path.join(root,'logs','orchestrator-errors.jsonl');
    return fs.existsSync(file)?fs.readFileSync(file,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)):[];};
  f.selections=async()=>(await f.events()).filter(event=>event.event==='intent_review'&&event.stage==='existing_target');
  return f;
}
// The selection check is code, so an existing-target plan costs no model call of
// its own: every completion this fixture sees is an interpretation or an
// execution round.
const noReviewCall=f=>assert.equal(f.completions.length,f.interpretations.length+f.executions.length,
  'the existing-target check must not spend a model call');

// The repair is the application's, not the model's: an operation the sentence
// never selected becomes delegate_task here, in one interpretation, and the
// deterministic resolver picks the pane. The model is asked nothing.
test('provider/project request misbound to an unrelated conversation repairs before any input', async t => {
  const f = await fixture(t), objective = 'Fix full-screen pane height; preserve width and verify the change.';
  f.plans.push(f.plan([f.operation(objective)]));
  const result = await f.run(`Prompt a Codex terminal in ${f.root} to ${objective}`);
  assert.equal(result.ok, true, f.fetchError?.stack || JSON.stringify(result));
  assert.equal(f.interpretations.length, 1, 'the repair costs no second interpretation');
  assert.deepEqual(f.effects.map(effect => effect.kind), ['create_session', 'send_prompt']);
  assert.notEqual(f.effects[1].targetId, 'existing');
  assert.equal(f.effects[1].text, objective);
  noReviewCall(f);
  assert.deepEqual((await f.selections()).map(event => [event.status, event.strategy]), [['assign', 'deterministic'], ['assigned', 'deterministic']]);
  const log = fs.readFileSync(path.join(f.root, 'logs', 'orchestrator-errors.jsonl'), 'utf8');
  assert.equal(log.includes(objective), false);
  assert.equal(log.includes('did not select'), false);
});

test('assignment repair can discover the same task started directly in an existing agent', async t => {
  const f = await fixture(t), objective = 'Also test the full-screen height fix.';
  f.sessions[0].name = 'Fix full-screen pane height';
  f.readText = 'User task: fix full-screen pane height. Agent: I am repairing that height constraint and adding regression coverage.';
  f.plans.push(f.plan([f.operation(objective)]), f.plan([f.work(objective)]));
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

test('a named pane still sends directly', async t => {
  const f = await fixture(t);
  f.plans.push(f.plan([f.operation('Check the pane height.')]));
  const result = await f.run('Ask Unrelated product discussion to fix the pane height.');
  assert.equal(result.ok, true, f.fetchError?.stack || JSON.stringify(result));
  assert.deepEqual(f.effects.map(effect => effect.kind), ['send_prompt']);
  assert.equal(f.effects[0].targetId, 'existing');
  assert.equal(f.interpretations.length, 1, 'a selected pane is interpreted once and dispatched');
  noReviewCall(f);
  assert.deepEqual((await f.selections()).map(event => [event.status, event.strategy]), [['direct', 'deterministic']]);
});

// The measurement this change exists for: "tell <pane> to <task>" used to cost
// an interpretation plus a 2.4 s target-review round before anything was typed.
test('a named-pane send costs exactly one model call end to end', async t => {
  const f = await fixture(t), objective = 'Investigate the full-screen pane height.';
  f.plans.push(f.plan([{ ...f.operation(objective), operationMode: 'task' }]));
  const result = await f.run('Ask Unrelated product discussion to investigate the full-screen pane height.');
  assert.equal(result.ok, true, f.fetchError?.stack || JSON.stringify(result));
  assert.deepEqual(f.effects.map(effect => [effect.kind, effect.targetId]), [['send_prompt', 'existing']]);
  assert.equal(f.effects[0].text, objective);
  assert.equal(f.completions.length, 1, JSON.stringify(f.completions.map(body => String(body.messages[0].content).slice(0, 70))));
  assert.equal(f.interpretations.length, 1);
  assert.equal(f.executions.length, 0);
});

// A group phrase names a kind of pane, not a conversation. It is assignment's
// question now: the resolver knows which panes are idle and unowned.
test('a group phrase goes to assignment, which reuses the idle pane', async t => {
  const f = await fixture(t), objective = 'Check the pane height.';
  f.plans.push(f.plan([f.operation(objective)]));
  f.route = async () => ({ kind: 'choose', decision: 'reuse', targetId: 'existing', reason: 'Idle pane with no task owner.' });
  const result = await f.run('Prompt one of the existing Codex terminals to check the height.');
  assert.equal(result.ok, true, f.fetchError?.stack || JSON.stringify(result));
  assert.equal(f.interpretations.length, 1);
  assert.deepEqual(f.effects.map(effect => effect.kind), ['send_prompt']);
  assert.equal(f.effects[0].targetId, 'existing');
  assert.deepEqual((await f.selections()).map(event => event.status), ['assign', 'assigned']);
});

test('same-task follow-up retains the existing busy owner through the prior exchange', async t => {
  const f = await fixture(t);
  f.plans.push(f.plan([f.operation('Fix the pane height.')]));
  const first = await f.run('Ask Unrelated product discussion to fix the pane height.');
  assert.equal(first.ok, true, JSON.stringify(first));
  Object.assign(f.sessions[0], { turnState: 'running', status: 'running', turnId: 'active-fix', turnStartedAt: Date.now(), actionId: f.effects[0].actionId });
  await f.relay.refresh();
  f.plans.push(f.plan([f.operation('Also add regression coverage for that fix.')]));
  // "that agent" names nothing; the pane comes from the exchange this answers.
  const second = await f.run('Tell that agent to also add regression coverage for that fix.', { replyToRequestId: first.requestId });
  assert.equal(second.ok, true, f.fetchError?.stack || JSON.stringify(second));
  assert.deepEqual(f.effects.map(effect => effect.targetId), ['existing', 'existing']);
  assert.deepEqual((await f.selections()).map(event => event.status), ['direct', 'direct']);
  assert.equal(f.interpretations.length, 2, 'neither request needed a second round');
});

test('mixed requests retain the explicitly selected sibling when unassigned work is repaired', async t => {
  const f = await fixture(t);
  const named = f.operation('Continue the product discussion.');
  f.plans.push(f.plan([named, f.operation('Fix full-screen height.')]), f.plan([named, f.work('Fix full-screen height.')]));
  const result = await f.run('Continue the product discussion in Unrelated product discussion and get a Codex in this project to fix full-screen height.');
  assert.equal(result.ok, true, f.fetchError?.stack || JSON.stringify(result));
  assert.equal(f.effects.filter(effect => effect.kind === 'create_session').length, 1);
  const sends = f.effects.filter(effect => effect.kind === 'send_prompt');
  assert.equal(sends.length, 2);
  assert.equal(sends.find(effect => effect.targetId === 'existing').text, named.text);
  assert.equal(sends.find(effect => effect.targetId !== 'existing').text, 'Fix full-screen height.');
});

// There is nothing left to bypass: a provider/project request never reaches the
// pane the plan named, because the operation itself is rewritten before any
// effect exists. The pane that was proposed keeps receiving nothing.
test('a provider/project request cannot type into the pane the plan named', async t => {
  const f = await fixture(t);
  f.plans.push(f.plan([f.operation('Fix pane height.')]));
  const result = await f.run(`Prompt a Codex in ${f.root} to fix pane height.`);
  assert.equal(result.ok, true, f.fetchError?.stack || JSON.stringify(result));
  assert.equal(f.interpretations.length, 1);
  assert.equal(f.effects.some(effect => effect.kind === 'send_prompt' && effect.targetId === 'existing'), false);
  assert.deepEqual(f.effects.map(effect => effect.kind), ['create_session', 'send_prompt']);
});

// The schema repair is the only interpretation repair left. A plan that is both
// malformed and misbound costs exactly one repair round for the malformed half;
// the misbound half is resolved in code on the repaired plan.
test('a schema repair composes with the deterministic selection repair before dispatch', async t => {
  const f = await fixture(t), objective = 'Investigate full-screen pane height only; do not modify files.';
  f.plans.push(f.plan([{ ...f.operation(objective), unexpected: 'PRIVATE_INVALID_ARGUMENT' }]), body => {
    assert.deepEqual(f.effects, []);
    assert.match(body.messages[0].content, /Validation failure/);
    assert.equal(body.messages[0].content.includes('did not select the proposed existing conversation'), false);
    assert.equal(body.messages[0].content.includes('PRIVATE_INVALID_ARGUMENT'), false);
    assert.equal(JSON.parse(body.messages[1].content).instruction, instruction);
    return f.plan([f.operation(objective)]);
  });
  const instruction = `Prompt a Codex terminal in ${f.root} to ${objective}`;
  const result = await f.run(instruction);
  assert.equal(result.ok, true, f.fetchError?.stack || JSON.stringify(result));
  assert.equal(f.interpretations.length, 2);
  assert.deepEqual(f.effects.map(effect => effect.kind), ['create_session', 'send_prompt']);
  assert.notEqual(f.effects[1].targetId, 'existing');
  assert.equal(f.effects[1].text, objective);
  noReviewCall(f);
  const events = await f.events();
  assert.equal(events.filter(event => event.stage === 'interpretation' && event.status === 'retry').length, 1);
  assert.ok(events.some(event => event.event === 'intent_repair' && event.status === 'repaired'));
  assert.equal(JSON.stringify(events).includes('PRIVATE_INVALID_ARGUMENT'), false);
});

test('a repeated schema failure still stops before any effect', async t => {
  const f = await fixture(t), operation = f.operation('Investigate pane height only.');
  const plan = f.plan([{ ...operation, unexpected: true }]);
  f.plans.push(plan, plan);
  const result = await f.run(`Prompt a Codex terminal in ${f.root} to investigate pane height only.`);
  assert.equal(result.ok, false);
  assert.equal(f.interpretations.length, 2);
  assert.equal(f.fetchError, undefined);
  assert.deepEqual(f.effects, []);
});

test('explicit existing task handoff completes after one send when the model omits read and finish', async t => {
  const f = await fixture(t); f.omitFinish = true;
  const objective = 'Investigate full-screen height without editing files.';
  f.plans.push(f.plan([{ ...f.operation(objective), operationMode: 'task' }]));
  const result = await f.run('Ask Unrelated product discussion to investigate full-screen height without editing files.');
  assert.equal(result.ok, true, f.fetchError?.stack || JSON.stringify(result));
  assert.deepEqual(f.effects.map(effect => effect.kind), ['send_prompt']);
  assert.equal(f.effects[0].targetId, 'existing');
  assert.equal(f.effects[0].text, objective);
  // A bound task handoff is application logic: the executor model is not asked
  // at all, so there is no round in which it could omit the read or the finish.
  assert.equal(f.executions.length, 0);
  const task = f.relay.getState().tasks.find(task => task.requestId === result.requestId);
  assert.equal(task.status, 'waiting-results');
});

test('general interaction still needs its own finish after sending a task', async t => {
  const f = await fixture(t); f.omitFinish = true;
  f.plans.push(f.plan([f.operation('Send the investigation and then inspect the model menu.')]));
  const result = await f.run('Use Unrelated product discussion to send an investigation and inspect its model menu.');
  assert.equal(result.ok, false);
  // The stage that gave up is internal. What the user reads is the account of
  // the pane: what was typed there and what Lina is waiting on.
  assert.match(result.error, /Typed the task into Unrelated product discussion, but I haven't seen it start yet/);
  assert.doesNotMatch(result.error, /unfinished|action receipts/);
  assert.equal(f.effects.length, 1);
});

test('fresh follow-up repairs an expired source ID without replaying the earlier task', async t => {
  const f = await fixture(t); f.omitFinish = true;
  f.plans.push(f.plan([{ ...f.operation('Investigate the height.'), operationMode: 'task' }]));
  const first = await f.run('Ask Unrelated product discussion to investigate the height.');
  assert.equal(first.ok, true, JSON.stringify(first));
  const next = { ...f.operation('Also verify narrow windows.'), operationMode: 'task' };
  f.plans.push(f.plan([{ ...next, sourceUserId: first.requestId }]), body => {
    assert.match(body.messages[0].content, /new follow-up instruction.*omit both fields/);
    return f.plan([next]);
  });
  const follow = await f.run('Tell that agent to also verify narrow windows.', { replyToRequestId: first.requestId });
  assert.equal(follow.ok, true, f.fetchError?.stack || JSON.stringify(follow));
  assert.deepEqual(f.effects.map(effect => effect.text), ['Investigate the height.', 'Also verify narrow windows.']);
  assert.deepEqual(f.effects.map(effect => effect.targetId), ['existing', 'existing']);
});

// The classification round that used to decide whether a selection veto had
// been answered with an inspection went with the veto. An informational plan is
// an informational plan, and it costs one interpretation.
test('an informational request runs as an inspection with no classification call', async t => {
  const f = await fixture(t); f.readText = 'Session limit: 23% used; resets 19:00.';
  f.plans.push({ ...f.plan([f.operation('Inspect current session usage limits.')]), responseKind: 'terminal-inspection' });
  const result = await f.run('What are my Codex session usage limits?');
  assert.equal(result.ok, true, f.fetchError?.stack || JSON.stringify(result));
  assert.equal(f.interpretations.length, 1);
  assert.equal(f.completions.some(body => String(body.messages[0].content).startsWith('Classify the ORIGINAL user request')), false);
  assert.deepEqual(f.effects, []);
  assert.match(result.text, /23%/);
});

// ---------------------------------------------------------------------------
// The deterministic contract itself. No transport, no fixture: the decision is
// a function of the sentence, the roster and what the application already holds.
// ---------------------------------------------------------------------------
const ALPHA = 'C:/work/alpha';
const pane = (id, name, extra = {}) => ({ id, generation: `g-${id}`, name, kind: 'codex', provider: 'codex', cwd: ALPHA, ...extra });
const atlas = pane('atlas', 'Atlas', { conversationTitle: 'Atlas memory store rewrite' });
const beta = pane('beta', 'Beta', { conversationTitle: 'Beta invoice rounding fix' });
const target = session => ({ id: session.id, generation: session.generation });
const operation = (targets, text = 'Do the work.') => ({ sourceUserId: 'r', kind: 'operate_terminal', targets, text });
const review = (operations, context) => reviewExistingTargets({ grants: operations }, { requestId: 'r', ...context });
const project = { path: ALPHA, name: 'alpha' };

test('a plan proposing no existing target is not reviewed at all', () => {
  assert.equal(review([{ sourceUserId: 'r', kind: 'delegate_task', args: { cwd: ALPHA }, text: 'Fix it.' }],
    { instruction: 'Get a Codex in alpha to fix the header.', sessions: [atlas] }), null);
  assert.equal(review([{ ...operation([target(atlas)]), inspection: true }],
    { instruction: 'What is Atlas showing?', sessions: [atlas] }), null);
});

for (const [label, expected, basis, context] of [
  ['a provider and a project select neither conversation', 'ASSIGN', 'unselected',
    { instruction: 'Prompt a Codex terminal in alpha to fix the header.', sessions: [atlas], projectContext: project }],
  ['the pane the sentence names is sent to directly', 'DIRECT', 'named',
    { instruction: 'Tell Atlas in the alpha project to inspect the memory store.', sessions: [atlas, beta], projectContext: project }],
  ['a pronoun continues the pane of the exchange it answers', 'DIRECT', 'continuation',
    { instruction: 'Tell it to also add regression coverage.', sessions: [atlas, beta], projectContext: project,
      replyContext: { requestId: 'p', conversationTarget: target(atlas) } }],
  ['a replaced generation is no longer that conversation', 'ASSIGN', 'unselected',
    { instruction: 'Tell that agent to also test its fix.', sessions: [atlas], projectContext: project,
      replyContext: { requestId: 'p', conversationTarget: { id: 'atlas', generation: 'replaced' } } }],
  ['a new independent sentence keeps the pane the user selected in the UI', 'DIRECT', 'user-selected',
    { instruction: 'Run the unit tests and report back.', sessions: [atlas, beta], projectContext: project, targetId: 'atlas' }],
  ['a selected pane loses to another pane the sentence names', 'ASSIGN', 'unselected',
    { instruction: 'Have Beta invoice rounding look at the totals.', sessions: [atlas, beta], projectContext: project, targetId: 'atlas' }],
  ['the pane answering its own question is the one the answer goes to', 'DIRECT', 'user-selected',
    { instruction: 'Yes, approve that.', sessions: [atlas], projectContext: project,
      interactionContext: { id: 'q1', sessionId: 'atlas', generation: 'g-atlas', revision: 2 } }],
  ['a definite provider phrase selects the only pane of that family', 'DIRECT', 'provider-project',
    { instruction: 'Tell the Codex terminal in alpha to run the tests.', sessions: [atlas], projectContext: project }],
  ['a second pane of that family makes the provider phrase ambiguous', 'ASSIGN', 'unselected',
    { instruction: 'Tell the Codex terminal in alpha to run the tests.', sessions: [atlas, beta], projectContext: project }],
  ['a group phrase is a kind of pane, not a conversation', 'ASSIGN', 'unselected',
    { instruction: 'Prompt one of the existing Codex terminals to check the height.', sessions: [atlas], projectContext: project }],
  ['a request to open one is assignment, not selection', 'ASSIGN', 'selector-new',
    { instruction: 'Open a new Codex terminal and have it check the height.', sessions: [atlas], projectContext: project }],
]) test(`existing-target review: ${label}`, () => {
  const decision = review([operation([target(atlas)])], context);
  assert.deepEqual([decision.decision, decision.operations[0].basis], [expected, basis], JSON.stringify(decision));
});

test('two similar titles and an ambiguous phrase go to assignment, which asks', () => {
  const first = pane('t1', 'chat section integration'), second = pane('t2', 'chat section styling');
  const decision = review([operation([target(first)])], { instruction: 'Ask the chat section agent to run the tests.', sessions: [first, second], projectContext: project });
  assert.deepEqual([decision.decision, decision.operations[0].basis], ['ASSIGN', 'unselected']);
});

test('a pane in another project than the one the sentence names is never the selection', () => {
  const elsewhere = pane('gamma', 'Gamma', { cwd: 'C:/work/other', conversationTitle: 'Gamma header work' });
  const decision = review([operation([target(elsewhere)])],
    { instruction: 'Tell Gamma header work in alpha to run the tests.', sessions: [atlas, elsewhere], projectContext: project });
  assert.deepEqual([decision.decision, decision.operations[0].basis], ['ASSIGN', 'outside-addressed-project']);
});

test('one sentence addressing two panes keeps each named sibling and assigns the rest', () => {
  const both = review([operation([target(atlas)], 'Inspect the memory store.'), operation([target(beta)], 'Fix invoice rounding.')],
    { instruction: 'Tell Atlas to inspect the memory store and Beta invoice rounding to fix the rounding.', sessions: [atlas, beta], projectContext: project });
  assert.deepEqual([both.decision, ...both.operations.map(item => item.basis)], ['DIRECT', 'named', 'named']);
  const mixed = review([operation([target(atlas)], 'Inspect the memory store.'), operation([target(atlas)], 'Fix the header.')],
    { instruction: 'Tell Atlas to inspect the memory store and get a Codex in this project to fix the header.', sessions: [atlas], projectContext: project });
  assert.deepEqual([mixed.decision, ...mixed.operations.map(item => item.basis)], ['ASSIGN', 'named', 'unselected']);
});

// The 128 saved utterances are the regression corpus. Every row whose selector
// is a pane the user identified - by title, or as the pane the last exchange
// used - must reach that pane without a model round when the roster holds one
// matching pane. Rows 9 and 10 are resume requests, which never produce a
// terminal operation, and their titles survive only as garbled speech.
test('the saved utterance corpus resolves its title and last-target rows deterministically', () => {
  const rows = require('./fixtures/orchestrator-utterances.json')
    .filter(row => ['title', 'last_target'].includes(row.selector) && row.verb !== 'resume');
  assert.equal(rows.length, 11);
  const decoy = pane('decoy', 'Invoice rounding repair', { kind: 'claude', provider: 'claude', conversationTitle: 'Invoice rounding repair' });
  for (const row of rows) {
    const selector = readReference(row.text, { launchers: [] });
    const named = row.selector === 'title';
    if (named) assert.equal(selector.kind, 'title', `row ${row.n} carries no title phrase`);
    const chosen = pane('chosen', 'Codex 3', { conversationTitle: named ? selector.text : 'Orchestrator wake word work' });
    const decision = review([operation([target(chosen)], 'Continue.')], { instruction: row.text, sessions: [chosen, decoy],
      ...(named ? {} : { replyContext: { requestId: 'p', conversationTarget: target(chosen) } }) });
    assert.equal(decision.decision, 'DIRECT', `row ${row.n} (${row.selector}): ${JSON.stringify(decision)}`);
  }
});
