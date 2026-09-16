'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createSettings } = require('../../backend/orchestratorSettings.cjs');
const { TTS_MODEL, TTS_VOICE } = require('../../shared/voiceConfig.cjs');
function fixture(t, data) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-settings-migration-'));
  t.after(() => { assert(path.resolve(root).startsWith(path.join(os.tmpdir(), 'vibe-settings-migration-'))); fs.rmSync(root, { recursive: true, force: true }); });
  const filename = path.join(root, 'orchestrator-settings.json');
  if (data) fs.writeFileSync(filename, JSON.stringify(data));
  return { filename, store: createSettings({ userDataPath: root }) };
}
test('legacy unavailable speech default migrates without touching encrypted credentials or preferences', t => {
  const disk = { settings: { model: 'user/brain', ttsModel: 'openai/gpt-4o-mini-tts-2025-12-15', voice: 'alloy', microphoneId: 'saved-device' }, encryptedKey: 'opaque-fixture-ciphertext', preferences: [{ id: 'p', text: 'Concise replies' }] };
  const { store, filename } = fixture(t, disk);
  const next = store.getSettings();
  assert.equal(next.ttsModel, TTS_MODEL); assert.equal(next.voice, TTS_VOICE);
  assert.equal(next.microphoneId, 'saved-device'); assert.equal(next.model, 'user/brain');
  assert.equal(next.enabledOnLaunch, false); assert.equal(next.monitoringEnabled, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(filename, 'utf8')), disk, 'opening settings does not rewrite the credential file');
  store.configure({ enabledOnLaunch: true });
  const saved = JSON.parse(fs.readFileSync(filename, 'utf8'));
  assert.equal(saved.encryptedKey, disk.encryptedKey); assert.deepEqual(saved.preferences, disk.preferences);
  assert.equal(saved.settings.ttsModel, TTS_MODEL); assert.equal(saved.settings.enabledOnLaunch, true);
});
test('legacy default-on spare settings migrate to off until explicitly opted in', t => {
  const disk = { settings: { spareAgent: true }, encryptedKey: 'untouched' };
  const { store, filename } = fixture(t, disk);
  assert.equal(store.getSettings().spareAgent, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(filename, 'utf8')), disk);
  store.configure({ spareAgent: true });
  assert.equal(createSettings({ userDataPath: path.dirname(filename) }).getSettings().spareAgent, true);
});
test('custom speech choices remain visible and invalid startup/reporting flags are atomic', t => {
  const { store, filename } = fixture(t, { settings: { ttsModel: 'custom/speech', voice: 'custom-voice' } });
  assert.equal(store.getSettings().ttsModel, 'custom/speech'); assert.equal(store.getSettings().voice, 'custom-voice');
  const before = fs.readFileSync(filename, 'utf8');
  assert.throws(() => store.configure({ model: 'changed', enabledOnLaunch: 'true' }), /Invalid enabledOnLaunch/);
  assert.throws(() => store.configure({ monitoringEnabled: 1 }), /Invalid monitoringEnabled/);
  assert.equal(fs.readFileSync(filename, 'utf8'), before); assert.equal(store.getSettings().model, '');
});
test('a malformed saved preferences shape cannot reach list, map or push callers', t => {
  const { store, filename } = fixture(t, { settings: {}, preferences: {}, encryptedKey: '' });
  assert.deepEqual(store.getPreferences(), []);
  const saved = store.preferences({ operation: 'remember', text: 'Concise replies' });
  assert.equal(saved.length, 1); assert.equal(saved[0].text, 'Concise replies');
  const disk = JSON.parse(fs.readFileSync(filename, 'utf8'));
  assert.ok(Array.isArray(disk.preferences)); assert.equal(disk.preferences.length, 1);
  assert.deepEqual(store.preferences({ operation: 'forget', id: saved[0].id }), []);
});
test('partly malformed preference entries are dropped instead of poisoning the list', t => {
  const { store, filename } = fixture(t, { settings: {}, preferences: [{ id: 'a', text: 'Keep me' }, { bogus: 1 }, 's', null, { id: 2, text: 'numeric id' }], encryptedKey: '' });
  assert.deepEqual(store.getPreferences(), [{ id: 'a', text: 'Keep me' }]);
  store.configure({ language: 'en' });
  assert.deepEqual(JSON.parse(fs.readFileSync(filename, 'utf8')).preferences, [{ id: 'a', text: 'Keep me' }]);
});

test('the optional fallback brain is empty by default, round-trips, and is validated like the model', t => {
  const { store, filename } = fixture(t, { settings: { model: 'user/brain' }, preferences: [] });
  assert.equal(store.getSettings().fallbackModel, '');
  store.configure({ fallbackModel: '  standby/brain  ' });
  assert.equal(store.getSettings().fallbackModel, 'standby/brain');
  assert.equal(createSettings({ userDataPath: path.dirname(filename) }).getSettings().fallbackModel, 'standby/brain');
  const before = fs.readFileSync(filename, 'utf8');
  assert.throws(() => store.configure({ fallbackModel: 7 }), /Invalid fallbackModel/);
  assert.throws(() => store.configure({ model: 'changed', fallbackModel: 'x'.repeat(513) }), /Invalid fallbackModel/);
  assert.equal(fs.readFileSync(filename, 'utf8'), before, 'a rejected fallback must not half-apply the patch');
  assert.equal(store.getSettings().model, 'user/brain');
  store.configure({ fallbackModel: '' });
  assert.equal(store.getSettings().fallbackModel, '');
});

test('the optional interpretation model is empty by default, round-trips, and is validated like the model', t => {
  const { store, filename } = fixture(t, { settings: { model: 'user/brain' }, preferences: [] });
  assert.equal(store.getSettings().interpretationModel, '');
  store.configure({ interpretationModel: '  fast/interpreter  ' });
  assert.equal(store.getSettings().interpretationModel, 'fast/interpreter');
  assert.equal(createSettings({ userDataPath: path.dirname(filename) }).getSettings().interpretationModel, 'fast/interpreter');
  const before = fs.readFileSync(filename, 'utf8');
  assert.throws(() => store.configure({ interpretationModel: 7 }), /Invalid interpretationModel/);
  assert.throws(() => store.configure({ model: 'changed', interpretationModel: 'x'.repeat(513) }), /Invalid interpretationModel/);
  assert.equal(fs.readFileSync(filename, 'utf8'), before, 'a rejected interpretation model must not half-apply the patch');
  assert.equal(store.getSettings().model, 'user/brain');
  store.configure({ interpretationModel: '' });
  assert.equal(store.getSettings().interpretationModel, '');
});

test('hands-free is opt-in, persists explicitly, and rejects malformed settings atomically', t => {
  const { store, filename } = fixture(t, { settings: { handsFreeEnabled: 'true', microphoneId: 'saved-device' }, preferences: [] });
  assert.equal(store.getSettings().handsFreeEnabled, false);
  store.configure({ handsFreeEnabled: true });
  assert.equal(createSettings({ userDataPath: path.dirname(filename) }).getSettings().handsFreeEnabled, true);
  const before = fs.readFileSync(filename, 'utf8');
  assert.throws(() => store.configure({ microphoneId: 'changed', handsFreeEnabled: 1 }), /Invalid handsFreeEnabled/);
  assert.equal(fs.readFileSync(filename, 'utf8'), before);
  assert.equal(store.getSettings().microphoneId, 'saved-device');
});
