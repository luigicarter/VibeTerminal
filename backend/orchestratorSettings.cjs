'use strict';
const fs = require('node:fs');
const path = require('node:path');
const DEFAULTS = { model: '', sttModel: 'openai/whisper-large-v3-turbo', ttsModel: 'openai/gpt-4o-mini-tts-2025-12-15', voice: 'alloy', language: 'en', monitoringIntervalSeconds: 30 };
function createSettings({ userDataPath, secureStorage }) {
  const filename = path.join(userDataPath, 'orchestrator-settings.json');
  let data = { settings: { ...DEFAULTS }, preferences: [], encryptedKey: '' };
  try { const disk = JSON.parse(fs.readFileSync(filename, 'utf8')); data = { ...data, ...disk, settings: { ...DEFAULTS, ...disk.settings } }; } catch {}
  let key = '';
  const secure = () => secureStorage?.isEncryptionAvailable?.() && secureStorage?.getSelectedStorageBackend?.() !== 'basic_text';
  try { if (data.encryptedKey && secure()) key = secureStorage.decryptString(Buffer.from(data.encryptedKey, 'base64')); } catch {}
  function persist(next) { fs.mkdirSync(userDataPath, { recursive: true }); const tmp = `${filename}.tmp`; fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 }); fs.renameSync(tmp, filename); data = next; }
  return {
    getKey: () => key,
    getSettings: () => ({ ...data.settings, hasKey: Boolean(key) }),
    getPreferences: () => structuredClone(data.preferences),
    configure(patch) {
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Settings must be an object.');
      const next = structuredClone(data); let nextKey = key;
      if (patch.sessionOnly !== undefined && typeof patch.sessionOnly !== 'boolean') throw new Error('Invalid key storage preference.');
      for (const [name, value] of Object.entries(patch)) {
        if (name === 'key' || name === 'apiKey') {
          if (typeof value !== 'string' || value.length > 4096) throw new Error('Invalid API key.');
          nextKey = value.trim();
          if (nextKey && !secure() && !patch.sessionOnly) throw new Error('Operating-system secure storage is unavailable. Use a session-only key.');
          next.encryptedKey = nextKey && !patch.sessionOnly ? secureStorage.encryptString(nextKey).toString('base64') : '';
        } else if (name === 'sessionOnly') {
          // This controls key storage only and never persists the key itself.
        } else if (['model', 'sttModel', 'ttsModel', 'voice', 'language', 'microphoneId'].includes(name)) {
          if (typeof value !== 'string' || value.length > 512) throw new Error(`Invalid ${name}.`);
          next.settings[name] = value;
        } else if (name === 'monitoringIntervalSeconds') {
          if (!Number.isFinite(value) || value < 5 || value > 300) throw new Error('Monitoring interval must be 5–300 seconds.');
          next.settings[name] = value;
        } else if (name === 'spendingLimit') {
          if (value !== null && (!Number.isFinite(value) || value < 0)) throw new Error('Spending limit must be nonnegative.');
          next.settings[name] = value;
        } else throw new Error(`Unknown setting: ${name}`);
      }
      persist(next); key = nextKey;
    },
    preferences({ operation, text, id }) {
      if (operation === 'list') return this.getPreferences();
      const next = structuredClone(data);
      if (operation === 'remember') { if (typeof text !== 'string' || !text.trim() || text.length > 2000) throw new Error('Preference must be 1–2000 characters.'); if (next.preferences.length >= 100) throw new Error('Preference limit reached.'); next.preferences.push({ id: require('node:crypto').randomUUID(), text: text.trim() }); }
      else if (operation === 'forget') next.preferences = next.preferences.filter(p => p.id !== id);
      else throw new Error('Unknown preference operation.');
      persist(next); return this.getPreferences();
    },
  };
}
module.exports = { createSettings };
