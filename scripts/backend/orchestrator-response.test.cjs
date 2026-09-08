'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { formatDirectOutcomes } = require('../../backend/orchestratorResponse.cjs');
const { createOrchestrator } = require('../../backend/orchestrator.cjs');
const sessions = [{ id: 'a', name: 'Codex', generation: 1, kind: 'codex', status: 'running' }];
const format = (kind, status, extra = {}) => formatDirectOutcomes([{ kind, status, ok: true, targetId: 'a', ...extra }], sessions);

test('creation reports the confirmed project folder instead of a shell executable title', () => {
  const cwd = 'C:\\Users\\ahmed\\Documents\\vibeTerminal';
  for (const name of ['C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', '/usr/bin/bash', 'C:/Windows/System32/cmd.exe', '\\\\server\\share\\shell.exe', '"C:\\Windows\\System32\\cmd.exe"', 'PowerShell', 'powershell.exe', 'Terminal - C:\\Windows\\cmd.exe']) {
    assert.equal(formatDirectOutcomes([{ kind: 'create_session', status: 'created', ok: true, targetId: 'a', processState: 'running', cwd, name }], [{ id: 'a', name, cwd }]), 'Opened the terminal in vibeTerminal.');
  }
});

test('creation preserves receipt labels and rejects replacement or unidentified inventory metadata', () => {
  const outcome = { kind: 'create_session', ok: true, status: 'created', processState: 'running', targetId: 'a' };
  const current = [{ id: 'a', generation: 'new', launchToken: 2, name: 'Replacement', cwd: '/replacement' }];
  assert.equal(formatDirectOutcomes([{ ...outcome, target: { id: 'a', generation: 'old', launchToken: 1 }, cwd: '/original', name: 'Codex', draftStaged: true }], current), 'Opened Codex in original. The prompt is saved as an unsent draft.');
  assert.equal(formatDirectOutcomes([outcome], current, [{ targets: current }]), 'Opened the terminal.');
  assert.equal(formatDirectOutcomes([{ ...outcome, target: { id: 'a', generation: 'old', launchToken: 1 } }], current), 'Opened the terminal.');
  assert.equal(formatDirectOutcomes([{ ...outcome, target: { id: 'a', generation: 'new', launchToken: 1 } }], current), 'Opened the terminal.');
  assert.equal(formatDirectOutcomes([{ ...outcome, target: { id: 'a', generation: 'new', launchToken: 2 } }], current), 'Opened Replacement in replacement.');
  assert.equal(format('create_session', 'starting'), 'The terminal was requested; startup is not confirmed yet.');
  assert.doesNotMatch(format('create_session', 'launch-failed', { ok: false }), /Opened/);
  assert.doesNotMatch(format('create_session', 'unconfirmed', { cwd: '/requested', processState: 'running' }), /Opened|requested/);
});

test('creation uses launch-matched provider labels and only a human project basename', () => {
  const outcome = { kind: 'create_session', ok: true, status: 'created', processState: 'running', target: { id: 'a', generation: 1, launchToken: 2 } };
  const inventory = [{ id: 'a', generation: 1, launchToken: 2, kind: 'codex', name: '"C:\\Windows\\powershell.exe"' }];
  for (const cwd of ['C:\\Users\\ahmed\\My Project\\', '/home/ahmed/My Project/', '"C:\\Users\\ahmed\\My Project"', '\\\\server\\share\\My Project']) {
    assert.equal(formatDirectOutcomes([{ ...outcome, cwd }], inventory), 'Opened Codex in My Project.');
  }
  for (const cwd of ['C:\\', '/', '', '.', '..']) {
    assert.equal(formatDirectOutcomes([{ ...outcome, cwd }], inventory), 'Opened Codex.');
  }
  assert.equal(formatDirectOutcomes([{ ...outcome, name: 'API bug fixes', cwd: '/projects/app' }], inventory), 'Opened API bug fixes in app.');
  assert.equal(formatDirectOutcomes([{ ...outcome, name: 'My Project', cwd: '/projects/My Project' }], inventory), 'Opened My Project.');
  assert.equal(formatDirectOutcomes([{ ...outcome, target: { id: 'a', generation: 2, launchToken: 2 } }], inventory), 'Opened the terminal.');
  for (const status of ['unconfirmed', 'launch-failed']) {
    const reply = formatDirectOutcomes([{ ...outcome, targetId: 'a', status, ok: false }], inventory);
    assert.doesNotMatch(reply, /C:|powershell|Opened/i);
  }
});

test('delivery wording distinguishes sent, queued, draft, and uncertain outcomes', () => {
  assert.equal(format('send_prompt', 'written'), 'Sent the prompt to Codex.');
  assert.match(format('send_prompt', 'queued'), /Queued.*hasn't been sent yet/);
  assert.match(format('send_prompt', 'staged'), /draft.*hasn't been sent/);
  assert.match(format('stage_draft', 'acknowledged'), /draft.*hasn't been sent/);
  for (const status of ['unknown', 'unconfirmed']) assert.match(format('send_prompt', status, { ok: false }), /couldn't confirm.*haven't sent it again/);
  assert.match(format('send_prompt', 'blocked', { ok: false, error: 'The terminal has a pending question.' }), /couldn't complete.*pending question/);
});

test('interrupt acknowledgement never claims a verified stop', () => {
  assert.equal(format('interrupt', 'written'), 'Requested a stop in Codex.');
  assert.equal(format('interrupt', 'stopped'), 'Codex stopped.');
  assert.equal(format('focus_session', 'acknowledged'), 'Switched to Codex.');
  assert.equal(formatDirectOutcomes([{ kind: 'navigate', ok: true, grantId: 'g' }], [], [{ id: 'g', args: { view: 'history' } }]), 'Opened History.');
});

test('direct focus uses the named outcome without an executor completion', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-response-'));
  const effects = [];
  const app = createOrchestrator({ userDataPath: dir, secureStorage: { isEncryptionAvailable: () => false },
    getSessions: async () => sessions, getRoots: async () => ({ documents: dir, projects: [] }),
    interpretIntent: async () => ({ goal: 'Focus Codex.', executionMode: 'direct', actions: [{ kind: 'focus_session', targetIds: ['a'] }] }),
    dispatchAction: async action => { effects.push(action); return { ok: true, status: 'written' }; },
    fetch: async url => {
      if (url.endsWith('/key')) return new Response(JSON.stringify({ data: {} }));
      if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'brain', supported_parameters: ['tools'] }] }));
      throw new Error('Direct execution must not call the completion model.');
    } });
  t.after(async () => { await app.dispose(); fs.rmSync(dir, { recursive: true, force: true }); });
  assert.equal((await app.configure({ apiKey: 'test-key', sessionOnly: true, model: 'brain' })).ok, true);
  assert.equal((await app.setEnabled(true)).ok, true);
  const result = await app.send({ text: 'Focus Codex', origin: 'text' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.text, 'Switched to Codex.');
  assert.deepEqual(effects.map(item => item.kind), ['focus_session']);
});
