const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeIntent, authorizeIntentAction, claimGrant, INTENT_TOOL } = require('../../backend/orchestratorIntent.cjs');
const { createTaskScheduler } = require('../../backend/orchestratorTasks.cjs');
const { createSessionDirectory } = require('../../backend/orchestratorIntegration.cjs');
const { sessionSummary } = require('../../backend/orchestratorContext.cjs');
const session = { id:'s', generation:'g', kind:'codex', observation:'observed', turnId:'t', turnStartedAt:100, turnState:'running' };
function plan(extra={}) { return normalizeIntent({goal:'Tell me when done', actions:[{kind:'watch_terminal',targetIds:['s'],...extra}]}, {instruction:'Tell me when done',requestId:'r',sessions:[session]}); }
function fixture(mode='completion', live=session) { const tasks=createTaskScheduler(); const job=tasks.create({text:'Watch',origin:'text'}); const action={kind:'watch_terminal',actionId:'w',watchUntil:mode,watchTarget:{id:'s',generation:'g',turnId:'t',turnStartedAt:100}}; return {tasks,job,action,live}; }
test('watch grant freezes app turn and cannot authorize input or model turn selection',()=>{
 const p=plan(); assert.equal(p.access,'read-only'); assert.equal(p.grants[0].watchTargets[0].turnId,'t');
 const a=authorizeIntentAction({kind:'watch_terminal',targetId:'s'},p,[session]); assert.equal(a.watchUntil,'completion'); assert.equal(a.watchTarget.turnId,'t');
 assert.throws(()=>authorizeIntentAction({kind:'send_prompt',targetId:'s',text:'hello'},p,[session]));
 assert.throws(()=>plan({turnId:'forged'})); assert.throws(()=>plan({text:'send'})); assert.throws(()=>plan({watchUntil:'silence'}));
 claimGrant(a,p); assert.throws(()=>authorizeIntentAction({kind:'watch_terminal',targetId:'s'},p,[session]));
 const branch=INTENT_TOOL.function.parameters.properties.actions.items.anyOf.find(b=>b.properties.kind.enum[0]==='watch_terminal'); assert.ok(branch.properties.watchUntil); assert.equal(branch.properties.text,undefined);
 assert.equal(sessionSummary(session).turnId,'t');
});
test('watch observes exact work without lanes and cancellation retires only observation',async()=>{
 const {tasks,job,action}=fixture(); assert.equal(tasks.watch(job,action,session).status,'watching'); assert.deepEqual(job.lanes,[]);
 const independent=tasks.create({text:'Other',origin:'text'}); await tasks.ready(independent);
 tasks.cancel(job.task.requestId); assert.equal(job.waits[0].done,true); assert.equal(job.waits[0].delivered,false); assert.equal(job.task.waitingReason,undefined);
});
test('watch refuses changed and unknowable tasks and records exact completion end time',()=>{
 for(const live of [{...session,turnId:'new'}, {...session,generation:'new'}, {...session,kind:'terminal'}, {...session,completionAttribution:'ambiguous'}, {...session,turnState:'idle'}]) {const f=fixture(); assert.equal(f.tasks.watch(f.job,f.action,live).ok,false); assert.equal(f.job.waits.length,0);}
 const f=fixture(); f.tasks.watch(f.job,f.action,session); f.job.executionDone=true; f.tasks.update(f.job,{status:'waiting-results'}); f.tasks.reconcile([{...session,turnState:'completed',turnEndedAt:200}]); assert.equal(f.job.task.status,'finished'); assert.equal(f.job.waits[0].turnEndedAt,200);
 const g=fixture(); assert.equal(g.tasks.watch(g.job,g.action,{...session,turnState:'completed',turnEndedAt:200}).status,'already-completed');
});
test('ready watch waits through unknown and pending input and uses explicit ready state',()=>{
 const f=fixture('ready'); assert.equal(f.tasks.watch(f.job,f.action,{...session,turnId:undefined,turnState:'unknown'}).status,'watching');
 f.tasks.reconcile([{...session,turnState:'idle',pendingInput:true}]); assert.equal(f.job.waits[0].done,false);
 f.tasks.reconcile([{...session,turnState:'idle',pendingInput:false}]); assert.equal(f.job.waits[0].done,true); assert.equal(f.job.waits[0].observedState,'ready');
 const g=fixture('ready'); g.tasks.watch(g.job,g.action,{...session,kind:'terminal',turnState:'idle',observation:'unknown'}); assert.equal(g.job.waits[0].done,false);
});
test('watch cancellation preserves dispatched sibling and newer turns never replace completion watch',()=>{
 const f=fixture(); f.tasks.watch(f.job,f.action,session);
 f.tasks.reconcile([{...session,turnId:'new',turnState:'completed'}]); assert.equal(f.job.waits[0].done,false);
 f.tasks.track(f.job,{kind:'send_prompt',actionId:'sent',targetId:'s',generation:'g'},{ok:true,status:'written',turnId:'sent-turn'});
 f.tasks.cancel(f.job.task.requestId); assert.equal(f.job.waits[0].done,true); assert.equal(f.job.waits[1].done,false); assert.equal(f.job.waits[1].delivered,true); assert.match(f.job.task.waitingReason,/previously sent/);
});
test('watch continuation preserves original frozen turn instead of adopting newer work',()=>{
 const p=plan(); const previousCommand={instruction:'Tell me when done',requestId:'r',grants:p.grants,candidates:p.grants[0].targets,expiresAt:Date.now()+10000};
 const continued=normalizeIntent({goal:'Continue watch',actions:[{kind:'watch_terminal',sourceUserId:'r',targetIds:['s']}]},{instruction:'Continue',requestId:'r2',sessions:[{...session,turnId:'new'}],previousCommand});
 assert.equal(continued.grants[0].watchTargets[0].turnId,'t');
});
test('watch requires observed readiness and excludes stopped stale idle sessions',()=>{
 for(const patch of [{started:false},{processState:'exited'},{agentProcessState:'failed'},{status:'paused'},{status:'closed'}]) { const f=fixture('ready'); const result=f.tasks.watch(f.job,f.action,{...session,turnState:'idle',...patch}); assert.equal(result.ok,false); assert.equal(f.job.waits[0].failed,true); }
 const f=fixture('ready'); f.tasks.watch(f.job,f.action,{...session,observation:'unknown',turnState:'idle'}); assert.equal(f.job.waits[0].done,false);
 f.tasks.reconcile([{...session,turnState:'completed',turnEndedAt:200}]); assert.equal(f.job.waits[0].observedState,'ready'); assert.equal(f.job.waits[0].turnId,'t'); assert.equal(f.job.waits[0].turnEndedAt,200); assert.equal(f.job.waits[0].resultStatus,'completed');
 const g=fixture(); assert.equal(g.tasks.watch(g.job,g.action,{...session,observation:'unknown'}).ok,false);
 const h=fixture(); h.tasks.watch(h.job,h.action,session); h.tasks.reconcile([{...session,turnId:'newer'}]); assert.equal(h.job.waits[0].attributionAmbiguous,true); assert.equal(h.job.waits[0].turnId,'t'); assert.equal(h.job.waits[0].done,false);
});

test('readiness cannot finish while an independently observed interaction still needs input', () => {
 for (const kind of ['codex', 'fusion', 'openfusion']) {
  for (const patch of [{ status: 'waiting' }, { pendingInteraction: true }, { attention: { reason: 'question' } }, { attention: { reason: 'approval' } }]) {
   const f = fixture('ready');
   const blocked = { ...session, kind, turnState: 'idle', ...patch };
   assert.equal(f.tasks.watch(f.job, f.action, blocked).status, 'watching', `${kind}: ${JSON.stringify(patch)}`);
   f.tasks.reconcile([{ ...blocked, turnState: 'completed' }]);
   assert.equal(f.job.waits[0].done, false, 'a foreground completion does not resolve independent pending input');
   f.tasks.reconcile([{ ...session, kind, turnState: 'idle', status: 'idle' }]);
   assert.equal(f.job.waits[0].observedState, 'ready');
  }
 }
});

test('native startup metadata cannot finish readiness before the launched process is ready', t => {
 const { createTerminalRuntime } = require('../../backend/terminalRuntime.cjs');
 const runtime = createTerminalRuntime(); t.after(() => runtime.dispose());
 const directory = createSessionDirectory({ getRuntime: () => runtime });
 directory.updateUi([{ id: 's', kind: 'codex', cwd: process.cwd(), started: true, launchToken: 1 }]);
 const launch = runtime.beginLaunch({ id: 's', provider: 'codex', cwd: process.cwd(), launchToken: 1 });
 const emit = (type, extra = {}) => runtime.ingest({ id: 's', generation: launch.generation, type, ...extra });
 emit('agent-session', { phase: 'start', rootVerified: true, providerThreadId: 'native' });
 assert.equal(directory.get('s').turnState, 'idle'); assert.equal(directory.get('s').observation, 'observed');
 const f = fixture('ready'); f.action.watchTarget.generation = launch.generation;
 assert.equal(f.tasks.watch(f.job, f.action, directory.get('s')).status, 'watching');
 emit('created', { pid: 42 }); f.tasks.reconcile(directory.list());
 assert.equal(directory.get('s').processState, 'running'); assert.equal(directory.get('s').agentProcessState, 'unknown');
 assert.equal(f.job.waits[0].done, false, 'Running PTY alone cannot prove agent readiness');
 emit('agent-process', { phase: 'start', processId: 'root', pid: 43 });
 f.tasks.reconcile(directory.list()); assert.equal(f.job.waits[0].observedState, 'ready');
});

for (const patch of [{ launchState: 'pending' }, { processState: 'starting' }, { agentProcessState: 'starting' }, { processState: 'unknown' }, { agentProcessState: 'unknown' }, { status: 'starting' }, { engineReady: false }])
 test(`readiness waits through explicit startup evidence ${JSON.stringify(patch)}`, () => {
  const f = fixture('ready');
  assert.equal(f.tasks.watch(f.job, f.action, { ...session, turnState: 'idle', ...patch }).status, 'watching');
  f.tasks.reconcile([{ ...session, turnState: 'idle', processState: 'running', agentProcessState: 'running', launchState: 'ready', engineReady: true, status: 'idle' }]);
  assert.equal(f.job.waits[0].observedState, 'ready');
 });

test('plain shell readiness does not require an agent process and legacy absent fields remain supported', () => {
 for (const live of [...['unknown', 'exited', 'failed'].map(agentProcessState => ({ ...session, kind: 'terminal', provider: 'terminal', processState: 'running', agentProcessState, turnState: 'idle' })), { ...session, turnState: 'idle' }]) {
  const f = fixture('ready'); assert.equal(f.tasks.watch(f.job, f.action, live).status, 'ready');
 }
});

for (const kind of ['codex', 'fusion', 'openfusion']) for (const patch of [{ processState: 'failed' }, { agentProcessState: 'exited' }, { status: 'failed' }, { status: 'exited' }])
 test(`${kind} failed startup cannot report an idle pane ready ${JSON.stringify(patch)}`, () => {
  const f = fixture('ready');
  const result = f.tasks.watch(f.job, f.action, { ...session, kind, turnState: 'idle', ...patch });
  assert.equal(result.status, 'blocked'); assert.equal(f.job.waits[0].failed, true);
 });

for (const kind of ['fusion', 'openfusion']) for (const registerAfterFollowup of [false, true]) {
 test(`${kind} readiness watch registered ${registerAfterFollowup ? 'after' : 'before'} a followup finishes without attributing its result`,()=>{
  let time = 100;
  const directory = createSessionDirectory({ getRuntime: () => ({ listSnapshots: () => [] }), now: () => ++time });
  directory.outgoing(kind, { type: 'start', payload: { id: 's', cwd: 'C:/fixture' } });
  const generation = directory.get('s').generation;
  const ingest = type => directory.ingest(kind, { type, id: 's', generation });
  ingest('engine-ready');
  directory.outgoing(kind, { type: 'input', payload: { id: 's', actionId: 'original' } });
  ingest('turn-start');
  const running = directory.get('s');
  const tasks = createTaskScheduler({ now: () => ++time });
  const action = { kind: 'watch_terminal', actionId: 'watch', watchTarget: {
   id: 's', generation, turnId: running.turnId, turnStartedAt: running.turnStartedAt
  } };
  const completion = tasks.create({ text: 'Watch the original task', origin: 'text' });
  assert.equal(tasks.watch(completion, action, running).status, 'watching');
  const readiness = tasks.create({ text: 'Tell me when ready', origin: 'text' });
  const register = () => {
   assert.equal(tasks.watch(readiness, { ...action, watchUntil: 'ready' }, directory.get('s')).status, 'watching');
   readiness.executionDone = true;
   tasks.update(readiness, { status: 'waiting-results' });
  };
  if (!registerAfterFollowup) register();
  directory.outgoing(kind, { type: 'steer', payload: { id: 's', text: 'Also check the tests' } });
  if (registerAfterFollowup) register();
  tasks.reconcile(directory.list());
  assert.equal(readiness.waits[0].done, false, 'active work is not ready');
  ingest('result');
  const ended = directory.get('s');
  assert.equal(ended.completionAttribution, 'ambiguous');
  assert.equal(ended.turnState, 'completed');
  assert.equal(ended.pendingInput, false);
  tasks.reconcile(directory.list());
  assert.equal(readiness.task.status, 'finished');
  assert.equal(readiness.waits[0].observedState, 'ready');
  assert.equal(readiness.waits[0].attributionAmbiguous, false);
  assert.equal(readiness.waits[0].turnId, undefined, 'readiness does not attribute an ambiguous result');
  assert.equal(readiness.waits[0].resultStatus, undefined);
  assert.equal(readiness.waits[0].turnEndedAt, undefined);
  assert.equal(completion.waits[0].done, false, 'original task completion remains unverified');
  const late = tasks.create({ text: 'Is it ready now?', origin: 'text' });
  assert.equal(tasks.watch(late, { ...action, watchUntil: 'ready' }, ended).status, 'ready');
  const unverified = tasks.create({ text: 'Was that task completed?', origin: 'text' });
  assert.equal(tasks.watch(unverified, action, ended).status, 'unverified');
 });
}

test('ambiguous readiness watches still require observed readiness and reject stopped terminals',()=>{
 const ambiguous = { ...session, completionAttribution: 'ambiguous' };
 for (const patch of [{ pendingInput: true }, { childActivity: true }, { observation: 'unknown' }]) {
  const f = fixture('ready');
  assert.equal(f.tasks.watch(f.job, f.action, { ...ambiguous, turnState: 'completed', ...patch }).status, 'watching');
  assert.equal(f.job.waits[0].done, false);
  f.tasks.reconcile([{ ...ambiguous, turnState: 'idle' }]);
  assert.equal(f.job.waits[0].observedState, 'ready');
 }
 for (const patch of [{ processState: 'exited' }, { agentProcessState: 'failed' }, { started: false }, { generation: 'replacement' }]) {
  const f = fixture('ready');
  f.tasks.watch(f.job, f.action, ambiguous);
  f.tasks.reconcile([{ ...ambiguous, turnState: 'completed', ...patch }]);
  assert.equal(f.job.waits[0].done, true);
  assert.equal(f.job.waits[0].failed, true);
 }
});
