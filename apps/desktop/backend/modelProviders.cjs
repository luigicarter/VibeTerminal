"use strict";

// One application-owned catalog for both Open Claude Code and Open Codex.
// Runtime homes remain independent; legacy profile IDs and encrypted keys survive migration.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function storePath() {
  if (process.env.LINA_MODEL_PROVIDERS_FILE) return process.env.LINA_MODEL_PROVIDERS_FILE;
  const isolated = process.env.LINA_OPEN_CODEX_PROVIDERS_FILE || process.env.VIBE_CLAUDE_PROVIDERS_FILE;
  if (isolated) return `${isolated}.shared.json`;
  return path.join(require('electron').app.getPath('userData'), 'model-providers.json');
}
function legacyPaths() {
  const isolated = process.env.LINA_MODEL_PROVIDERS_FILE || process.env.LINA_OPEN_CODEX_PROVIDERS_FILE || process.env.VIBE_CLAUDE_PROVIDERS_FILE;
  const base = isolated ? path.dirname(isolated) : require('electron').app.getPath('userData');
  return { claude: process.env.VIBE_CLAUDE_PROVIDERS_FILE || path.join(base,'claude-providers.json'), codex: process.env.LINA_OPEN_CODEX_PROVIDERS_FILE || path.join(base,'open-codex-providers.json') };
}
function migrateLegacy() {
  const store = { version: 1, profiles: [], defaultModel: null };
  let found = false;
  for (const [kind,file] of Object.entries(legacyPaths())) {
    if (path.resolve(file) === path.resolve(storePath())) continue;
    let raw; try { raw = fs.readFileSync(file,'utf8'); } catch(error) { if(error.code==='ENOENT') continue; throw error; }
    found = true;
    let legacy; try { legacy=JSON.parse(raw); } catch { throw new Error(`The saved ${kind === 'claude' ? 'Claude' : 'Open Codex'} provider file is unreadable. It has been preserved; repair it before importing providers.`); }
    if (!Array.isArray(legacy.profiles)) throw new Error('Legacy provider settings are invalid and have been preserved.');
    for (const profile of legacy.profiles) {
      if (!profile || typeof profile.id !== 'string' || !profile.id || typeof profile.name !== 'string' || typeof profile.baseUrl !== 'string') throw new Error('Legacy provider settings are invalid and have been preserved.');
      if (store.profiles.some(row=>row.id===profile.id)) throw new Error('Legacy provider IDs conflict. The original files have been preserved.');
      const models = kind==='codex' ? normalizeModels(profile.models) : normalizeModels([...new Set([profile.model,profile.smallFastModel].filter(Boolean))]);
      store.profiles.push({ ...profile, models, apiMode: kind==='codex' ? profile.apiMode || 'auto' : 'anthropic', primaryModel: profile.primaryModel || profile.model || models[0].id });
    }
    if (!store.defaultModel && kind==='claude' && legacy.defaultProfileId) {
      const profile=store.profiles.find(row=>row.id===legacy.defaultProfileId);if(profile)store.defaultModel=modelKey(profile.id,profile.primaryModel);
    }
    if (!store.defaultModel && kind==='codex') store.defaultModel=legacy.defaultModel || null;
  }
  store.defaultModel ||= modelsFor(store)[0]?.key || null;
  if (found) writeStore(store);
  return store;
}
function safeStorage() {
  try { return require('electron').safeStorage; } catch { return undefined; }
}
function readStore() {
  let raw;
  try { raw = fs.readFileSync(storePath(), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return migrateLegacy(); throw error; }
  const value = JSON.parse(raw);
  if (value?.version !== 1 || !Array.isArray(value.profiles)) throw new Error('Provider settings could not be read. The saved file has been preserved.');
  if (value.profiles.some(profile=>!profile || typeof profile.id!=='string' || typeof profile.name!=='string' || typeof profile.baseUrl!=='string' || !Array.isArray(profile.models) || !profile.models.length)) throw new Error('Provider settings contain an invalid profile. The saved file has been preserved.');
  return value;
}
function writeStore(value) {
  const file = storePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { try { fs.unlinkSync(temporary); } catch {} }
}
function normalizeBaseUrl(value) {
  const url = new URL(String(value || '').trim());
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.href.length > 2048)
    throw new Error('Use an HTTP(S) API base URL without credentials, a query, or a fragment.');
  return url.href.replace(/\/+$/, '').replace(/\/(?:chat\/completions|responses|models)$/, '');
}
function modelKey(profileId, id) { return `${profileId}/${id}`; }
function publicProfile(profile) {
  const { apiKey, encrypted, ...rest } = profile;
  return { ...rest, hasKey: Boolean(apiKey), encrypted: Boolean(encrypted) };
}
function modelsFor(store) {
  return store.profiles.flatMap(profile => profile.models.map(model => ({
    ...model, key: modelKey(profile.id, model.id), providerId: profile.id, providerName: profile.name
  })));
}
function listProfiles() {
  const store = readStore();
  const models = modelsFor(store);
  return { profiles: store.profiles.map(publicProfile), models,
    defaultModel: models.some(model => model.key === store.defaultModel) ? store.defaultModel : models[0]?.key || null };
}
function decryptKey(profile) {
  if (!profile.apiKey) return '';
  if (!profile.encrypted) return profile.apiKey;
  try { return safeStorage().decryptString(Buffer.from(profile.apiKey, 'base64')); }
  catch { throw new Error(`The saved key for ${profile.name} is unavailable. Enter it again in Models & providers settings.`); }
}
function normalizeModels(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 100) throw new Error('Configure between 1 and 100 models.');
  const seen = new Set();
  return input.map(value => {
    const row = typeof value === 'string' ? { id: value } : value;
    const id = String(row?.id || '').trim();
    if (!/^[A-Za-z0-9._:/@+~\-]{1,200}$/.test(id) || seen.has(id)) throw new Error('Model IDs must be valid, unique, and at most 200 characters.');
    seen.add(id);
    const contextWindow = row.contextWindow ?? 32768;
    if (!Number.isSafeInteger(contextWindow) || contextWindow < 4096 || contextWindow > 2000000) throw new Error('Model context size must be between 4,096 and 2,000,000 tokens.');
    return { id, label: String(row.label || id).replace(/[\x00-\x1f\x7f-\x9f]/g,'').trim().slice(0,200) || id, contextWindow,
      reasoning: row.reasoning === true, imageInput: row.imageInput === true };
  });
}
function upsertProfile(input = {}) {
  try {
    const store = readStore();
    const existing = input.id ? store.profiles.find(profile => profile.id === input.id) : null;
    if (input.id && !existing) throw new Error('That provider no longer exists.');
    const name = String(input.name || '').trim();
    if (!name || name.length > 80 || /[\x00-\x1f]/.test(name)) throw new Error('Provide a provider name of 1–80 characters.');
    const baseUrl = normalizeBaseUrl(input.baseUrl);
    if (existing && baseUrl !== existing.baseUrl && !input.apiKey && existing.apiKey) throw new Error('Enter the API key again when changing its base URL.');
    const apiMode = input.apiMode || 'auto';
    if (!['auto', 'responses', 'chat-completions', 'anthropic'].includes(apiMode)) throw new Error('Choose a supported API format.');
    const models = normalizeModels(input.models);
    let apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
    if (apiKey.length > 4096 || /[\r\n\x00]/.test(apiKey)) throw new Error('The API key must be a single line of at most 4,096 characters.');
    if (!apiKey && existing) apiKey = decryptKey(existing);
    // Local OpenAI-compatible servers may require no key.
    const storage = safeStorage();
    const encrypted = Boolean(apiKey && storage?.isEncryptionAvailable());
    const primaryModel = input.primaryModel || existing?.primaryModel || models[0].id;
    const smallFastModel = input.smallFastModel ?? existing?.smallFastModel ?? '';
    const profile = { id: existing?.id || `prov_${crypto.randomUUID()}`, name, baseUrl, apiMode, models,
      primaryModel: models.some(row=>row.id===primaryModel) ? primaryModel : models[0].id,
      smallFastModel: models.some(row=>row.id===smallFastModel) ? smallFastModel : '',
      apiKey: encrypted ? storage.encryptString(apiKey).toString('base64') : apiKey, encrypted,
      createdAt: existing?.createdAt || Date.now(), updatedAt: Date.now() };
    if (existing) store.profiles = store.profiles.map(row => row.id === profile.id ? profile : row);
    else store.profiles.push(profile);
    if (!modelsFor(store).some(model => model.key === store.defaultModel)) store.defaultModel = modelsFor(store)[0]?.key || null;
    writeStore(store);
    return { ok: true, profile: publicProfile(profile) };
  } catch (error) { return { ok: false, message: error.message }; }
}
function deleteProfile(id) {
  const store = readStore();
  if (!store.profiles.some(row => row.id === id)) return { ok: false, message: 'That provider no longer exists.' };
  store.profiles = store.profiles.filter(row => row.id !== id);
  if (!modelsFor(store).some(model => model.key === store.defaultModel)) store.defaultModel = modelsFor(store)[0]?.key || null;
  writeStore(store);
  return { ok: true };
}
function setDefaultModel(key) {
  const store = readStore();
  if (!modelsFor(store).some(model => model.key === key)) return { ok: false, message: 'Choose a model configured in Models & providers settings.' };
  store.defaultModel = key;
  writeStore(store);
  return { ok: true };
}
function resolveModel(key) {
  const store = readStore();
  for (const profile of store.profiles) {
    const model = profile.models.find(row => modelKey(profile.id, row.id) === key);
    if (model) return { ...model, key, baseUrl: profile.baseUrl, apiMode: profile.apiMode, apiKey: decryptKey(profile) };
  }
  throw new Error('This model is no longer configured. Choose a saved model in Lina Models & providers settings and restart the pane.');
}
async function discoverModels(input = {}, fetchImpl = fetch) {
  try {
    const existing = input.id ? readStore().profiles.find(profile => profile.id === input.id) : null;
    if (input.id && !existing) throw new Error('That provider no longer exists.');
    const baseUrl = normalizeBaseUrl(input.baseUrl || existing?.baseUrl);
    // A keyless edit can never forward an existing key to a different origin.
    if (existing && baseUrl !== existing.baseUrl && !input.apiKey) throw new Error('Enter the API key again to test a different base URL.');
    const apiKey = input.apiKey || (existing ? decryptKey(existing) : '');
    const anthropic = (input.apiMode || existing?.apiMode) === 'anthropic';
    const response = await fetchImpl(`${baseUrl}${anthropic && !baseUrl.endsWith('/v1') ? '/v1' : ''}/models`, { headers: apiKey ? { Authorization: `Bearer ${apiKey}`, ...(anthropic ? { 'x-api-key': apiKey, 'anthropic-version':'2023-06-01' } : {}) } : {},
      redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Model discovery returned HTTP ${response.status}. You can enter model IDs manually.`);
    const raw = await response.text();
    if (raw.length > 5 * 1024 * 1024) throw new Error('The provider model list is too large. Enter model IDs manually.');
    const data = JSON.parse(raw);
    const rows = Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : [];
    return { ok: true, models: rows.filter(row => row && typeof row.id === 'string' && /^[A-Za-z0-9._:/@+~\-]{1,200}$/.test(row.id)).slice(0,2000)
      .map(row => ({ id: row.id, label: String(row.name || row.id).slice(0,200) })) };
  } catch (error) { return { ok: false, error: /^Model discovery returned|^Enter |^That |^Use |^The provider model/.test(error.message) ? error.message : 'Could not load models from this endpoint. Check the URL and key, or enter model IDs manually.' }; }
}
function getProfile(id) {
  const list=listProfiles();
  return id==='default-custom' ? list.profiles.find(row=>row.models.some(model=>modelKey(row.id,model.id)===list.defaultModel)) || null : list.profiles.find(row=>row.id===id) || null;
}
function getProfileConnection(id, modelId) {
  const profile=getProfile(id);if(!profile)return null;
  const list=listProfiles();
  const wanted=modelId || (id==='default-custom' ? list.models.find(model=>model.key===list.defaultModel)?.id : profile.primaryModel) || profile.models[0]?.id;
  const route=resolveModel(modelKey(profile.id,wanted));
  return { ...route, model:route.id, profileId:profile.id, name:profile.name, smallFastModel:profile.smallFastModel };
}
module.exports = { listProfiles, upsertProfile, deleteProfile, setDefaultModel, resolveModel, discoverModels, normalizeBaseUrl, normalizeModels, modelKey, getProfile, getProfileConnection, storePath };
