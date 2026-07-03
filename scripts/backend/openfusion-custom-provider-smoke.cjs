// Open Fusion custom-provider smoke.
//
// Locks the add-your-own OpenAI-compatible provider slice: the PATCH
// /global/config body shape the host sends (npm pin, base URL, user-named
// models), the removal rewrite of the app-owned global config file, the
// renderer's name→id derivation (catalog-collision suffixing, custom-id
// reuse), and the wiring contracts between pane, preload, main, and host.
//
// The live server semantics behind this (PATCH /global/config re-reads the
// config file, merges, persists, and refreshes the instance without a dispose
// or restart; empty {} PATCH as the reload nudge; config-defined providers
// count as connected without a key) were verified against opencode 1.17.11 on
// 2026-07-03. No OpenCode binary, no network here — pure shape/file/contract
// assertions.

const assert = require("assert");
const fs = require("fs");
const Module = require("module");
const os = require("os");
const path = require("path");
const ts = require("typescript");

const rootDir = path.join(__dirname, "..", "..");
const { buildCustomProviderPatch } = require("../../backend/openFusionChatHost.cjs");
const {
  ensureOpenFusionOpencodeHome,
  removeOpenFusionCustomProvider
} = require("../../backend/agentTelemetry.cjs");

// ---- buildCustomProviderPatch: the PATCH /global/config body ----
{
  const shaped = buildCustomProviderPatch({
    providerId: "my-openrouter",
    name: "  My   OpenRouter  ",
    baseURL: "https://api.example.com/v1",
    models: [
      { id: "llama-3.3-70b", name: "Llama 3.3 (fast)" },
      { id: "qwen-coder", name: "" }
    ]
  });
  assert.strictEqual(shaped.ok, true, "a valid definition should shape");
  const entry = shaped.patch.provider["my-openrouter"];
  assert.strictEqual(entry.npm, "@ai-sdk/openai-compatible", "npm package must be pinned");
  assert.strictEqual(entry.name, "My OpenRouter", "display name should be whitespace-collapsed");
  assert.strictEqual(entry.options.baseURL, "https://api.example.com/v1", "baseURL should be the normalized href");
  assert.deepStrictEqual(
    entry.models,
    {
      "llama-3.3-70b": { name: "Llama 3.3 (fast)" },
      "qwen-coder": { name: "qwen-coder" }
    },
    "models map should carry user display names, defaulting to the id"
  );
}

// Same model id under two differently-named providers is the entire point.
{
  const first = buildCustomProviderPatch({
    providerId: "groq-fast",
    name: "Groq (fast)",
    baseURL: "https://api.groq.com/openai/v1",
    models: [{ id: "llama-3.3-70b" }]
  });
  const second = buildCustomProviderPatch({
    providerId: "cerebras",
    name: "Cerebras",
    baseURL: "https://api.cerebras.ai/v1",
    models: [{ id: "llama-3.3-70b" }]
  });
  assert.ok(
    first.ok &&
      second.ok &&
      first.patch.provider["groq-fast"].models["llama-3.3-70b"] &&
      second.patch.provider["cerebras"].models["llama-3.3-70b"],
    "the same model id must be definable under two providers"
  );
}

// Optional per-model context window → opencode `limit` config. The output cap
// is derived (min(32000, context/4), floor 256): opencode's compaction
// threshold is context − 32000 when output is unknown, which clamps to 0 for
// sub-32k models and would re-compact on every step (verified 1.17.11 logic).
{
  const shaped = buildCustomProviderPatch({
    providerId: "ctx-prov",
    name: "Ctx",
    baseURL: "https://api.example.com/v1",
    models: [
      { id: "big", name: "Big", contextLimit: 128000 },
      { id: "small", name: "Small", contextLimit: 8192 },
      { id: "unknown", name: "Unknown" }
    ]
  });
  assert.strictEqual(shaped.ok, true, "context limits should shape");
  const models = shaped.patch.provider["ctx-prov"].models;
  assert.deepStrictEqual(
    models.big.limit,
    { context: 128000, output: 32000 },
    "large contexts keep opencode's default output cap"
  );
  assert.deepStrictEqual(
    models.small.limit,
    { context: 8192, output: 2048 },
    "sub-32k contexts derive a smaller output cap (compaction threshold must stay > 0)"
  );
  assert.ok(!("limit" in models.unknown), "no context given → no limit key (opencode treats it as unknown)");

  assert.strictEqual(
    buildCustomProviderPatch({
      providerId: "ctx-bad",
      name: "Bad",
      baseURL: "https://api.example.com/v1",
      models: [{ id: "m", contextLimit: 100 }]
    }).ok,
    false,
    "an implausibly small context limit must be refused"
  );
  assert.strictEqual(
    buildCustomProviderPatch({
      providerId: "ctx-bad2",
      name: "Bad",
      baseURL: "https://api.example.com/v1",
      models: [{ id: "m", contextLimit: 128.5 }]
    }).ok,
    false,
    "non-integer context limits must be refused"
  );
}

// Rejections: bad ids, bad URLs, missing models. Local http endpoints are
// legal (LM Studio / llama.cpp), non-http(s) schemes are not.
{
  const base = {
    providerId: "ok-id",
    name: "Ok",
    baseURL: "http://localhost:1234/v1",
    models: [{ id: "m1" }]
  };
  assert.strictEqual(buildCustomProviderPatch(base).ok, true, "http localhost is a valid endpoint");
  assert.strictEqual(
    buildCustomProviderPatch({ ...base, providerId: "Bad Id" }).ok,
    false,
    "provider ids with spaces/uppercase must be refused"
  );
  assert.strictEqual(
    buildCustomProviderPatch({ ...base, baseURL: "ftp://host/v1" }).ok,
    false,
    "non-http(s) base URLs must be refused"
  );
  assert.strictEqual(
    buildCustomProviderPatch({ ...base, models: [] }).ok,
    false,
    "at least one model is required"
  );
  assert.strictEqual(
    buildCustomProviderPatch({ ...base, models: [{ id: "bad id" }] }).ok,
    false,
    "model ids with spaces must be refused"
  );
  assert.strictEqual(
    buildCustomProviderPatch({ ...base, name: "   " }).ok,
    false,
    "an empty display name must be refused"
  );
}

// ---- removeOpenFusionCustomProvider: the config-file rewrite ----
{
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-openfusion-custom-"));
  const configDir = path.join(base, "opencode-home", "config", "opencode");
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, "opencode.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      provider: {
        "keep-me": { npm: "@ai-sdk/openai-compatible", name: "Keep" },
        "drop-me": { npm: "@ai-sdk/openai-compatible", name: "Drop" }
      }
    })
  );

  assert.deepStrictEqual(
    removeOpenFusionCustomProvider(base, "drop-me"),
    { removed: true },
    "removing an existing entry should report removed"
  );
  const after = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.ok(
    after.provider["keep-me"] && !after.provider["drop-me"] && after.$schema,
    "only the requested provider entry should be dropped"
  );
  assert.deepStrictEqual(
    removeOpenFusionCustomProvider(base, "drop-me"),
    { removed: false },
    "removing a missing entry should be a no-op"
  );
  assert.deepStrictEqual(
    removeOpenFusionCustomProvider(base, ""),
    { removed: false },
    "an empty id should be a no-op"
  );
  fs.rmSync(base, { recursive: true, force: true });
}
{
  const emptyBase = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-openfusion-none-"));
  assert.deepStrictEqual(
    removeOpenFusionCustomProvider(emptyBase, "anything"),
    { removed: false },
    "a missing config file should be a no-op, not a crash"
  );
  fs.rmSync(emptyBase, { recursive: true, force: true });
}

// Homes that predate the opencode.json seeding hold an opencode.jsonc from
// opencode's own first PATCH write (plain JSON content) — removal must reach
// into it too.
{
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-openfusion-jsonc-"));
  const configDir = path.join(base, "opencode-home", "config", "opencode");
  fs.mkdirSync(configDir, { recursive: true });
  const jsoncPath = path.join(configDir, "opencode.jsonc");
  fs.writeFileSync(
    jsoncPath,
    JSON.stringify({ provider: { "drop-me": { npm: "@ai-sdk/openai-compatible", name: "Drop" } } })
  );
  assert.deepStrictEqual(
    removeOpenFusionCustomProvider(base, "drop-me"),
    { removed: true },
    "removal should also handle a .jsonc global config"
  );
  assert.deepStrictEqual(
    JSON.parse(fs.readFileSync(jsoncPath, "utf8")).provider,
    {},
    "the .jsonc entry should be dropped in place"
  );
  fs.rmSync(base, { recursive: true, force: true });
}

// ensureOpenFusionOpencodeHome pins the global config FILENAME: without a
// file, opencode's first PATCH /global/config write creates opencode.jsonc;
// the empty-{} opencode.json seed keeps the app-owned file deterministic. An
// existing .jsonc must be respected (never create both).
{
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-openfusion-seed-"));
  const fakeGlobal = path.join(base, "fake-global");
  fs.mkdirSync(fakeGlobal, { recursive: true });
  const home = ensureOpenFusionOpencodeHome(base, { XDG_DATA_HOME: fakeGlobal });
  const configJson = path.join(home.configDir, "opencode", "opencode.json");
  assert.strictEqual(
    fs.readFileSync(configJson, "utf8").trim(),
    "{}",
    "a fresh home should seed an empty opencode.json"
  );
  fs.writeFileSync(configJson, '{"provider":{"x":{}}}');
  ensureOpenFusionOpencodeHome(base, { XDG_DATA_HOME: fakeGlobal });
  assert.strictEqual(
    fs.readFileSync(configJson, "utf8"),
    '{"provider":{"x":{}}}',
    "re-running ensure must never clobber an existing config"
  );
  fs.rmSync(base, { recursive: true, force: true });

  const jsoncBase = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-openfusion-seed2-"));
  const jsoncGlobal = path.join(jsoncBase, "fake-global");
  fs.mkdirSync(jsoncGlobal, { recursive: true });
  const jsoncDir = path.join(jsoncBase, "opencode-home", "config", "opencode");
  fs.mkdirSync(jsoncDir, { recursive: true });
  fs.writeFileSync(path.join(jsoncDir, "opencode.jsonc"), "{}");
  ensureOpenFusionOpencodeHome(jsoncBase, { XDG_DATA_HOME: jsoncGlobal });
  assert.ok(
    !fs.existsSync(path.join(jsoncDir, "opencode.json")),
    "an existing .jsonc must not gain a sibling .json (two config files = ambiguity)"
  );
  fs.rmSync(jsoncBase, { recursive: true, force: true });
}

// ---- renderer helpers: name → provider id ----
const openFusionPath = path.join(rootDir, "frontend", "openFusion.ts");
const compiledOpenFusion = ts.transpileModule(fs.readFileSync(openFusionPath, "utf8"), {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022
  },
  fileName: openFusionPath
}).outputText;
const openFusionModule = new Module(openFusionPath, module);
openFusionModule.filename = openFusionPath;
openFusionModule.paths = Module._nodeModulePaths(path.dirname(openFusionPath));
openFusionModule._compile(compiledOpenFusion, openFusionPath);
const {
  customProviderIdForName,
  parseCustomProviderContextLimit,
  validateCustomProviderBaseUrl,
  validateCustomProviderModelId,
  validateCustomProviderName
} = openFusionModule.exports;

assert.strictEqual(
  customProviderIdForName("My OpenRouter!", ["openai"], []),
  "my-openrouter",
  "names should slugify to lowercase ids"
);
assert.strictEqual(
  customProviderIdForName("OpenAI", ["openai", "openai-custom"], []),
  "openai-custom2",
  "catalog collisions should suffix instead of merging into a stock provider"
);
assert.strictEqual(
  customProviderIdForName("OpenAI", ["openai"], ["openai-custom"]),
  "openai-custom",
  "an existing custom id should be reused (redefinition, not duplication)"
);
assert.strictEqual(
  customProviderIdForName("My Groq", ["openai"], ["my-groq"]),
  "my-groq",
  "a matching custom slug should be reused directly"
);
assert.strictEqual(
  customProviderIdForName("!!!", [], []),
  "custom",
  "an unslugifiable name should fall back, not produce an empty id"
);

assert.deepStrictEqual(
  parseCustomProviderContextLimit(""),
  { ok: true },
  "empty context input = skip (no limit)"
);
assert.deepStrictEqual(parseCustomProviderContextLimit("128k"), { ok: true, limit: 128000 });
assert.deepStrictEqual(parseCustomProviderContextLimit("1m"), { ok: true, limit: 1000000 });
assert.deepStrictEqual(parseCustomProviderContextLimit("0.5M"), { ok: true, limit: 500000 });
assert.deepStrictEqual(parseCustomProviderContextLimit("128,000"), { ok: true, limit: 128000 });
assert.strictEqual(parseCustomProviderContextLimit("abc").ok, false);
assert.strictEqual(parseCustomProviderContextLimit("100").ok, false, "below the plausibility floor");
assert.strictEqual(parseCustomProviderContextLimit("200m").ok, false, "above the plausibility ceiling");

assert.strictEqual(validateCustomProviderName("My Provider"), null);
assert.notStrictEqual(validateCustomProviderName("   "), null);
assert.strictEqual(validateCustomProviderBaseUrl("http://localhost:1234/v1"), null);
assert.notStrictEqual(validateCustomProviderBaseUrl("not-a-url"), null);
assert.notStrictEqual(validateCustomProviderBaseUrl("ftp://x/v1"), null);
assert.strictEqual(validateCustomProviderModelId("meta/llama-3.3-70b"), null);
assert.notStrictEqual(validateCustomProviderModelId("bad id"), null);

// ---- wiring contracts (source greps, same pattern as the other smokes) ----
function mustContain(relPath, needles) {
  const text = fs.readFileSync(path.join(rootDir, relPath), "utf8");
  for (const needle of needles) {
    assert.ok(text.includes(needle), `${relPath} should contain ${JSON.stringify(needle)}`);
  }
}

mustContain("frontend/components/OpenFusionChatPane.tsx", [
  "__custom-provider",
  "customProviderSet",
  "customProviderRemove",
  '"custom-review"',
  '"custom-model-context"',
  "/custom-provider",
  'source === "config"'
]);
mustContain("preload/preload.cjs", [
  "openfusion-chat:custom-provider-set",
  "openfusion-chat:custom-provider-remove"
]);
mustContain("backend/main.cjs", [
  '"openfusion-chat:custom-provider-set"',
  '"openfusion-chat:custom-provider-remove"',
  "removeOpenFusionCustomProvider"
]);
mustContain("backend/openFusionChatHost.cjs", [
  'msg.type === "custom-provider-set"',
  'msg.type === "custom-provider-remove"',
  '"PATCH", "/global/config"',
  "reloadConfig"
]);

console.log("openfusion-custom-provider-smoke: OK");
