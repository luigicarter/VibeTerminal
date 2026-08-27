const fs = require("fs/promises");
const http = require("http");
const https = require("https");
const os = require("os");
const path = require("path");

const ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models";
const ANTHROPIC_VERSION = "2023-06-01";
const CLAUDE_MODEL_ID_PATTERN = /^claude-[A-Za-z0-9][A-Za-z0-9.:-]{0,95}$/;
// Custom endpoints serve non-Anthropic ids (Kimi, GLM, DeepSeek…), so the
// provider-profile path accepts any compact id string.
const CUSTOM_MODEL_ID_PATTERN = /^[^\s"']{1,120}$/;
const MAX_MODEL_PAGES = 5;
// Never buffer more than this from an endpoint — the body is discarded anyway.
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

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
    // Local Anthropic-compatible gateways are commonly plain http on loopback.
    const transport = url.protocol === "http:" ? http : https;
    const req = transport.request(url, { method: "GET", headers, timeout: timeoutMs }, (res) => {
      const chunks = [];
      let buffered = 0;
      res.on("data", (chunk) => {
        buffered += chunk.length;
        if (buffered > MAX_RESPONSE_BYTES) {
          req.destroy(new Error("The endpoint's response was too large."));
          return;
        }
        chunks.push(chunk);
      });
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

function sanitizeAnthropicModels(models, idPattern = CLAUDE_MODEL_ID_PATTERN) {
  const data = Array.isArray(models) ? models : [];
  const seen = new Set();
  const sanitized = [];
  for (const item of data) {
    const id = typeof item?.id === "string" ? item.id.trim() : "";
    if (!idPattern.test(id) || seen.has(id)) continue;
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
  const connection =
    options.connection && typeof options.connection.baseUrl === "string"
      ? options.connection
      : null;

  let url;
  let headers;
  let idPattern = CLAUDE_MODEL_ID_PATTERN;
  if (connection) {
    url = `${connection.baseUrl.replace(/\/+$/, "")}/v1/models`;
    headers = {
      // Gateways disagree on which credential header they honor; send both.
      authorization: `Bearer ${connection.apiKey || ""}`,
      "x-api-key": connection.apiKey || "",
      "anthropic-version": ANTHROPIC_VERSION,
      "user-agent": "vibeTerminal Fusion"
    };
    idPattern = CUSTOM_MODEL_ID_PATTERN;
  } else {
    const credential = await readClaudeOauthCredential(options.credentialsPath);
    if (!credential.ok) {
      return null;
    }
    url = options.url || ANTHROPIC_MODELS_URL;
    headers = {
      authorization: `Bearer ${credential.accessToken}`,
      "anthropic-version": ANTHROPIC_VERSION,
      "user-agent": "vibeTerminal Fusion"
    };
  }

  try {
    const allModels = [];
    let afterId = "";
    for (let page = 0; page < MAX_MODEL_PAGES; page += 1) {
      const pageUrl = new URL(url);
      pageUrl.searchParams.set("limit", "1000");
      if (afterId) pageUrl.searchParams.set("after_id", afterId);
      const response = await requestJson(pageUrl, headers, options.timeoutMs);

      if (response.statusCode < 200 || response.statusCode >= 300) {
        return null;
      }

      mergeSanitizedModels(allModels, sanitizeAnthropicModels(response.json?.data, idPattern));
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

// Settings-dialog "Test connection": unlike the catalog fetch (which fails
// closed to a curated list), this reports WHY a custom endpoint failed.
async function testClaudeConnection(connection, timeoutMs = 15000) {
  if (!connection || typeof connection.baseUrl !== "string" || !connection.baseUrl) {
    return { ok: false, error: "Missing provider base URL." };
  }
  try {
    const url = new URL(`${connection.baseUrl.replace(/\/+$/, "")}/v1/models`);
    url.searchParams.set("limit", "1000");
    const response = await requestJson(
      url,
      {
        authorization: `Bearer ${connection.apiKey || ""}`,
        "x-api-key": connection.apiKey || "",
        "anthropic-version": ANTHROPIC_VERSION,
        "user-agent": "vibeTerminal Fusion"
      },
      timeoutMs
    );
    if (response.statusCode < 200 || response.statusCode >= 300) {
      return {
        ok: false,
        error: `The endpoint answered HTTP ${response.statusCode}. Check the base URL and API key.`
      };
    }
    const models = sanitizeAnthropicModels(response.json?.data, CUSTOM_MODEL_ID_PATTERN);
    return { ok: true, models };
  } catch (error) {
    return { ok: false, error: error.message || "Could not reach the endpoint." };
  }
}

module.exports = {
  ANTHROPIC_MODELS_URL,
  CLAUDE_MODEL_ID_PATTERN,
  CUSTOM_MODEL_ID_PATTERN,
  defaultClaudeCredentialsPath,
  fetchClaudeModelCatalog,
  readClaudeOauthCredential,
  sanitizeAnthropicModels,
  testClaudeConnection
};
