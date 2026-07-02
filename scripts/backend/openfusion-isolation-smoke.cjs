// Open Fusion data-ownership smoke.
//
// Locks the isolation contract: every Open Fusion pane runs against an
// app-owned OpenCode home (threads, credentials, config under the app's
// openfusion dir via XDG_DATA_HOME/XDG_CONFIG_HOME), the user's global
// OpenCode store is seeded once (threads only) and never written, generated
// configs carry NO default models, and the discovery host points its
// `opencode session list` spawns at whatever env overrides the lookup carries.
//
// No OpenCode binary, no network — pure file/config assertions.

const fs = require("fs");
const path = require("path");
const {
  createAgentTelemetryManager,
  ensureOpenFusionOpencodeHome,
  migrateOpenFusionThreadsFromGlobal,
  openFusionOpencodeHomePaths
} = require("../../backend/agentTelemetry.cjs");
const { opencodeSpawnEnv } = require("../../backend/agentThreadHost.cjs");

const rootDir = path.join(__dirname, "..", "..");
const root = path.join(
  rootDir,
  ".tmp",
  `openfusion-isolation-smoke-${Date.now()}-${process.pid}`
);
const shimBase = path.join(root, "shims");
const openFusionBase = path.join(root, "openfusion");
const fakeGlobalData = path.join(root, "fake-global-share");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function main() {
  fs.mkdirSync(root, { recursive: true });

  // A fake "user global" OpenCode store with a thread db to migrate.
  const fakeGlobalOpencode = path.join(fakeGlobalData, "opencode");
  fs.mkdirSync(fakeGlobalOpencode, { recursive: true });
  fs.writeFileSync(path.join(fakeGlobalOpencode, "opencode.db"), "sqlite-bytes-v1");
  fs.writeFileSync(path.join(fakeGlobalOpencode, "opencode.db-wal"), "wal-bytes");
  fs.writeFileSync(path.join(fakeGlobalOpencode, "auth.json"), '{"secret":"never-copy"}');
  const fakeEnv = { XDG_DATA_HOME: fakeGlobalData };

  // ---- ensureOpenFusionOpencodeHome: layout + one-time migration ----
  const home = ensureOpenFusionOpencodeHome(openFusionBase, fakeEnv);
  const expected = openFusionOpencodeHomePaths(openFusionBase);
  assert(
    home.dataDir === expected.dataDir &&
      home.configDir === expected.configDir &&
      home.dataDir.startsWith(openFusionBase) &&
      fs.existsSync(path.join(home.configDir, "opencode")) &&
      fs.existsSync(path.join(home.dataDir, "opencode")),
    "app-owned OpenCode home (data + empty global-config dir) should exist under the openfusion base dir"
  );
  assert(
    fs.readFileSync(path.join(home.dataDir, "opencode", "opencode.db"), "utf8") ===
      "sqlite-bytes-v1" &&
      fs.existsSync(path.join(home.dataDir, "opencode", "opencode.db-wal")),
    "existing threads (opencode.db + wal) should be seeded from the global store"
  );
  assert(
    !fs.existsSync(path.join(home.dataDir, "opencode", "auth.json")),
    "credentials must NOT be migrated — the user's global auth.json is not ours to replicate"
  );
  assert(
    fs.existsSync(path.join(home.dataDir, "opencode", ".vibe-migrated-from-global.json")),
    "migration should stamp a marker so it never re-runs"
  );

  // Idempotence: a changed global db must not overwrite the app store again.
  fs.writeFileSync(path.join(fakeGlobalOpencode, "opencode.db"), "sqlite-bytes-v2");
  const second = migrateOpenFusionThreadsFromGlobal(home.dataDir, fakeEnv);
  assert(
    second.migrated === false &&
      fs.readFileSync(path.join(home.dataDir, "opencode", "opencode.db"), "utf8") ===
        "sqlite-bytes-v1",
    "migration must be one-time: the marker blocks re-copies"
  );
  assert(
    fs.readFileSync(path.join(fakeGlobalOpencode, "auth.json"), "utf8") ===
      '{"secret":"never-copy"}' &&
      fs.readFileSync(path.join(fakeGlobalOpencode, "opencode.db"), "utf8") ===
        "sqlite-bytes-v2",
    "the global store must never be written by isolation or migration"
  );

  // ---- pane env: XDG overrides + no default models ----
  const manager = createAgentTelemetryManager({
    baseDir: shimBase,
    openFusionBaseDir: openFusionBase
  });
  await manager.ready;
  try {
    const files = await manager.prepareOpenFusionFiles("iso-pane", {});
    assert(
      files.env.XDG_DATA_HOME === home.dataDir &&
        files.env.XDG_CONFIG_HOME === home.configDir,
      "pane env must point opencode's data and global-config lookups at the app-owned home"
    );
    const paneConfig = JSON.parse(fs.readFileSync(files.configPath, "utf8"));
    assert(
      !JSON.stringify(paneConfig).includes('"model"') &&
        !JSON.stringify(JSON.parse(files.env.OPENCODE_CONFIG_CONTENT)).includes('"model"'),
      "with no picks the generated config must omit model fields everywhere — no assumed defaults"
    );
    assert(
      files.env.VIBE_TERMINAL_OPEN_FUSION_PLANNER_MODEL === "" &&
        files.env.VIBE_TERMINAL_OPEN_FUSION_EXECUTOR_MODEL === "",
      "unset models surface as empty strings, not vendor defaults"
    );
    assert(
      manager.getOpenFusionOpencodeHome().dataDir === home.dataDir,
      "the manager exposes the app-owned home for discovery-lookup env injection"
    );
  } finally {
    manager.cleanup();
  }

  // ---- discovery host: lookup env overrides reach the spawn env ----
  const spawnEnv = opencodeSpawnEnv({
    XDG_DATA_HOME: home.dataDir,
    XDG_CONFIG_HOME: home.configDir,
    ignored: 42
  });
  assert(
    spawnEnv.XDG_DATA_HOME === home.dataDir &&
      spawnEnv.XDG_CONFIG_HOME === home.configDir &&
      !("ignored" in spawnEnv) &&
      opencodeSpawnEnv(undefined) === undefined &&
      opencodeSpawnEnv({}) === undefined,
    "discovery spawns must merge string-valued env overrides over process.env (and only strings)"
  );

  // ---- renderer + chat host source contracts (grep-style, like workspace-smoke) ----
  const paneSource = fs.readFileSync(
    path.join(rootDir, "frontend", "components", "OpenFusionChatPane.tsx"),
    "utf8"
  );
  assert(
    paneSource.includes("openFusion: true") &&
      paneSource.includes("const modelsReady = Boolean(plannerModel && executorModel)") &&
      paneSource.includes("openfusion-gate") &&
      paneSource.includes("is not a provider in the OpenCode catalog"),
    "pane must flag app-store lookups, gate the first turn on picked models, and refuse unknown /connect ids"
  );
  const hostSource = fs.readFileSync(
    path.join(rootDir, "backend", "openFusionChatHost.cjs"),
    "utf8"
  );
  assert(
    hostSource.includes("No Brain model is set"),
    "chat host must refuse turns without an explicit Brain model (backstop behind the UI gate)"
  );
  const mainSource = fs.readFileSync(path.join(rootDir, "backend", "main.cjs"), "utf8");
  assert(
    mainSource.includes("getOpenFusionOpencodeHome()") &&
      !mainSource.includes("anthropic/claude-sonnet-4-5"),
    "main must inject the app-owned home into openFusion thread lookups and carry no default models"
  );

  fs.rmSync(root, { recursive: true, force: true });
  console.log("Open Fusion isolation smoke passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
