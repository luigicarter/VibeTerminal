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
test('custom speech choices remain visible and invalid startup/reporting flags are atomic', t => {
  const { store, filename } = fixture(t, { settings: { ttsModel: 'custom/speech', voice: 'custom-voice' } });
  assert.equal(store.getSettings().ttsModel, 'custom/speech'); assert.equal(store.getSettings().voice, 'custom-voice');
  const before = fs.readFileSync(filename, 'utf8');
  assert.throws(() => store.configure({ model: 'changed', enabledOnLaunch: 'true' }), /Invalid enabledOnLaunch/);
  assert.throws(() => store.configure({ monitoringEnabled: 1 }), /Invalid monitoringEnabled/);
  assert.equal(fs.readFileSync(filename, 'utf8'), before); assert.equal(store.getSettings().model, '');
});
