// Claude provider profiles smoke ("Open Claude Code" / Settings → Claude providers).
//
// Locks the storage + validation + env-building contract of
// backend/providerProfiles.cjs (temp store file, no electron → the plaintext
// fallback path) and the wiring contracts between preload, main, the menu, and
// the terminal:create spawn injection. No network, no electron here.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const rootDir = path.join(__dirname, "..", "..");
const storeFile = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), "vibe-claude-providers-")),
  "claude-providers.json"
);
process.env.VIBE_CLAUDE_PROVIDERS_FILE = storeFile;

const providerProfiles = require("../../backend/providerProfiles.cjs");

// ---- upsert validation ----
{
  const badUrl = providerProfiles.upsertProfile({
    name: "Kimi",
    baseUrl: "ftp://nope",
    apiKey: "sk-test",
    model: "kimi-k2"
  });
  assert.strictEqual(badUrl.ok, false, "non-http(s) base URL must be rejected");

  const noName = providerProfiles.upsertProfile({
    name: "   ",
    baseUrl: "https://api.example.com",
    apiKey: "sk-test",
    model: "kimi-k2"
  });
  assert.strictEqual(noName.ok, false, "empty name must be rejected");

  const noKey = providerProfiles.upsertProfile({
    name: "Kimi",
    baseUrl: "https://api.example.com",
    model: "kimi-k2"
  });
  assert.strictEqual(noKey.ok, false, "create without an API key must be rejected");

  const noModel = providerProfiles.upsertProfile({
    name: "Kimi",
    baseUrl: "https://api.example.com",
    apiKey: "sk-test"
  });
  assert.strictEqual(noModel.ok, false, "create without a model must be rejected");

  const badModel = providerProfiles.upsertProfile({
    name: "Kimi",
    baseUrl: "https://api.example.com",
    apiKey: "sk-test",
    model: "has spaces"
  });
  assert.strictEqual(badModel.ok, false, "model ids with spaces must be rejected");

  const multiline = providerProfiles.upsertProfile({
    name: "Kimi",
    baseUrl: "https://api.example.com",
    apiKey: "sk-test\ninjected",
    model: "kimi-k2"
  });
  assert.strictEqual(multiline.ok, false, "multi-line API keys must be rejected");
}

// ---- create + sanitized list + default resolution ----
let firstId;
{
  const created = providerProfiles.upsertProfile({
    name: "  Kimi  ",
    baseUrl: "https://api.moonshot.cn/anthropic/",
    apiKey: "sk-kimi-123",
    model: "kimi-k2-0905-preview",
    smallFastModel: "kimi-k2-turbo"
  });
  assert.strictEqual(created.ok, true, `valid profile should save: ${created.message || ""}`);
  firstId = created.profile.id;
  assert.strictEqual(created.profile.name, "Kimi", "name should be trimmed");
  assert.strictEqual(
    created.profile.baseUrl,
    "https://api.moonshot.cn/anthropic",
    "trailing slashes should be stripped"
  );
  assert.ok(!("apiKey" in created.profile), "the returned profile must not carry key material");
  assert.strictEqual(created.profile.hasKey, true);
  assert.strictEqual(
    created.profile.encrypted,
    false,
    "plain node has no safeStorage — the plaintext fallback must be explicit"
  );

  const list = providerProfiles.listProfiles();
  assert.strictEqual(list.profiles.length, 1);
  assert.strictEqual(list.hasCustomProfile, true);
  assert.strictEqual(
    list.defaultProfileId,
    firstId,
    "a single saved profile resolves as the default without an explicit choice"
  );
  assert.ok(!("apiKey" in list.profiles[0]), "list output must not carry key material");
}

// ---- buildProfileEnv ----
{
  const env = providerProfiles.buildProfileEnv("default-custom");
  assert.deepStrictEqual(
    env,
    {
      ANTHROPIC_BASE_URL: "https://api.moonshot.cn/anthropic",
      ANTHROPIC_AUTH_TOKEN: "sk-kimi-123",
      ANTHROPIC_MODEL: "kimi-k2-0905-preview",
      ANTHROPIC_SMALL_FAST_MODEL: "kimi-k2-turbo"
    },
    "the pane env should carry endpoint, key, and both model slots"
  );
  assert.strictEqual(
    providerProfiles.buildProfileEnv("prov_missing"),
    null,
    "unknown profile ids resolve to null (caller shows an error)"
  );
}

// ---- edit with empty key keeps the stored key; other fields update ----
{
  const edited = providerProfiles.upsertProfile({
    id: firstId,
    name: "Kimi (work)",
    baseUrl: "https://api.moonshot.cn/anthropic",
    model: "kimi-k2-0905-preview"
    // no apiKey: keep existing
  });
  assert.strictEqual(edited.ok, true);
  const env = providerProfiles.buildProfileEnv(firstId);
  assert.strictEqual(env.ANTHROPIC_AUTH_TOKEN, "sk-kimi-123", "the stored key must survive a keyless edit");
  assert.strictEqual(
    env.ANTHROPIC_SMALL_FAST_MODEL,
    undefined,
    "cleared optional fields should drop out of the env"
  );
  assert.strictEqual(providerProfiles.listProfiles().profiles[0].name, "Kimi (work)");
}

// ---- second profile + explicit default + delete ----
{
  const second = providerProfiles.upsertProfile({
    name: "GLM",
    baseUrl: "https://open.bigmodel.cn/api/anthropic",
    apiKey: "glm-key",
    model: "glm-4.6"
  });
  assert.strictEqual(second.ok, true);

  // Two profiles and no explicit default: the first saved wins.
  assert.strictEqual(providerProfiles.listProfiles().defaultProfileId, firstId);

  assert.strictEqual(providerProfiles.setDefaultProfile(second.profile.id).ok, true);
  assert.strictEqual(providerProfiles.listProfiles().defaultProfileId, second.profile.id);
  assert.strictEqual(
    providerProfiles.buildProfileEnv("default-custom").ANTHROPIC_MODEL,
    "glm-4.6",
    "the default-custom sentinel must follow the chosen default"
  );

  assert.strictEqual(providerProfiles.setDefaultProfile("prov_nope").ok, false);
  assert.strictEqual(providerProfiles.deleteProfile(second.profile.id).ok, true);
  assert.strictEqual(
    providerProfiles.listProfiles().defaultProfileId,
    firstId,
    "deleting the default falls back to the remaining profile"
  );
}

// ---- the store file on disk never holds a readable key when encrypted ----
{
  const onDisk = JSON.parse(fs.readFileSync(storeFile, "utf8"));
  assert.strictEqual(onDisk.version, 1);
  assert.strictEqual(onDisk.profiles.length, 1);
  assert.strictEqual(onDisk.profiles[0].encrypted, false, "this run uses the plaintext fallback");
}

// ---- wiring contracts: preload surface, main IPC, menu, spawn injection ----
{
  const preload = fs.readFileSync(path.join(rootDir, "preload", "preload.cjs"), "utf8");
  for (const channel of [
    "claude-providers:list",
    "claude-providers:models",
    "claude-providers:upsert",
    "claude-providers:delete",
    "claude-providers:set-default",
    "claude-providers:test"
  ]) {
    assert.ok(preload.includes(channel), `preload must invoke ${channel}`);
  }
  assert.ok(preload.includes("menu:event"), "preload must subscribe to menu:event");

  const main = fs.readFileSync(path.join(rootDir, "backend", "main.cjs"), "utf8");
  for (const channel of [
    'ipcMain.handle("claude-providers:list"',
    'ipcMain.handle("claude-providers:models"',
    'ipcMain.handle("claude-providers:upsert"',
    'ipcMain.handle("claude-providers:delete"',
    'ipcMain.handle("claude-providers:set-default"',
    'ipcMain.handle("claude-providers:test"'
  ]) {
    assert.ok(main.includes(channel), `main must register ${channel}`);
  }
  assert.ok(
    main.includes("providerProfiles.buildProfileEnv(payload.providerProfileId)"),
    "terminal:create must resolve providerProfileId into spawn env"
  );
  assert.ok(
    main.includes("ANTHROPIC_MODEL: modelOverride"),
    "terminal:create must apply the per-pane model override"
  );
  // The suppression guarantee: Anthropic aliases must never reach --model on a
  // custom endpoint (planner + executor, start + update-settings).
  assert.ok(main.includes("ANTHROPIC_ONLY_MODEL_PATTERN"), "main must define the alias pattern");
  assert.ok(
    (main.match(/suppressAnthropicOnlyModel\(/g) || []).length >= 3,
    "suppression must wrap the planner start and both executor-model paths"
  );
  assert.ok(
    main.includes("autoHideMenuBar: false") && main.includes("installApplicationMenu(mainWindow)"),
    "the window must install the app menu and keep it visible"
  );

  const adapter = fs.readFileSync(path.join(rootDir, "backend", "fusion-adapter.cjs"), "utf8");
  assert.strictEqual(
    (adapter.match(/process\.env\.ANTHROPIC_BASE_URL \? undefined : "sonnet"/g) || []).length,
    3,
    "all three claude-executor model fallbacks must defer to ANTHROPIC_MODEL on a custom provider"
  );

  const telemetry = fs.readFileSync(path.join(rootDir, "backend", "agentTelemetry.cjs"), "utf8");
  assert.ok(
    telemetry.includes("...(opts.providerEnv || {})"),
    "the MCP adapter env block must carry the provider env to the executor"
  );

  const menu = fs.readFileSync(path.join(rootDir, "backend", "appMenu.cjs"), "utf8");
  for (const action of ["open-settings", "open-claude-code", "new-terminal", "toggle-sidebar"]) {
    assert.ok(menu.includes(action), `the app menu must send the "${action}" action`);
  }
  assert.ok(menu.includes('"menu:event"'), "the menu must broadcast on the menu:event channel");
  assert.ok(menu.includes("CmdOrCtrl+,"), "Settings must keep its Ctrl+, accelerator");

  const app = fs.readFileSync(path.join(rootDir, "frontend", "App.tsx"), "utf8");
  assert.ok(app.includes('"claude-custom"'), "App must register the claude-custom launcher");
  assert.ok(app.includes("SettingsDialog"), "App must render the settings dialog");
  assert.ok(
    app.includes("providerOptionsFor(session)"),
    "split/duplicate/add-matching must inherit the pane's provider pin"
  );

  assert.ok(
    fs.existsSync(path.join(rootDir, "frontend", "components", "SettingsDialog.tsx")),
    "frontend/components/SettingsDialog.tsx must exist"
  );
}

// ---- claudeModels custom-connection path, against a live localhost server ----
// (Also locks the http:// transport: local gateways are commonly plain http.)
async function testCustomEndpointFetch() {
  const http = require("http");
  const { fetchClaudeModelCatalog, testClaudeConnection } = require("../../backend/claudeModels.cjs");

  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({
      url: req.url,
      authorization: req.headers.authorization,
      apiKey: req.headers["x-api-key"]
    });
    if (req.url.startsWith("/anthropic/v1/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          data: [
            { id: "kimi-k2-0905-preview", display_name: "Kimi K2" },
            { id: "bad id with spaces" },
            { id: "claude-sonnet-4-5" }
          ],
          has_more: false
        })
      );
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/anthropic`;
  try {
    const models = await fetchClaudeModelCatalog({
      connection: { baseUrl, apiKey: "sk-local" }
    });
    assert.ok(Array.isArray(models), "a reachable custom endpoint must yield models");
    assert.deepStrictEqual(
      models.map((model) => model.id),
      ["kimi-k2-0905-preview", "claude-sonnet-4-5"],
      "custom ids pass, whitespace ids are dropped"
    );
    assert.strictEqual(requests.length, 1);
    assert.strictEqual(requests[0].authorization, "Bearer sk-local", "Bearer header sent");
    assert.strictEqual(requests[0].apiKey, "sk-local", "x-api-key header sent");

    const tested = await testClaudeConnection({ baseUrl, apiKey: "sk-local" });
    assert.strictEqual(tested.ok, true, "test connection succeeds over plain http");
    assert.strictEqual(tested.models.length, 2);

    const authed = await testClaudeConnection({ baseUrl: `${baseUrl}/missing`, apiKey: "x" });
    assert.strictEqual(authed.ok, false, "non-2xx maps to ok:false");
    assert.ok(authed.error.includes("404"), "the status code reaches the error message");
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

testCustomEndpointFetch()
  .then(() => {
    console.log("claude-providers smoke: ok");
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
