const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const file = path.resolve(__dirname, '../../frontend/terminalRuntime.ts');
const mod = new Module(file, module);
mod._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const {runtimeSessionStatus, runtimeStatusLabel, runtimeDisplayTitle, runtimeTitleTooltip, runtimeElapsed} = mod.exports;
const state = {processState:'running', turnState:'unknown', observation:'observed', telemetryHealth:'available', children:[], childActivity:false, updatedAt:20000};
assert.equal(runtimeSessionStatus(state), 'idle');
assert.equal(runtimeStatusLabel(state), 'observing');
assert.equal(runtimeSessionStatus({...state,turnState:'response'}),'idle');
assert.equal(runtimeStatusLabel({...state,turnState:'response'}),'response available');
assert.equal(runtimeSessionStatus({...state,turnState:'running'}),'running');
assert.equal(runtimeStatusLabel({...state,turnState:'running'}),'working');
assert.equal(runtimeStatusLabel({...state,processState:'exited'}),'exited');
for (const activity of [{children:[{id:'child'}]}, {childActivity:true}]) {
  assert.equal(runtimeSessionStatus({...state,turnState:'completed',...activity}), 'running');
  assert.equal(runtimeStatusLabel({...state,turnState:'completed',...activity}), 'working');
  assert.equal(runtimeStatusLabel({...state,turnState:'waiting',...activity}), 'needs input');
}
assert.equal(runtimeSessionStatus({...state,turnState:'completed',telemetryHealth:'unavailable'}), 'idle');
assert.equal(runtimeStatusLabel({...state,turnState:'completed',telemetryHealth:'unavailable'}), 'unobserved');
assert.equal(runtimeSessionStatus({...state,turnState:'completed',observation:'provisional'}), 'idle');
assert.equal(runtimeStatusLabel({...state,turnState:'completed',observation:'provisional'}), 'response available');
assert.equal(runtimeStatusLabel({...state,provider:'terminal',observation:'unavailable'}), 'terminal open');
assert.equal(runtimeSessionStatus({...state,processState:'exited',turnState:'running'}), 'idle');
for (const turnState of ['running', 'waiting']) {
  const retained = {...state,provider:'claude',turnState,turnStartedAt:1000};
  assert.equal(runtimeSessionStatus({...retained,agentProcessState:'exited'}), 'idle');
  assert.equal(runtimeStatusLabel({...retained,agentProcessState:'exited'}), 'agent exited');
  assert.equal(runtimeSessionStatus({...retained,agentProcessState:'failed'}), 'failed');
  assert.equal(runtimeStatusLabel({...retained,agentProcessState:'failed'}), 'agent failed');
  assert.equal(runtimeElapsed({...retained,agentProcessState:'exited'},66000), undefined);
  assert.equal(runtimeElapsed({...retained,agentProcessState:'failed',turnEndedAt:20000},66000), '19s');
  assert.equal(runtimeStatusLabel({...retained,provider:'terminal',agentProcessState:'failed'}), 'terminal open');
  assert.equal(runtimeSessionStatus({...retained,provider:'terminal',agentProcessState:'failed'}), turnState);
}

assert.equal(runtimeDisplayTitle({...state,conversation:{title:' Named '},terminalTitle:'OSC'}, 'Fallback'), 'Named');
assert.equal(runtimeDisplayTitle({...state,conversation:{title:' '},terminalTitle:'OSC'}, 'Fallback'), 'OSC');
assert.equal(runtimeDisplayTitle(undefined, 'Fallback'), 'Fallback');
assert.equal(runtimeTitleTooltip({...state,conversation:{title:'Named'},terminalTitle:'OSC'}, 'Fallback'), 'Named\nTerminal: OSC');
assert.equal(runtimeTitleTooltip({...state,conversation:{title:'Named'},terminalTitle:'Named'}, 'Fallback'), 'Named');
assert.equal(runtimeElapsed({...state,turnState:'running',turnStartedAt:1000},66000),'1m 5s');
for (const turnState of ['completed', 'failed', 'interrupted', 'response']) {
  assert.equal(runtimeElapsed({...state,turnState,turnStartedAt:1000},66000), undefined);
  assert.equal(runtimeElapsed({...state,turnState,turnStartedAt:1000,turnEndedAt:20000},66000),'19s');
  assert.equal(runtimeElapsed({...state,turnState,turnStartedAt:1000,turnEndedAt:20000,updatedAt:120000},180000),'19s');
}
assert.equal(runtimeElapsed({...state,turnState:'completed',turnStartedAt:30000,turnEndedAt:20000},66000),'0s');
for (const pendingInput of ['submit', 'interrupt']) {
  for (const turnState of ['completed', 'running', 'waiting']) {
    const pending = {...state,provider:'codex',turnState,pendingInput,turnStartedAt:1000,children:[{id:'child'}],childActivity:true};
    assert.equal(runtimeSessionStatus(pending), 'idle');
    assert.equal(runtimeStatusLabel(pending), pendingInput === 'submit' ? 'awaiting activity' : 'interrupt requested');
    assert.equal(runtimeElapsed(pending,66000), undefined);
    assert.equal(runtimeSessionStatus({...pending,pendingInput:undefined}), turnState === 'waiting' ? 'waiting' : 'running');
    assert.equal(runtimeStatusLabel({...pending,pendingInput:undefined}), turnState === 'waiting' ? 'needs input' : 'working');
    assert.equal(runtimeStatusLabel({...pending,agentProcessState:'exited'}), 'agent exited');
    assert.equal(runtimeStatusLabel({...pending,processState:'failed'}), 'failed');
  }
}
const pane = fs.readFileSync(path.resolve(__dirname,'../../frontend/components/TerminalPane.tsx'),'utf8');
assert.match(pane, /function setStatus\(status: SessionStatus\) \{\s*if \(ownsRuntime\(\)\) return;/);
assert.match(pane, /function markActiveFromOutput\(\) \{\s*if \(ownsRuntime\(\)\) return;/);
assert.match(pane, /function scheduleThreadLookup\([^\n]+\) \{\s*if \(ownsRuntime\(\)\) return;/);
assert.match(pane, /if \(!ownsRuntime\(\) && !terminalExitedRef.current\)/);
console.log('terminal runtime UI helpers: passed');
