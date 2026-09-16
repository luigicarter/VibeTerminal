'use strict';
// The brain endpoint override. LINA_ORCHESTRATOR_API_BASE points the relay's own
// client at any OpenAI-compatible server, so a harness run can put a local model
// behind the same code path production uses. The server is a real one here: the
// relay reaches it over the wire with its own fetch, so what is verified is the
// URL every brain call is actually built from, not a stubbed adapter.
const test = require('node:test'), assert = require('node:assert/strict');
const http = require('node:http'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');

// The endpoint is read once at module load, so the server has to exist before
// the relay module does. Every test in this file shares that one server.
const requests = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    requests.push({ url: req.url, method: req.method, authorization: req.headers.authorization, body });
    const json = value => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (req.url.startsWith('/v1/models')) {
      // What a local server states about its models: an id, and nothing else.
      return json({ data: [{ id: 'qwen3.5:2b' }, { id: 'plain' }, { id: 'embed-only', architecture: { input_modalities: ['image'] } }] });
    }
    // Ollama's own model record, the only place the context window is stated.
    if (req.url === '/api/show' && req.method === 'POST') {
      if (JSON.parse(body).name !== 'qwen3.5:2b') { res.writeHead(404); return res.end('model not found'); }
      return json({ model_info: { 'general.architecture': 'qwen35', 'qwen35.context_length': 262144 } });
    }
    if (req.url === '/v1/key') { res.writeHead(404); return res.end('not found'); }
    if (req.url === '/v1/chat/completions') return json({ choices: [{ finish_reason: 'stop', message: { content: 'Hello.' } }], usage: { prompt_tokens: 10, completion_tokens: 2 } });
    res.writeHead(404); res.end('not found');
  });
});

let createOrchestrator;
test.before(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  process.env.LINA_ORCHESTRATOR_API_BASE = `http://127.0.0.1:${server.address().port}/v1`;
  ({ createOrchestrator } = require('../../backend/orchestrator.cjs'));
});
test.after(() => { delete process.env.LINA_ORCHESTRATOR_API_BASE; server.close(); });

async function relay(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-local-brain-'));
  const orchestrator = createOrchestrator({ userDataPath: root, secureStorage: { isEncryptionAvailable: () => false },
    getRoots: () => ({ documents: root, projects: [root] }), getSessions: () => [], getLaunchers: async () => [] });
  t.after(async () => { await orchestrator.cancel(); await orchestrator.dispose();
    assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, orchestrator };
}

test('every brain call goes to the overridden endpoint, with no key and no /key round', async t => {
  const { orchestrator } = await relay(t);
  requests.length = 0;
  const models = await orchestrator.models('brain');
  assert.deepEqual(models.map(model => model.id), ['qwen3.5:2b', 'plain'],
    'a model that states no supported_parameters is taken at its word; an image-only one is still excluded');
  assert.deepEqual(requests.map(item => item.url).sort(), ['/api/show', '/api/show', '/api/show', '/v1/models'],
    'each entry without a stated window is asked about once, through the endpoint root');
  assert.ok(requests.every(item => item.authorization === undefined), 'a local server needs no OpenRouter key');
  // The window Ollama states is the one the input budget uses; a server that
  // does not answer leaves the entry without one, so the default applies.
  assert.equal(models.find(model => model.id === 'qwen3.5:2b').contextLength, 262144);
  assert.equal(models.find(model => model.id === 'plain').contextLength, undefined);
});

test('validation skips the OpenRouter account route and still readies the selected model', async t => {
  const { orchestrator } = await relay(t);
  await orchestrator.configure({ model: 'qwen3.5:2b', sessionOnly: true });
  requests.length = 0;
  const result = await orchestrator.setEnabled(true);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(requests.some(item => item.url === '/v1/key'), false, 'the /key envelope is an OpenRouter fact, not a readiness one');
  assert.ok(requests.some(item => item.url === '/v1/models'));
  assert.equal(orchestrator.getState().ready, true);
});

test('a completion with no usage cost is accounted as zero rather than refused', async t => {
  const { orchestrator } = await relay(t);
  await orchestrator.configure({ model: 'qwen3.5:2b', sessionOnly: true });
  assert.equal((await orchestrator.setEnabled(true)).ok, true);
  const before = orchestrator.getUsage().brain;
  const result = await orchestrator.send({ text: 'Hello there, how are you doing today?', origin: 'text' });
  assert.equal(typeof result, 'object');
  assert.equal(Number.isFinite(orchestrator.getUsage().brain), true);
  assert.equal(orchestrator.getUsage().brain, before, 'a server that reports no cost adds none');
  assert.ok(requests.some(item => item.url === '/v1/chat/completions'), 'the completion reached the overridden endpoint');
});
