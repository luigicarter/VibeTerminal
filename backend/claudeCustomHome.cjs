// App-owned Claude home for custom-provider Claude spawns ("Open Claude Code" panes,
// and Fusion's claude-family planner/executor when a provider profile is active).
// Those spawns must not see the user's global ~/.claude (OAuth login, global
// settings.json/CLAUDE.md) or inherited ANTHROPIC_* env vars — the provider profile is
// the only auth/endpoint in play. Subscription "Claude" panes and provider-less Fusion
// keep the global home: they need the claude.ai login.
//
// Like providerProfiles.cjs, this module must load in plain-Node helper hosts (no
// electron import at module scope): electron is required lazily, the env override wins
// first, and the tmpdir fallback only serves tests.

const fs = require("fs");
const os = require("os");
const path = require("path");

// Env vars that steer WHERE claude talks and WHO it authenticates as. Stripped from
// the inherited environment of custom-provider spawns so only the profile's values
// (applied afterwards) survive. User-preference vars (DISABLE_TELEMETRY and friends)
// are deliberately left alone.
const CLAUDE_PROVIDER_ENV_STRIP = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CONFIG_DIR"
];

function resolveCustomClaudeHome() {
  if (process.env.VIBE_CLAUDE_CUSTOM_HOME) {
    return process.env.VIBE_CLAUDE_CUSTOM_HOME;
  }
  try {
    const { app } = require("electron");
    return path.join(app.getPath("userData"), "claude-custom-home");
  } catch {
    // Plain-Node host without the override: nowhere durable to seed. Real helper
    // hosts receive VIBE_CLAUDE_CUSTOM_HOME from main at fork; this serves tests.
    return path.join(os.tmpdir(), "vibe-terminal-claude-custom-home");
  }
}

// Seeds the home and skips claude's first-run wizard by merge-writing
// `hasCompletedOnboarding` into its `.claude.json` state file. The per-folder trust
// flags are deliberately NOT seeded: whether to trust a workspace stays a user
// decision (claude prompts once per folder, then persists it here).
function ensureCustomClaudeHome() {
  const home = resolveCustomClaudeHome();
  fs.mkdirSync(home, { recursive: true });
  const statePath = path.join(home, ".claude.json");
  let state = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      state = parsed;
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      // Never clobber an unreadable state file — move it aside first.
      try {
        fs.renameSync(statePath, `${statePath}.corrupt-${Date.now()}`);
      } catch {
        // best effort
      }
    }
  }
  if (state.hasCompletedOnboarding === true) {
    return home;
  }
  state.hasCompletedOnboarding = true;
  const tmpPath = `${statePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  fs.renameSync(tmpPath, statePath);
  return home;
}

// Returns a NEW env object without the strip-list vars (the input is never mutated).
// Env keys are case-insensitive on Windows, so the match lowercases both sides there.
function stripClaudeProviderEnv(env) {
  const source = env && typeof env === "object" ? env : {};
  const caseInsensitive = process.platform === "win32";
  const strip = new Set(
    CLAUDE_PROVIDER_ENV_STRIP.map((key) => (caseInsensitive ? key.toLowerCase() : key))
  );
  const cleaned = {};
  for (const [key, value] of Object.entries(source)) {
    if (strip.has(caseInsensitive ? key.toLowerCase() : key)) {
      continue;
    }
    cleaned[key] = value;
  }
  return cleaned;
}

module.exports = {
  CLAUDE_PROVIDER_ENV_STRIP,
  resolveCustomClaudeHome,
  ensureCustomClaudeHome,
  stripClaudeProviderEnv
};
