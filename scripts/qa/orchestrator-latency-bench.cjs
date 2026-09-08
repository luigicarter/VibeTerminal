'use strict';
// Offline behavioral benchmark: every provider and terminal is a disposable fixture.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const repo = path.resolve(__dirname, '../..');
const args = process.argv.slice(2);
const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const delayMs = Number(option('--delay-ms') || 50);
assert(Number.isFinite(delayMs) && delayMs >= 0 && delayMs <= 1000);
const baseline = option('--baseline');
const out = path.join(repo, '.tmp', `orchestrator-latency-bench-${Date.now()}-${process.pid}`);
fs.mkdirSync(out, { recursive: true });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
async function bounded(promise, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(label)), 5000); })]); }
  finally { clearTimeout(timer); }
}
const json = value => new Response(JSON.stringify(value));
let sequence = 0;
const tool = (action, name = 'workspace') => ({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: `fixture-${++sequence}`, type: 'function', function: { name, arguments: JSON.stringify(action) } }] } }] });
const reply = text => ({ choices: [{ finish_reason: 'stop', message: { content: text } }] });
const metadata = body => JSON.parse(body.messages.find(message => message.role === 'user').content);
const latest = body => JSON.parse(body.messages.filter(message => message.role === 'tool').at(-1).content);
const elapsed = start => Math.round((performance.now() - start) * 10) / 10;

async function fixture(source, label, scenario, script, onSpeak) {
  const root = path.join(out, label, scenario); fs.mkdirSync(root, { recursive: true });
  const sessions = ['a', 'b'].map(id => ({ id, name: `Fixture ${id}`, kind: 'codex', provider: 'codex', generation: 'g1', cwd: root, status: 'running' }));
  const effects = [], modelCalls = []; let start = 0, firstEffectMs = null;
  const app = require(path.join(source, 'backend/orchestrator.cjs')).createOrchestrator({
    userDataPath: root, secureStorage: { isEncryptionAvailable: () => false },
    getRoots: () => ({ documents: root, projects: [root] }), getSessions: () => sessions,
    readSession: async input => ({ ok: true, id: input.id, generation: 'g1', text: effects.length ? 'Verified the requested operation.' : 'Ready', sequence: 10 + effects.length, inputRevision: 2 }),
    dispatchAction: async action => {
      firstEffectMs ??= elapsed(start); effects.push({ kind: action.kind, targetId: action.targetId });
      if (action.kind === 'create_session') {
        sessions.push({ id: 'created', name: 'New terminal', generation: 'g1', kind: 'terminal', cwd: root, status: 'running' });
        return { ok: true, status: 'created', processState: 'running', id: 'created', generation: 'g1', target: { id: 'created', generation: 'g1' } };
      }
      return { ok: true, status: 'written' };
    }, onSpeak,
    fetch: async (url, options) => {
      assert(url.startsWith('https://openrouter.ai/api/v1/'), 'Unexpected fixture URL');
      if (url.endsWith('/key')) return json({ data: {} });
      if (url.endsWith('/models')) return json({ data: [{ id: 'fixture', context_length: 128000, supported_parameters: ['tools', 'tool_choice'] }] });
      assert(url.endsWith('/chat/completions'), 'Network is forbidden; no unhandled URL');
      const body = JSON.parse(options.body), stage = body.tools?.[0]?.function?.name === 'interpret_workspace' ? 'interpretation' : 'executor';
      modelCalls.push({ stage, startedMs: elapsed(start) });
      await sleep(delayMs);
      return json(script({ body, stage, root, effects }));
    }
  });
  assert.equal((await app.configure({ apiKey: 'fixture-only', sessionOnly: true, model: 'fixture' })).ok, true);
  assert.equal((await app.setEnabled(true)).ok, true);
  return { app, effects, modelCalls, begin() { start = performance.now(); }, metrics() { return { modelCalls: modelCalls.length, interpretationCalls: modelCalls.filter(c => c.stage === 'interpretation').length, executorCalls: modelCalls.filter(c => c.stage === 'executor').length, firstAcceptedEffectMs: firstEffectMs, elapsedMs: elapsed(start), effects, calls: modelCalls }; } };
}

async function actionScenario(source, label, kind) {
  let round = 0;
  const outcome = 'Verified the requested operation.';
  const f = await fixture(source, label, kind, ({ body, stage, root }) => {
    if (stage === 'interpretation') return tool(kind === 'create' ? { goal: 'Open a terminal.', executionMode: 'direct', actions: [{ kind: 'create_session', kindOfSession: 'terminal', cwd: root }] }
      : { goal: 'Review changes.', actions: [{ kind: 'operate_terminal', targetIds: ['a'], text: 'Review changes.', answerMode: 'delegated', permissionMode: 'none' }] }, 'interpret_workspace');
    round++;
    const grant = metadata(body).authorizedCommands.grants[0];
    if (kind === 'create') return round === 1 ? tool({ kind: 'create_session', grantId: grant.id }) : reply('Opened the terminal.');
    if (round === 1 || round === 3) return tool({ kind: 'read_session', targetId: 'a' });
    if (round === 2 || round === 4) {
      const observed = latest(body); assert(observed.observationToken);
      return tool({ kind: round === 2 ? 'send_prompt' : 'finish_terminal', grantId: grant.id, targetId: 'a', stepId: `step-${round}`, observationToken: observed.observationToken,
        ...(round === 2 ? { text: 'Review changes.', observationSequence: observed.observation.sequence, inputRevision: observed.observation.inputRevision } : { text: outcome, outcome: 'completed' }) });
    }
    assert.equal(round, 5, 'Unexpected executor repair/extra call'); return reply(outcome);
  });
  try {
    f.begin(); const result = await f.app.send({ text: kind === 'create' ? 'Open a terminal in this project.' : 'Use Fixture a to review changes.', origin: 'text' });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(f.effects.map(e => e.kind), [kind === 'create' ? 'create_session' : 'send_prompt']);
    if (kind === 'create') assert.match(result.text, /^Opened /);
    if (kind !== 'create') assert(result.text.includes(outcome), 'Observed finish text must survive any truthful pending-result qualification');
    return { ...f.metrics(), finalReply: result.text, semanticChecks: 'One accepted delivery; successful result; operator observed finish text preserved.' };
  } finally { await f.app.dispose(); }
}

async function heldAck(source, label) {
  const ack = gate(), speaking = gate(); let speechCount = 0;
  const f = await fixture(source, label, 'held-ack', ({ body, stage }) => {
    assert.equal(stage, 'interpretation'); const id = metadata(body).instruction.includes(' b') ? 'b' : 'a';
    return tool({ goal: 'Focus fixture.', executionMode: 'direct', actions: [{ kind: 'focus_session', targetIds: [id] }] }, 'interpret_workspace');
  }, async () => { if (++speechCount === 1) { speaking.release(); await ack.promise; } return { ok: true }; });
  let first, second;
  try {
    f.begin(); first = f.app.send({ text: 'Focus a', origin: 'voice' });
    await bounded(speaking.promise, 'First speech never reached ACK gate');
    second = f.app.send({ text: 'Focus b', origin: 'voice' });
    const deadline = performance.now() + Math.max(500, delayMs * 8);
    while (f.effects.length < 2 && performance.now() < deadline) await sleep(5);
    const secondEffectBeforeAck = f.effects.some(e => e.targetId === 'b');
    ack.release(); const results = await Promise.all([first, second]); results.forEach(r => assert.equal(r.ok, true, JSON.stringify(r)));
    assert.deepEqual(f.effects.map(e => e.targetId).sort(), ['a', 'b']);
    return { secondEffectBeforeAck, ...f.metrics() };
  } finally { ack.release(); await Promise.allSettled([first, second].filter(Boolean)); await f.app.dispose(); }
}

async function audioProbe(source) {
  const eof = gate(), first = gate(), chunks = []; let voice;
  voice = require(path.join(source, 'backend/voiceController.cjs')).createVoiceController({
    orchestrator: { getState: () => ({ enabled: true, tasks: [] }) }, getKey: () => 'fixture-only',
    fetch: async () => ({ ok: true, headers: new Headers({ 'content-type': 'audio/pcm;rate=24000;channels=1' }), body: (async function* () { yield Buffer.alloc(4800); first.release(); await eof.promise; yield Buffer.alloc(4800); })() }),
    onAudio: chunk => { chunks.push(chunk); if (chunk.done) queueMicrotask(() => voice.configure({ playbackDone: chunk.replyId })); }
  });
  try {
    await voice.setListening(true); const pending = voice.speak({ origin: 'voice', text: 'Completed.' });
    await bounded(first.promise, 'TTS never yielded first PCM chunk'); await new Promise(setImmediate);
    const playableChunksBeforeEof = chunks.filter(c => c.data?.length).length;
    eof.release(); const result = await pending; assert.equal(result.ok, true, JSON.stringify({ source, result }));
    assert.equal(chunks.reduce((n, c) => n + c.data.length, 0), 9600);
    return { playableChunksBeforeEof, totalBytes: 9600, completed: chunks.at(-1).done };
  } finally { eof.release(); voice.dispose(); }
}

async function heldDeliveryAck(source) {
  const ack = gate(), firstWrite = gate(), writes = [], updates = [];
  const sessions = Object.fromEntries(['a', 'b'].map(id => [id, { id, generation: 'g1', provider: 'codex', processState: 'running', agentProcessState: 'running', agentPid: 123, turnState: 'running', observation: 'observed' }]));
  const delivery = require(path.join(source, 'backend/orchestratorDelivery.cjs')).createOrchestratorDelivery({
    getSession: id => sessions[id], onUpdate: result => updates.push(result),
    write: async action => { writes.push(action.id); if (action.id === 'a') { firstWrite.release(); await ack.promise; } return { ok: true, status: 'written' }; }
  });
  let pump;
  try {
    for (const id of ['a', 'b']) assert.equal((await delivery.submit({ actionId: `fixture-${id}`, target: { id, generation: 'g1' }, text: 'Review changes.' })).status, 'queued');
    Object.values(sessions).forEach(session => { session.turnState = 'idle'; });
    pump = delivery.pump(); await bounded(firstWrite.promise, 'First queued delivery did not start');
    await new Promise(setImmediate); await new Promise(setImmediate);
    const writesBeforeFirstAck = [...writes];
    ack.release(); await pump;
    assert.deepEqual([...writes].sort(), ['a', 'b']);
    assert.equal(updates.filter(update => update.status === 'written').length, 2);
    return { writesBeforeFirstAck, finalWrites: writes, acceptedReceipts: 2 };
  } finally { ack.release(); if (pump) await pump; delivery.dispose(); }
}

(async () => {
  const report = { mode: 'offline scripted provider; elapsed timings are NOT live model latency', simulatedProviderDelayMs: delayMs, sources: {} };
  const file = path.join(out, 'report.json');
  for (const [label, source] of [...(baseline ? [['baseline', path.resolve(baseline)]] : []), ['current', repo]]) {
    const entry = report.sources[label] = { source };
    for (const kind of ['create', 'operator']) { entry[kind] = await actionScenario(source, label, kind); fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n'); }
    entry.heldAck = await heldAck(source, label); fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
    entry.heldDeliveryAck = await heldDeliveryAck(source); fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
    entry.audio = await audioProbe(source); fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
  }
  if (report.sources.baseline) {
    for (const kind of ['create', 'operator']) assert.deepEqual(report.sources.baseline[kind].effects, report.sources.current[kind].effects);
    report.modelCallSavings = Object.fromEntries(['create', 'operator'].map(kind => [kind, report.sources.baseline[kind].modelCalls - report.sources.current[kind].modelCalls]));
  }
  fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ report: file, ...report }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
