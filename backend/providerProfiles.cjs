// Store for user-defined Claude provider profiles (third-party Anthropic-compatible
// endpoints such as Kimi, GLM, DeepSeek, OpenRouter). Profiles live main-process-side
// under userData; API keys are encrypted with Electron safeStorage (DPAPI on Windows)
// before they touch disk and are only ever decrypted here, at spawn time — the
// renderer receives sanitized profiles with `hasKey` flags, never key material.
//
// This module must also load in plain-Node helper hosts (no electron import at
// module scope): electron is required lazily and every use degrades gracefully.

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const STORE_VERSION = 1;
const MAX_NAME_LENGTH = 60;
const MAX_BASE_URL_LENGTH = 200;
const MAX_API_KEY_LENGTH = 512;
// Same shape as FUSION_MODEL_ID_PATTERN in main.cjs (kept local: main requires
// this module, so requiring back would be a cycle).
const MODEL_ID_PATTERN = /^[A-Za-z0-9._:/@+-]+$/;

function getSafeStorage() {
  try {
    const { safeStorage } = require("electron");
    return safeStorage || null;
  } catch {
    return null;
  }
}

function resolveStorePath() {
  if (process.env.VIBE_CLAUDE_PROVIDERS_FILE) {
    return process.env.VIBE_CLAUDE_PROVIDERS_FILE;
  }
  try {
    const { app } = require("electron");
    return path.join(app.getPath("userData"), "claude-providers.json");
  } catch {
    // Plain-Node helper host without an override: nowhere durable to write.
    // Callers in that context only ever read via env overrides in tests.
    return path.join(os.tmpdir(), "vibe-terminal-claude-providers.json");
  }
}

function emptyStore() {
  return { version: STORE_VERSION, defaultProfileId: null, profiles: [] };
}

function readStore() {
  const filePath = resolveStorePath();
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return emptyStore();
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.profiles)) {
      // Valid JSON but not a store: don't clobber it on the next save either.
      try {
        fs.renameSync(filePath, `${filePath}.corrupt-${Date.now()}`);
      } catch {
        // best effort
      }
      return emptyStore();
    }
    return {
      version: STORE_VERSION,
      defaultProfileId:
        typeof parsed.defaultProfileId === "string" ? parsed.defaultProfileId : null,
      profiles: parsed.profiles.filter((profile) => profile && typeof profile.id === "string")
    };
  } catch {
    // Never clobber an unreadable store on the next save — move it aside first.
    try {
      fs.renameSync(filePath, `${filePath}.corrupt-${Date.now()}`);
    } catch {
      // best effort
    }
    return emptyStore();
  }
}

function writeStore(store) {
  const filePath = resolveStorePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  // The store can hold a plaintext key where safeStorage has no keychain
  // (Linux), so keep it owner-only regardless of umask. mode applies at
  // creation only — chmod after the rename covers pre-existing stores.
  fs.writeFileSync(tmpPath, `${JSON.stringify(store, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  fs.renameSync(tmpPath, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // best effort (Windows ACLs don't map cleanly)
  }
}

function encryptKey(plain) {
  const safeStorage = getSafeStorage();
  if (safeStorage && safeStorage.isEncryptionAvailable()) {
    return {
      apiKey: safeStorage.encryptString(plain).toString("base64"),
      encrypted: true
    };
  }
  return { apiKey: plain, encrypted: false };
}

function decryptKey(profile) {
  if (!profile || typeof profile.apiKey !== "string" || !profile.apiKey) {
    return "";
  }
  if (!profile.encrypted) {
    return profile.apiKey;
  }
  const safeStorage = getSafeStorage();
  if (!safeStorage) {
    return "";
  }
  try {
    return safeStorage.decryptString(Buffer.from(profile.apiKey, "base64"));
  } catch {
    return "";
  }
}

function normalizeBaseUrl(value) {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    return { ok: false, message: "Provide a valid base URL (e.g. https://api.example.com)." };
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.href.length > MAX_BASE_URL_LENGTH
  ) {
    return { ok: false, message: "The base URL must be http(s) and at most 200 characters." };
  }
  // Strip trailing slashes so callers can append "/v1/models" without doubles.
  return { ok: true, baseUrl: url.href.replace(/\/+$/, "") };
}

function validateModelId(value, fieldLabel, { required } = {}) {
  const model = String(value || "").trim();
  if (!model) {
    return required
      ? { ok: false, message: `Provide a ${fieldLabel}.` }
      : { ok: true, model: "" };
  }
  if (model.length > 120 || !MODEL_ID_PATTERN.test(model)) {
    return { ok: false, message: `'${model.slice(0, 60)}' is not a valid ${fieldLabel}.` };
  }
  return { ok: true, model };
}

function sanitizeProfile(profile) {
  return {
    id: profile.id,
    name: profile.name,
    baseUrl: profile.baseUrl,
    model: profile.model,
    smallFastModel: profile.smallFastModel || "",
    hasKey: Boolean(profile.apiKey),
    encrypted: Boolean(profile.encrypted),
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt
  };
}

function findProfile(store, id) {
  return store.profiles.find((profile) => profile.id === id) || null;
}

// The profile a "default-custom" pane should run on: the explicitly chosen
// default when one is set, otherwise the first saved profile so a single-profile
// user never has to visit Settings twice.
function resolveDefaultCustomProfile(store) {
  if (store.defaultProfileId) {
    const chosen = findProfile(store, store.defaultProfileId);
    if (chosen) {
      return chosen;
    }
  }
  return store.profiles[0] || null;
}

function listProfiles() {
  const store = readStore();
  const defaultCustom = resolveDefaultCustomProfile(store);
  return {
    profiles: store.profiles.map(sanitizeProfile),
    defaultProfileId: defaultCustom ? defaultCustom.id : null,
    hasCustomProfile: store.profiles.length > 0
  };
}

function upsertProfile(input = {}) {
  const store = readStore();
  const name = String(input.name || "").trim();
  if (!name || name.length > MAX_NAME_LENGTH) {
    return { ok: false, message: `Provide a provider name (1-${MAX_NAME_LENGTH} characters).` };
  }
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  if (!baseUrl.ok) {
    return baseUrl;
  }
  const model = validateModelId(input.model, "model id", { required: true });
  if (!model.ok) {
    return model;
  }
  const smallFastModel = validateModelId(input.smallFastModel, "small/fast model id");
  if (!smallFastModel.ok) {
    return smallFastModel;
  }

  const apiKeyInput = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
  if (apiKeyInput && (apiKeyInput.length > MAX_API_KEY_LENGTH || /[\r\n]/.test(apiKeyInput))) {
    return { ok: false, message: "The API key must be a single line of at most 512 characters." };
  }

  const now = Date.now();
  const existing = input.id ? findProfile(store, input.id) : null;
  if (input.id && !existing) {
    return { ok: false, message: "That provider no longer exists." };
  }

  if (!existing && !apiKeyInput) {
    return { ok: false, message: "Provide an API key for the provider." };
  }

  let keyMaterial = apiKeyInput
    ? encryptKey(apiKeyInput)
    : { apiKey: existing.apiKey, encrypted: existing.encrypted };
  // Upgrade a plaintext-fallback key to encrypted storage when a keychain has
  // since become available — a keyless edit should not carry plaintext forward.
  if (!apiKeyInput && existing && !existing.encrypted) {
    const safeStorage = getSafeStorage();
    if (safeStorage?.isEncryptionAvailable()) {
      keyMaterial = encryptKey(existing.apiKey);
    }
  }

  const profile = {
    id: existing
      ? existing.id
      : `prov_${crypto.randomUUID()}`,
    name,
    baseUrl: baseUrl.baseUrl,
    model: model.model,
    smallFastModel: smallFastModel.model,
    apiKey: keyMaterial.apiKey,
    encrypted: keyMaterial.encrypted,
    createdAt: existing ? existing.createdAt : now,
    updatedAt: now
  };

  if (existing) {
    store.profiles = store.profiles.map((entry) => (entry.id === profile.id ? profile : entry));
  } else {
    store.profiles.push(profile);
  }
  writeStore(store);
  return { ok: true, profile: sanitizeProfile(profile) };
}

function deleteProfile(id) {
  const store = readStore();
  const next = store.profiles.filter((profile) => profile.id !== id);
  if (next.length === store.profiles.length) {
    return { ok: false, message: "That provider no longer exists." };
  }
  store.profiles = next;
  if (store.defaultProfileId === id) {
    store.defaultProfileId = null;
  }
  writeStore(store);
  return { ok: true };
}

function setDefaultProfile(id) {
  const store = readStore();
  if (id !== null && !findProfile(store, id)) {
    return { ok: false, message: "That provider no longer exists." };
  }
  store.defaultProfileId = id;
  writeStore(store);
  return { ok: true };
}

// resolveProfileId maps the renderer-facing sentinel to a stored profile.
function resolveProfileId(id) {
  const store = readStore();
  if (id === "default-custom") {
    return resolveDefaultCustomProfile(store);
  }
  return findProfile(store, id);
}

function buildProfileEnv(id) {
  const profile = resolveProfileId(id);
  if (!profile) {
    return null;
  }
  const env = {};
  if (profile.baseUrl) {
    env.ANTHROPIC_BASE_URL = profile.baseUrl;
  }
  const key = decryptKey(profile);
  if (key) {
    env.ANTHROPIC_AUTH_TOKEN = key;
  }
  if (profile.model) {
    env.ANTHROPIC_MODEL = profile.model;
  }
  if (profile.smallFastModel) {
    env.ANTHROPIC_SMALL_FAST_MODEL = profile.smallFastModel;
  }
  return env;
}

// Connection details for in-main-process calls against the endpoint (model
// catalog, test connection). Never expose the key through IPC.
function getProfileConnection(id) {
  const profile = resolveProfileId(id);
  if (!profile) {
    return null;
  }
  return { baseUrl: profile.baseUrl, apiKey: decryptKey(profile), model: profile.model };
}

module.exports = {
  listProfiles,
  upsertProfile,
  deleteProfile,
  setDefaultProfile,
  buildProfileEnv,
  getProfileConnection
};
