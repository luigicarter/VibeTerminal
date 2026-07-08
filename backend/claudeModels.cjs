const fs = require("fs/promises");
const https = require("https");
const os = require("os");
const path = require("path");

const ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models";
const ANTHROPIC_VERSION = "2023-06-01";
const CLAUDE_MODEL_ID_PATTERN = /^claude-[A-Za-z0-9][A-Za-z0-9.:-]{0,95}$/;
const MAX_MODEL_PAGES = 5;

function defaultClaudeCredentialsPath() {
  return path.join(os.homedir(), ".claude", ".credentials.json");
}

async function readClaudeOauthCredential(credentialsPath = defaultClaudeCredentialsPath()) {
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(credentialsPath, "utf8"));
  } catch (error) {
    return {
      ok: false,
      credentialsPath,
      error: error.code === "ENOENT" ? "Claude credentials not found." : "Could not read Claude credentials."
    };
  }

  const oauth = parsed && typeof parsed === "object" ? parsed.claudeAiOauth : null;
  const accessToken = typeof oauth?.accessToken === "string" ? oauth.accessToken.trim() : "";
  if (!accessToken) {
    return { ok: false, credentialsPath, error: "Claude OAuth access token not found." };
  }

  return { ok: true, credentialsPath, accessToken };
}

function requestJson(url, headers, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: "GET", headers, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try {
          json = body ? JSON.parse(body) : null;
        } catch {
          // Keep the raw body private; callers only need status/error shape.
        }
        resolve({ statusCode: res.statusCode || 0, json });
      });
    });
    req.on("timeout", () => {
      req.destroy(new Error("Claude models request timed out."));
    });
    req.on("error", reject);
    req.end();
  });
}

function sanitizeAnthropicModels(models) {
  const data = Array.isArray(models) ? models : [];
  const seen = new Set();
  const sanitized = [];
  for (const item of data) {
    const id = typeof item?.id === "string" ? item.id.trim() : "";
    if (!CLAUDE_MODEL_ID_PATTERN.test(id) || seen.has(id)) continue;
    seen.add(id);
    const label =
      typeof item?.display_name === "string" && item.display_name.trim()
        ? item.display_name.trim()
        : typeof item?.name === "string" && item.name.trim()
          ? item.name.trim()
          : id;
    sanitized.push({ id, label });
  }
  return sanitized;
}

function mergeSanitizedModels(target, source) {
  const seen = new Set(target.map((model) => model.id));
  for (const model of source) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    target.push(model);
  }
}

async function fetchClaudeModelCatalog(options = {}) {
  const credential = await readClaudeOauthCredential(options.credentialsPath);
  if (!credential.ok) {
    return null;
  }

  try {
    const allModels = [];
    let afterId = "";
    for (let page = 0; page < MAX_MODEL_PAGES; page += 1) {
      const url = new URL(options.url || ANTHROPIC_MODELS_URL);
      url.searchParams.set("limit", "1000");
      if (afterId) url.searchParams.set("after_id", afterId);
      const response = await requestJson(
        url,
        {
          authorization: `Bearer ${credential.accessToken}`,
          "anthropic-version": ANTHROPIC_VERSION,
          "user-agent": "vibeTerminal Fusion"
        },
        options.timeoutMs
      );

      if (response.statusCode < 200 || response.statusCode >= 300) {
        return null;
      }

      mergeSanitizedModels(allModels, sanitizeAnthropicModels(response.json?.data));
      if (response.json?.has_more !== true) break;
      const lastId = typeof response.json?.last_id === "string" ? response.json.last_id.trim() : "";
      if (!lastId || lastId === afterId) break;
      afterId = lastId;
    }
    return allModels.length ? allModels : null;
  } catch {
    return null;
  }
}

module.exports = {
  ANTHROPIC_MODELS_URL,
  CLAUDE_MODEL_ID_PATTERN,
  defaultClaudeCredentialsPath,
  fetchClaudeModelCatalog,
  readClaudeOauthCredential,
  sanitizeAnthropicModels
};
