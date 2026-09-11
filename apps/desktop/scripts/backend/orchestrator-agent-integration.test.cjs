'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { createOrchestrator } = require('../../backend/orchestrator.cjs');
const { agent } = require('./orchestrator-agent-fixtures.cjs');
let serial = 0;
const response = body => new Response(JSON.stringify(body));
const tool = action => ({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: `agent-call-${++serial}`, type: 'function', function: { name: 'workspace', arguments: JSON.stringify(action) } }] } }] });
async function fixture(t, count = 0) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lina-agent-integration-'));
  const f = { root, plans: [], interpretations: [], phases: new Map(), effects: [], reads: [], contexts: [], routes: [], sessions:
    Array.from({length: count}, (_, i) => agent(`unrelated-${i}`, { cwd: root, name: `Unrelated job ${i}` })),
    launchers: [{ kind: 'claude', available: true, configured: true }, { kind: 'codex', available: true, configured: true }] };
  f.app = createOrchestrator({ userDataPath: root, agentHarness: 'agents-v1',
    getSessions: () => f.sessions, getRoots: () => ({ documents: root, projects: f.projects || [{name:'Project',path:root}] }),
    getWorkspaceState: async () => f.workspaceState || ({ok:true,view:'project',cwd:root}), getLaunchers: () => f.launchers,
    interpretIntent: async context => { f.interpretations.push(context); return f.interpret ? f.interpret(context) : { goal: context.instruction, actions: f.plans.shift() || [] }; },
    reviewTaskAffinity: input => f.affinity ? f.affinity(input) : 'independent',
    routeTask: async (context, api) => { f.routes.push(context); return f.route ? f.route(context,api) : {kind:'choose',decision:'create',kindOfSession:'codex',reason:'Independent task.'}; },
    readSession: async target => {
      f.reads.push(target.id); const s = f.sessions.find(item => item.id === target.id);
      return { ok:true,id:s.id,generation:s.generation,text:'Observed composer',sequence:10,inputRevision:2 };
    },
    dispatchAction: async action => {
      f.effects.push(action);
      if (action.kind === 'create_session') {
        const s = agent(`created-${f.sessions.length}`, {cwd:action.cwd,kind:action.kindOfSession,provider:action.kindOfSession}); f.sessions.push(s);
        return {ok:true,status:'created',id:s.id,launchToken:s.launchToken,processState:'running',target:{id:s.id,generation:s.generation,launchToken:s.launchToken}};
      }
      return f.delivery ? f.delivery(action) : {ok:true,status:'written'};
    },
    fetch: async (url, options) => {
      if (url.endsWith('/key')) return response({data:{}});
      if (url.endsWith('/models')) return response({data:[{id:'fixture',context_length:128000,supported_parameters:['tools','tool_choice']}]});
      const body=JSON.parse(options.body), metadata=JSON.parse(body.messages.find(m=>m.role==='user').content);
      f.contexts.push(metadata);
      if (f.answer) return response(tool(await f.answer(body,metadata)));
      const grant=metadata.authorizedCommands?.grants.find(g=>g.kind==='operate_terminal');
      if (!grant) return response(tool({kind:'respond',text:'No new work was sent.',responseTurn:'complete'}));
      const phase=f.phases.get(grant.id)||0; f.phases.set(grant.id,phase+1);
      const targetId=grant.targets[0].id;
      if (phase===0 || phase===2) return response(tool({kind:'read_session',targetId}));
      const observed=JSON.parse(body.messages.filter(m=>m.role==='tool').at(-1).content);
      const args={targetId,grantId:grant.id,stepId:`${grant.id}-${phase}`,observationToken:observed.observationToken};
      if (phase===1) return response(tool({...args,kind:'send_prompt',text:grant.text||metadata.instruction,
        observationSequence:observed.observation?.sequence,inputRevision:observed.observation?.inputRevision}));
      return response(tool({...args,kind:'finish_terminal',outcome:'completed',text:'Delivery observed; result pending.'}));
    }
  });
  t.after(async()=>{ await f.app.cancel(); await f.app.dispose(); assert.equal(path.dirname(root),os.tmpdir()); fs.rmSync(root,{recursive:true,force:true}); });
  await f.app.configure({apiKey:'fixture-key',model:'fixture',sessionOnly:true}); assert.equal((await f.app.setEnabled(true)).ok,true);
  f.run = async (text, extra = {}, input = {}) => { f.plans.push([{kind:'delegate_task',text,cwd:root,...extra}]); return f.app.send({text,origin:'text',...input}); };
  f.task = result => f.app.getState().tasks.find(t=>t.requestId===result.requestId);
  f.finish = async result => {
    const send=f.effects.filter(e=>e.kind==='send_prompt').at(-1), s=f.sessions.find(s=>s.id===send.target.id), time=Date.now();
    Object.assign(s,{turnId:`turn-${result.requestId}`,actionId:send.actionId,turnState:'completed',status:'completed',turnStartedAt:time,turnEndedAt:time});
    await f.app.refresh();
  };
  return f;
}

test('project task chooses a configured provider without requesting a terminal, preserving 200 unrelated sessions', async t => {
  const f=await fixture(t,200);
  f.sessions[0].status='running'; f.sessions[0].turnState='running';
  f.route=()=>({kind:'choose',decision:'clarify',reason:'Several terminals exist.',text:'Which terminal should I use?'});
  const before=f.sessions.map(s=>JSON.stringify(s));
  const result=await f.run('Fix authentication in this project.');
  assert.equal(result.ok,true,JSON.stringify(result));
  assert.deepEqual(f.effects.map(e=>e.kind),['create_session','send_prompt']);
  assert.equal(f.effects[0].kindOfSession,'codex');
  assert.equal(f.effects[1].text,'Fix authentication in this project.');
  assert(f.reads.every(id=>id.startsWith('created-')));
  assert.deepEqual(f.sessions.slice(0,200).map(s=>JSON.stringify(s)),before);
  assert(f.contexts.every(c=>c.sessions.every(s=>s.id.startsWith('created-'))));
  assert(f.contexts.every(c=>c.agents.length===1));
  assert.equal(f.contexts.length, 0, 'A bound ordinary task handoff does not require a model to operate the composer.');
  assert.match(result.text, /pending|not.*confirmed|sent|running/i);
  assert.notEqual(result.text, 'done', 'Delegation must not sound like a completed coding task.');
  assert.equal(f.routes[0].sessions.length,0);
});

test('new worker request with no provider selects automatically and does not need a routing model', async t => {
  const f=await fixture(t,2);
  f.route=()=>assert.fail('Explicit new worker can be chosen deterministically');
  const result=await f.run('Start a fresh agent to inspect checkout.',{assignmentMode:'new'});
  assert.equal(result.ok,true,JSON.stringify(result)); assert.equal(f.effects[0].kindOfSession,'codex');
});

test('a wrong reuse proposal is redirected to a fresh agent before input reaches an unrelated conversation', async t => {
  const f=await fixture(t);
  const first=await f.run('Implement invoice rounding.'); await f.finish(first);
  const firstTarget=f.effects.find(e=>e.kind==='send_prompt').target.id, workItemId=f.task(first).workItemId;
  f.route=async (_context,api)=>{ await api.read({kind:'read_session',targetId:firstTarget}); return {kind:'choose',decision:'reuse',targetId:firstTarget,workItemId,reason:'Same project.'}; };
  f.affinity=input=>{ assert.match(input.existingObjective,/invoice/); assert.match(input.currentInstruction,/authentication/); return 'independent'; };
  const second=await f.run('Fix authentication expiry.'); assert.equal(second.ok,true,JSON.stringify(second));
  const sends=f.effects.filter(e=>e.kind==='send_prompt');
  assert.equal(sends.length,2); assert.notEqual(sends[0].target.id,sends[1].target.id);
  assert.equal(sends[1].text,'Fix authentication expiry.');
});

test('verified same-task continuation reuses its busy owner and leaves unrelated agents alone', async t => {
  const f=await fixture(t,2), first=await f.run('Fix authentication expiry.');
  const owner=f.sessions.find(s=>s.id===f.effects.find(e=>e.kind==='send_prompt').target.id);
  Object.assign(owner,{turnId:'active-auth-turn',turnStartedAt:Date.now(),status:'running',turnState:'running'}); await f.app.refresh();
  const created=f.effects.filter(e=>e.kind==='create_session').length;
  const next=await f.run('Also cover the expired refresh-token case.',{workItemId:f.task(first).workItemId},{replyToRequestId:first.requestId});
  assert.equal(next.ok,true,JSON.stringify(next));
  assert.equal(f.effects.filter(e=>e.kind==='create_session').length,created);
  assert(f.effects.filter(e=>e.kind==='send_prompt').every(e=>e.target.id===owner.id));
});

test('on-demand record and scoped note tools work through the actual model execution loop without terminal reads', async t => {
  const f=await fixture(t,2);
  const found=await f.app.dispatch({kind:'find_agents'}); const agentId=found.agents[0].agentId;
  let phase=0;
  f.answer=()=>phase++===0?{kind:'read_agent',agentId,sections:['work','activity']}:phase===2?
    {kind:'record_agent_note',agentId,noteKind:'finding',text:'Ownership has not been recorded for this agent.'}:
    {kind:'respond',text:'Recorded the finding.',responseTurn:'complete'};
  f.plans.push([]); const result=await f.app.send({text:'Inspect this agent and keep a short note.',origin:'text'});
  assert.equal(result.ok,true,JSON.stringify(result));
  assert.equal(f.reads.length,0); assert.equal(f.effects.length,0);
  const notes=await f.app.dispatch({kind:'read_agent',agentId,sections:['notes']});
  assert.equal(notes.sections.notes.total,1); assert.equal(notes.sections.notes.notes[0].provenance,'orchestrator-inference');
  await f.app.clearHistory();
  const cleared = await f.app.dispatch({kind:'read_agent',agentId,sections:['notes']});
  assert.equal(cleared.sections.notes.total,0);
});

test('admitted project stays fixed across a view switch and is captured in the task', async t => {
  const f = await fixture(t), other = path.join(f.root, 'other');
  f.projects = [{ path: f.root }, { path: other }];
  f.interpret = context => ({ goal: context.instruction, actions: [{ kind: 'delegate_task', text: context.instruction, cwd: context.workspaceContext.cwd }] });
  const pending = f.app.send({ text: 'Fix the login form in this project.', origin: 'text' });
  f.workspaceState = { ok: true, view: 'project', cwd: other };
  const result = await pending;
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(f.effects[0].cwd, f.root);
  assert.equal(f.task(result).projectPath, f.root);
  assert.equal(f.interpretations[0].workspaceContext.cwd, f.root);
});

test('an explicitly submitted project is honored, and a removed project cannot be substituted', async t => {
  const f = await fixture(t), other = path.join(f.root, 'other');
  f.projects = [{ path: f.root }, { path: other }];
  f.workspaceState = { ok: true, view: 'project', cwd: other };
  const first = await f.run('Inspect the selected project.', {}, { projectPath: f.root });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(f.interpretations[0].workspaceContext.cwd, f.root);
  await f.finish(first);
  f.projects = [{ path: other }];
  const count = f.effects.length;
  const next = await f.run('Fix the original project.', {}, { projectPath: f.root });
  assert.equal(next.ok, false);
  assert.match(next.error, /no longer available/i);
  assert.equal(f.effects.length, count);
});

test('automatic handoff never repeats a prompt whose delivery is uncertain', async t => {
  const f = await fixture(t);
  f.delivery = () => ({ ok: false, status: 'unknown', error: 'Transport disappeared after submission.' });
  const result = await f.run('Fix invoice rounding.');
  assert.equal(f.effects.filter(e => e.kind === 'send_prompt').length, 1);
  assert.notEqual(result.text, 'done');
  assert.match(JSON.stringify(result), /unconfirmed|unknown|uncertain|Transport/i);
});

test('an explicit standalone terminal does not inherit an unrelated visible project', async t => {
  const f = await fixture(t), selected = agent('standalone', { cwd: path.join(f.root, 'standalone-folder') });
  f.sessions.push(selected);
  f.workspaceState = { ok: true, view: 'project', cwd: path.join(f.root, 'not-an-open-project') };
  f.interpret = context => {
    assert.equal(context.workspaceContext, undefined);
    return { goal: context.instruction, actions: [{ kind: 'operate_terminal', targetIds: [selected.id], text: context.instruction }] };
  };
  const result = await f.app.send({ text: 'Review the code in this terminal.', origin: 'text', targetId: selected.id });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(f.task(result).projectPath, undefined);
  assert.deepEqual(f.effects.map(e => [e.kind, e.target?.id]), [['send_prompt', selected.id]]);
});

test('a proven-unsent refusal falls back through the existing executor and may recover once', async t => {
  const f = await fixture(t); let deliveries = 0;
  f.delivery = () => ++deliveries === 1 ? { ok: false, status: 'rejected', delivery: 'not-dispatched', error: 'Composer was temporarily unavailable.' } : { ok: true, status: 'written' };
  const result = await f.run('Fix invoice rounding.');
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(deliveries, 2);
  assert(f.contexts.length > 0, 'Recovery uses the existing model operator only after a proven-unsent refusal.');
});
