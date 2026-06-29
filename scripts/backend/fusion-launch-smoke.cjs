// Fusion file-generation smoke test.
//
// A Fusion pane runs headless Claude (backend/fusionChatHost.cjs) wired to a
// per-pane Codex MCP adapter via files produced by prepareFusionFiles. This
// asserts those files are written and the MCP config points the adapter at the
// EMBEDDED Codex binary. No Claude, no Codex, no auth, no cost.

const fs = require("fs");
const path = require("path");
const {
  createAgentTelemetryManager,
  buildFusionSystemPrompt
} = require("../../backend/agentTelemetry.cjs");

const rootDir = path.join(__dirname, "..", "..");
const baseDir = path.join(
  rootDir,
  ".tmp",
  `fusion-launch-smoke-${Date.now()}-${process.pid}`
);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const manager = createAgentTelemetryManager({ baseDir });
  const codexBin =
    process.platform === "win32" ? "C:\\fake\\codex.exe" : "/fake/codex";
  try {
    const files = await manager.prepareFusionFiles("fusion-session", {
      cwd: process.cwd(),
      codexBin
    });
    assert(files, "prepareFusionFiles returned null");

    assert(
      files.systemPromptFile && fs.existsSync(files.systemPromptFile),
      "missing architect system prompt file"
    );
    const prompt = fs.readFileSync(files.systemPromptFile, "utf8");
    assert(/architect/i.test(prompt), "system prompt missing the architect role");
    assert(/codex_implement/.test(prompt), "system prompt missing codex_implement");

    assert(files.mcpConfig && fs.existsSync(files.mcpConfig), "missing mcp config");
    const mcp = JSON.parse(fs.readFileSync(files.mcpConfig, "utf8"));
    const adapter = mcp.mcpServers && mcp.mcpServers["fusion-codex"];
    assert(adapter, "mcp-config missing the fusion-codex server");
    assert(
      Array.isArray(adapter.args) &&
        adapter.args.some((arg) => arg.includes("fusion-adapter")),
      "mcp-config does not point at fusion-adapter.cjs"
    );
    assert(
      adapter.env && adapter.env.VIBE_FUSION_CODEX_BIN === codexBin,
      "adapter env missing the embedded Codex binary path"
    );
    assert(
      adapter.env.CODEX_HOME && adapter.env.CODEX_HOME.endsWith(".codex"),
      "adapter env missing CODEX_HOME (needed so the embedded binary reuses the user's login)"
    );

    assert(
      buildFusionSystemPrompt().includes("codex_implement"),
      "buildFusionSystemPrompt is missing the delegation instructions"
    );

    console.log("Fusion launch smoke passed");
  } finally {
    manager.cleanup();
    try {
      fs.rmSync(baseDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}

main().catch((error) => {
  console.error(`FAIL fusion-launch-smoke: ${error.message}`);
  process.exit(1);
});
