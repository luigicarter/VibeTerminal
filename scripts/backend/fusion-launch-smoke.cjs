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
      codexBin,
      codexModel: "gpt-5.5",
      codexEffort: "xhigh"
    });
    assert(files, "prepareFusionFiles returned null");

    assert(
      files.systemPromptFile && fs.existsSync(files.systemPromptFile),
      "missing architect system prompt file"
    );
    const prompt = fs.readFileSync(files.systemPromptFile, "utf8");
    assert(/architect/i.test(prompt), "system prompt missing the architect role");
    assert(/long-horizon coding controller/i.test(prompt), "system prompt missing Claude long-horizon role");
    assert(/goal-completion verifier/i.test(prompt), "system prompt missing Codex verifier role");
    assert(/Guiding Codex/i.test(prompt), "system prompt missing Claude-guides-Codex rule");
    assert(/Following Claude's guidance/i.test(prompt), "system prompt missing Codex-guidance scope");
    assert(/Codex native goals/i.test(prompt), "system prompt missing native Codex goals section");
    assert(/codex_goal_set/.test(prompt), "system prompt missing codex_goal_set");
    assert(/codex_goal_get/.test(prompt), "system prompt missing codex_goal_get");
    assert(/codex_implement/.test(prompt), "system prompt missing codex_implement");
    assert(/goalReached:false/.test(prompt), "system prompt missing goalReached continuation gate");
    assert(/Codex verifier override/.test(prompt), "system prompt missing explicit override rule");

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
      adapter.env.VIBE_FUSION_CODEX_MODEL === "gpt-5.5",
      "adapter env missing the selected Codex model"
    );
    assert(
      adapter.env.VIBE_FUSION_CODEX_EFFORT === "xhigh",
      "adapter env missing the selected Codex effort"
    );

    assert(
      buildFusionSystemPrompt().includes("codex_implement"),
      "buildFusionSystemPrompt is missing the delegation instructions"
    );
    assert(
      buildFusionSystemPrompt().includes("goalReached"),
      "buildFusionSystemPrompt is missing the structured verifier fields"
    );
    assert(
      buildFusionSystemPrompt().includes("Codex-managed blocked"),
      "buildFusionSystemPrompt is missing protected native goal status behavior"
    );
    const mainSource = fs.readFileSync(path.join(rootDir, "backend", "main.cjs"), "utf8");
    assert(
      /Edit,MultiEdit,Write/.test(mainSource),
      "Fusion Claude allowlist is missing direct-edit tools for exceptional/UI edits"
    );
    assert(
      /normalizeFusionModel/.test(mainSource) &&
        /normalizeFusionCodexModel/.test(mainSource) &&
        /normalizeFusionEffort/.test(mainSource),
      "Fusion launch should normalize Claude model, Codex model, and effort controls"
    );
    assert(
      /payloadCodexModel/.test(mainSource) &&
        /payloadCodexModel\.toLowerCase\(\) !== "auto"/.test(mainSource) &&
        /process\.env\.VIBE_FUSION_CODEX_MODEL/.test(mainSource),
      "Fusion Codex auto/default should fall back to VIBE_FUSION_CODEX_MODEL"
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
