'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createOrchestrator } = require('../../backend/orchestrator.cjs');
const { createVoiceController } = require('../../backend/voiceController.cjs');
const { interpretTestIntent } = require('./orchestrator-test-intent.cjs');
const reply = content => ({ choices: [{ message: { content } }] });
const tool = (args, id = 'tool-1') => ({ choices: [{ message: { tool_calls: [{ id, type: 'function', function: { name: 'workspace', arguments: typeof args === 'string' ? args : JSON.stringify(args) } }] } }] });
function checkTiming(entry) {
  const base = ['time', 'event', 'stage', 'requestId', 'origin', 'model', 'elapsedMs'];
  const stages = {
    routing_started: [], routing_acquired: [], routing: ['status'], execution: ['status'], executor_reply: ['status'], final_text: ['status'],
    model_started: ['modelCallId', 'category'], model_complete: ['modelCallId', 'category', 'status', 'totalMs', 'httpStatus'],
    tool_started: ['toolCallId', 'actionKind', 'targetId'], tool_complete: ['toolCallId', 'actionId', 'actionKind', 'targetId', 'generation', 'status', 'totalMs'],
    first_effect: ['actionKind', 'targetId', 'generation', 'status']
  };
  assert(stages[entry.stage], `Unexpected timing stage: ${entry.stage}`);
  assert(Object.keys(entry).every(key => [...base, ...stages[entry.stage]].includes(key)));
  assert.equal(typeof entry.requestId, 'string'); assert.equal(typeof entry.elapsedMs, 'number'); assert(entry.elapsedMs >= 0);
  if (entry.stage.startsWith('model_')) assert.equal(typeof entry.modelCallId, 'string');
  assert.doesNotMatch(JSON.stringify(entry), /PRIVATE_|private-configured-key|Can you prompt|random one/);
}
function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-diagnostic-integration-'));
  const actions = [], requests = [], responses = [];
  const instance = createOrchestrator({ userDataPath: root, interpretIntent: interpretTestIntent,
    getSessions: () => Array.from({ length: 6 }, (_, index) => ({ id: `vyp-${index + 1}`, name: `Codex ${index + 1}`, kind: 'codex', generation: 3, projectName: 'vibeTerminal', cwd: root, status: 'idle' })),
    getRoots: () => ({ projects: [{ name: 'vibeTerminal', path: root }] }),
    dispatchAction: async action => { actions.push(action); return { ok: true, status: 'delivered' }; },
    fetch: async (url, options) => {
      if (url.endsWith('/key')) return { ok: true, json: async () => ({ data: {} }) };
      if (url.includes('/models')) return { ok: true, json: async () => ({ data: [{ id: 'test-brain', supported_parameters: ['tools'] }] }) };
      requests.push(JSON.parse(options.body));
      const response = responses.shift() || reply('Ready.');
      return typeof response === 'function' ? response(options) : { ok: true, json: async () => response };
    }, ...overrides });
  t.after(async () => { await instance.dispose(); assert(path.resolve(root).startsWith(path.join(os.tmpdir(), 'vibe-diagnostic-integration-'))); fs.rmSync(root, { recursive: true, force: true }); });
  const filename = path.join(root, 'logs', 'orchestrator-errors.jsonl');
  return { instance, actions, requests, responses, filename, root,
    read: async () => { await instance.flushDiagnostics(); const entries = fs.existsSync(filename) ? fs.readFileSync(filename, 'utf8').trim().split('\n').map(JSON.parse) : []; for (const entry of entries.filter(entry => entry.event === 'request_stage')) checkTiming(entry); return entries.filter(entry => entry.event !== 'request_stage'); },
    ready: async () => { assert.equal((await instance.configure({ apiKey: 'private-configured-key', sessionOnly: true, model: 'test-brain' })).ok, true); assert.equal((await instance.setEnabled(true)).ok, true); } };
}

test('unbound selection rejection keeps private diagnostics and a bounded later action receipt', async t => {
  const f = fixture(t); await f.ready();
  f.responses.push(reply('Which terminal?'));
  await f.instance.send({ text: 'Bye. Can you prompt one of them to do a review? on the last changes.', origin: 'text' });
  f.responses.push(tool({ kind: 'send_prompt', targetId: 'vyp-1', text: 'PRIVATE_PROMPT_SENTINEL' }), reply('I could not send that request.'));
  const failed = await f.instance.send({ text: "They're empty right now, so just pick a random one.", origin: 'text' });
  assert.equal(failed.ok, false); assert.equal(failed.text, "I couldn't complete the request for Codex 1."); assert.equal(f.actions.length, 0);
  assert.doesNotMatch(failed.text, /grant|PRIVATE_PROMPT_SENTINEL/);
  const [entry] = await f.read();
  assert.equal(entry.error.message, 'This effect needs one matching user command grant.');
  assert.equal(entry.event, 'action_error'); assert.equal(entry.actionKind, 'send_prompt'); assert.equal(entry.targetId, 'vyp-1'); assert.equal(entry.generation, 3);
  assert.equal(entry.model, 'test-brain'); assert.equal(entry.toolCallId, 'tool-1'); assert(entry.requestId); assert.equal(entry.receiptId, f.instance.getState().receipts[0].id);
  f.responses.push(reply('The request failed.')); await f.instance.send({ text: 'What happened?', origin: 'text' });
  const nextContext = JSON.parse(f.requests.at(-1).messages[1].content);
  assert.equal(nextContext.latestAction.id, entry.receiptId);
  assert.equal(nextContext.latestAction.text, entry.error.message);
  assert(!JSON.stringify(f.requests.at(-1)).includes(entry.error.stack));
  assert(!JSON.stringify(f.instance.getState()).includes('orchestrator-errors.jsonl'));
  assert.doesNotMatch(fs.readFileSync(f.filename, 'utf8'), /PRIVATE_PROMPT_SENTINEL|private-configured-key|Can you prompt|random one/);
  await f.instance.dispose(); assert.equal((await f.read())[0].error.message, entry.error.message);
});

test('adapter failures retain their reason and are logged once with safe terminal identity', async t => {
  const f = fixture(t, { dispatchAction: async () => ({ ok: false, status: 'unknown', error: 'No acknowledgment; private-configured-key; Bearer another-secret' }) });
  await f.ready();
  const result = await f.instance.dispatch({ kind: 'send_prompt', target: { id: 'vyp-2', generation: 3 }, text: 'PRIVATE_REVIEW_PROMPT' });
  assert.equal(result.status, 'unknown'); const entries = await f.read(); assert.equal(entries.length, 1);
  assert.equal(entries[0].targetId, 'vyp-2'); assert(entries[0].actionId); assert.match(entries[0].error.message, /No acknowledgment/);
  assert.doesNotMatch(fs.readFileSync(f.filename, 'utf8'), /PRIVATE_REVIEW_PROMPT|private-configured-key|another-secret/);
});

test('queued delivery failure retains the originating request and tool identifiers', async t => {
  let sent;
  const f = fixture(t, { dispatchAction: async action => { sent = action; return { ok: true, status: 'queued' }; } }); await f.ready();
  f.responses.push(tool({ kind: 'send_prompt', targetId: 'vyp-1' }, 'queued-tool'), reply('Queued.'));
  await f.instance.send({ text: 'Tell Codex 1 to review the last changes.', origin: 'text' });
  assert.deepEqual(await f.read(), []);
  const timings = fs.readFileSync(f.filename, 'utf8').trim().split('\n').map(JSON.parse).filter(entry => entry.event === 'request_stage');
  assert(timings.some(entry => entry.stage === 'routing' && entry.status === 'complete'));
  assert(timings.some(entry => entry.stage === 'execution' && entry.status === 'started'));
  assert.equal(new Set(timings.map(entry => entry.requestId)).size, 1);
  f.instance.recordDelivery({ actionId: sent.actionId, id: 'vyp-1', generation: 3, ok: false, status: 'not-running' });
  const [entry] = await f.read(); assert.equal(entry.stage, 'delivery'); assert.equal(entry.toolCallId, 'queued-tool'); assert(entry.requestId); assert.equal(entry.actionId, sent.actionId); assert.equal(entry.error.message, 'Action not-running.');
});

test('an adapter exception retains generated action and resolved target identity exactly once', async t => {
  let attempted;
  const f = fixture(t, { dispatchAction: async action => { attempted = action; throw Object.assign(new Error('PTY write failed'), { code: 'EPIPE' }); } }); await f.ready();
  f.responses.push(tool({ kind: 'send_prompt' }), reply('Unable to send.'));
  await f.instance.send({ text: 'Tell Codex 1 to review the last changes.', origin: 'text' });
  const entries = await f.read(); assert.equal(entries.length, 1);
  assert.equal(entries[0].actionId, attempted.actionId); assert.equal(entries[0].targetId, 'vyp-1'); assert.equal(entries[0].generation, 3);
  assert.equal(entries[0].error.code, 'EPIPE'); assert.equal(entries[0].error.message, 'PTY write failed'); assert(entries[0].error.stack);
});

test('provider failures keep classified HTTP details and exclude response bodies', async t => {
  const f = fixture(t); await f.ready();
  f.responses.push(() => ({ ok: false, status: 503, json: async () => ({ error: { message: 'PRIVATE_PROVIDER_BODY private-configured-key' } }) }));
  assert.equal((await f.instance.send({ text: 'PRIVATE_USER_COMMAND', origin: 'text' })).ok, false);
  const [entry] = await f.read(); assert.equal(entry.stage, 'brain'); assert.equal(entry.httpStatus, 503); assert.equal(entry.category, 'upstream'); assert(entry.error.stack);
  assert.doesNotMatch(fs.readFileSync(f.filename, 'utf8'), /PRIVATE_PROVIDER_BODY|PRIVATE_USER_COMMAND|private-configured-key/);
});

test('malformed tool JSON cannot copy its argument payload into diagnostics', async t => {
  const f = fixture(t); await f.ready();
  f.responses.push(tool('{"text":"PRIVATE_ARGUMENT_TEXT",broken}'), reply('That action failed.'));
  await f.instance.send({ text: 'Tell Codex 1 to review.', origin: 'text' });
  const [entry] = await f.read(); assert.equal(entry.error.name, 'SyntaxError'); assert.equal(entry.error.message, 'Invalid workspace tool arguments JSON.');
  assert.doesNotMatch(fs.readFileSync(f.filename, 'utf8'), /PRIVATE_ARGUMENT_TEXT/);
});

test('voice diagnostics reach the same private file without entering relay messages', async t => {
  const f = fixture(t); await f.ready();
  const voice = createVoiceController({ orchestrator: f.instance, getKey: () => f.instance.getKey() }); t.after(() => voice.dispose());
  voice.configure({ microphoneError: 'Microphone device unavailable' });
  const [entry] = await f.read(); assert.equal(entry.event, 'voice_error'); assert.equal(entry.stage, 'microphone'); assert.equal(entry.error.message, 'Microphone device unavailable');
  assert.equal(f.instance.getState().messages.length, 0);
});

test('spoken replies carry the same diagnostic request ID as the failed action', async t => {
  const spoken = [];
  const f = fixture(t, { onSpeak: async event => { spoken.push(event); return { ok: true }; } }); await f.ready();
  f.responses.push(tool({ kind: 'send_prompt', targetId: 'vyp-1' }), reply('Unable to send.'));
  const result = await f.instance.send({ text: 'pick a random one', origin: 'voice' });
  const [entry] = await f.read(); assert.equal(spoken.length, 1); assert.equal(spoken[0].requestId, entry.requestId);
  assert.equal(spoken[0].text, result.text); assert.equal(result.text, "I couldn't complete the request for Codex 1.");
  assert.equal(f.actions.length, 0);
});

test('cancelled requests stay out of error logs and an unwritable log cannot prevent a response', async t => {
  let enter, release; const entered = new Promise(resolve => { enter = resolve; });
  const f = fixture(t); await f.ready();
  f.responses.push(() => { enter(); return new Promise(resolve => { release = () => resolve({ ok: false, status: 503, json: async () => ({}) }); }); });
  const pending = f.instance.send({ text: 'hello', origin: 'text' }); await entered; await f.instance.cancel(); release();
  assert.equal((await pending).status, 'cancelled'); assert.deepEqual(await f.read(), []);
  fs.rmSync(path.join(f.root, 'logs'), { recursive: true, force: true });
  fs.writeFileSync(path.join(f.root, 'logs'), 'This fixture prevents directory creation.');
  f.responses.push(tool({ kind: 'send_prompt', targetId: 'vyp-1' }), reply('Unable to send.'));
  const result = await f.instance.send({ text: 'pick a random one', origin: 'text' });
  assert.equal(result.ok, false); assert.equal(result.text, "I couldn't complete the request for Codex 1.");
  assert.equal(f.actions.length, 0);
  await assert.doesNotReject(f.instance.flushDiagnostics()); assert.equal(fs.existsSync(f.filename), false);
});
