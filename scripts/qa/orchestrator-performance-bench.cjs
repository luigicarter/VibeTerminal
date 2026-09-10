'use strict';
// Offline benchmark of the real coordinator with a retained, synthetic history.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const inspector = require('node:inspector');
const { createOrchestrator } = require('../../backend/orchestrator.cjs');
const output = path.resolve(__dirname, '../../.tmp/orchestrator-performance', `${Date.now()}-${process.pid}`);
fs.mkdirSync(output, { recursive: true });
const stamp = Date.now(), messages = Array.from({ length: 1500 }, (_, i) => ({ id: `m-${i}`, role: i % 2 ? 'assistant' : 'user', text: 'Synthetic retained conversation. '.repeat(64), at: stamp - 1500 + i }));
const history = JSON.stringify({ messages, receipts: [], tasks: [] });
fs.writeFileSync(path.join(output, 'orchestrator-conversation.json'), history);
const sessions = Array.from({ length: 24 }, (_, i) => ({ id: `pane-${i}`, generation: `g-${i}`, launchToken: 1, kind: 'terminal', cwd: output, status: 'idle' }));
let publications = 0;
const relay = createOrchestrator({ userDataPath: output, getSessions: () => sessions, onChange: () => publications++, fetch: () => { throw Error('No network in the performance fixture.'); } });
const profile = new inspector.Session(); profile.connect();
const post = (method, params = {}) => new Promise((resolve, reject) => profile.post(method, params, (error, value) => error ? reject(error) : resolve(value)));
async function measure(name, count, operation) {
  const samples = [], initial = publications, started = performance.now();
  for (let i = 0; i < count; i++) { const before = performance.now(); await operation(i); samples.push(performance.now() - before); }
  samples.sort((a, b) => a - b);
  return { name, count, totalMs: performance.now() - started, medianMs: samples[Math.floor(count / 2)], p95Ms: samples[Math.floor(count * .95)], publications: publications - initial };
}
(async () => {
  try {
    await relay.refresh();
    assert.equal(relay.getState().messages.length, messages.length);
    await post('Profiler.enable'); await post('Profiler.start');
    const results = [];
    results.push(await measure('enabled checks', 200, () => assert.equal(relay.isEnabled ? relay.isEnabled() : relay.getState().enabled, false)));
    results.push(await measure('pending interaction checks', 100, () => assert.deepEqual(relay.getRequests ? relay.getRequests() : relay.getState().requests, [])));
    results.push(await measure('unchanged inventory refreshes', 40, async () => assert.equal((await relay.refresh()).ok, true)));
    results.push(await measure('changed inventory refreshes', 10, async i => { sessions[0] = { ...sessions[0], name: `Updated ${i}` }; assert.equal((await relay.refresh()).ok, true); }));
    const captured = await post('Profiler.stop'); fs.writeFileSync(path.join(output, 'main.cpuprofile'), JSON.stringify(captured.profile));
    assert.equal(relay.getState().messages.length, messages.length);
    assert.equal(relay.getState().sessions[0].name, 'Updated 9');
    await relay.dispose();
    const restored = JSON.parse(fs.readFileSync(path.join(output, 'orchestrator-conversation.json'), 'utf8')); assert.equal(restored.messages.length, messages.length);
    const report = { boundary: 'Offline synthetic 3 MB retained history and 24 panes. Measures local coordinator work, not model latency or real provider rendering.', historyBytes: Buffer.byteLength(history), narrowReaders: typeof relay.isEnabled === 'function', results, output };
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
  } finally { await relay.dispose(); profile.disconnect(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
