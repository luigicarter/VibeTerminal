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
      codexEffort: "xhigh",
      runMode: "plan"
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
    assert(/Picture\/image generation/i.test(prompt), "system prompt must route image generation to Codex");
    assert(/browser navigation\/control\/automation/i.test(prompt), "system prompt must route browser control to Codex");
    assert(/Edit, Write/i.test(prompt), "system prompt must allow Claude direct UI/frontend writes");
    assert(/Full-file replacement is still valid/i.test(prompt), "system prompt must allow justified full-file replacements through Codex");
    assert(/Speed and exploration routing/i.test(prompt), "system prompt must include Codex-fed exploration guidance");
    assert(/exploratory work, file fetching, large searches/i.test(prompt), "system prompt must route broad exploration through Codex");
    assert(/Bash is blocked/i.test(prompt), "system prompt must state Bash is blocked for Claude");
    assert(/ALL execution work goes through Codex/i.test(prompt), "system prompt must route execution through Codex");
    assert(/Read\/Grep\/Glob/i.test(prompt), "system prompt must keep read-only review through Read/Grep/Glob");
    assert(
      /capability you do not have directly/i.test(prompt) &&
        /delegate to Codex instead of guessing, refusing, or describing your limitation/i.test(prompt) &&
        /future tool or environment\s+capability outside your direct Read\/Grep\/Glob\/Edit\/Write surface/i.test(prompt) &&
        /Do not answer "I cannot access X here" unless Codex has attempted/i.test(prompt),
      "system prompt must delegate any missing tool/environment capability to Codex"
    );

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
      adapter.env && adapter.env.VIBE_FUSION_EAGER_BOOT === "1",
      "adapter env should eager-boot the Fusion bridge at pane launch"
    );
    assert(
      adapter.env.CODEX_HOME && adapter.env.CODEX_HOME.endsWith(".codex"),
      "adapter env missing CODEX_HOME (needed so the embedded binary reuses the user's login)"
    );
    assert(files.settingsFile && fs.existsSync(files.settingsFile), "missing Fusion Codex settings file");
    const fusionSettings = JSON.parse(fs.readFileSync(files.settingsFile, "utf8"));
    assert(fusionSettings.codexModel === "gpt-5.5", "settings file missing the selected Codex model");
    assert(fusionSettings.codexEffort === "xhigh", "settings file missing the selected Codex effort");
    assert(
      adapter.env.VIBE_FUSION_CODEX_SETTINGS === files.settingsFile,
      "adapter env should pass the live Codex settings file path"
    );
    assert(
      !Object.prototype.hasOwnProperty.call(adapter.env, "VIBE_FUSION_CODEX_MODEL") &&
        !Object.prototype.hasOwnProperty.call(adapter.env, "VIBE_FUSION_CODEX_EFFORT"),
      "adapter env must not freeze Codex model/effort at process launch"
    );
    assert(
      adapter.env.VIBE_FUSION_RUN_MODE === "plan",
      "adapter env missing the selected Fusion run mode"
    );
    assert(
      adapter.env.VIBE_FUSION_RUN_MODE_FILE &&
        fs.readFileSync(adapter.env.VIBE_FUSION_RUN_MODE_FILE, "utf8").trim() === "plan",
      "adapter env missing the persisted Fusion run mode file"
    );

    assert(
      buildFusionSystemPrompt().includes("File edit decision policy") &&
        buildFusionSystemPrompt().includes("Speed and exploration routing") &&
        buildFusionSystemPrompt().includes("codex_implement") &&
        buildFusionSystemPrompt().includes("Bash is blocked") &&
        buildFusionSystemPrompt().includes("Edit, Write"),
      "buildFusionSystemPrompt is missing the UI-write/speed routing instructions"
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
    assert(/function fusionClaudeAllowedTools/.test(mainSource), "Fusion allowed tools helper not found in main.cjs");
    assert(/function fusionClaudeTools/.test(mainSource), "Fusion --tools helper not found in main.cjs");
    function extractStringArrayConst(source, constName) {
      const match = source.match(new RegExp(`const\\s+${constName}\\s*=\\s*\\[([\\s\\S]*?)\\];`));
      assert(match, `${constName} not found in main.cjs`);
      return [...match[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]);
    }
    const bridgeTools = extractStringArrayConst(mainSource, "FUSION_CODEX_BRIDGE_TOOLS");
    const uiWriteTools = extractStringArrayConst(mainSource, "FUSION_CLAUDE_UI_WRITE_TOOLS");
    const allowList = ["Read", "Glob", "Grep", ...uiWriteTools, ...bridgeTools];
    assert(
      ["Edit", "Write"].every((tool) => allowList.includes(tool)) && !allowList.includes("Bash"),
      "Fusion Claude allowlist should grant UI write tools while keeping Bash out"
    );
    assert(
      !allowList.some((tool) => /(?:image|picture|browser|chrome|webfetch|websearch)/i.test(tool)),
      "Fusion Claude allowlist must NOT grant direct image-generation or browser-control tools"
    );
    assert(
      ["Read", "Glob", "Grep"].every((tool) => allowList.includes(tool)),
      "Fusion allowlist should expose Read/Glob/Grep for read-only investigation"
    );
    assert(
      ["codex_goal_set", "codex_goal_get", "codex_goal_clear"].every((tool) =>
        allowList.some((entry) => entry.includes(tool))
      ),
      "Fusion allowlist should expose the codex_goal_* native-goal tools so the prompt's goal instructions work"
    );
    assert(
      allowList.some((entry) => entry.includes("codex_investigate")),
      "Fusion allowlist should expose codex_investigate for Codex-fed exploration"
    );
    assert(
      /disallowedTools:\s*fusionClaudeDisallowedTools\(\)/.test(mainSource) &&
        /return \["Bash", \.\.\.FUSION_CLAUDE_WRITE_DENY_RULES\]\.join\(","\)/.test(mainSource),
      "Fusion Claude must hard-block Bash plus write deny rules via --disallowedTools"
    );
    const writeDenyPaths = extractStringArrayConst(
      mainSource,
      "FUSION_CLAUDE_WRITE_DENY_PATHS"
    );
    assert(
      [".git/**", ".github/workflows/**", ".husky/**"].every((pattern) =>
        writeDenyPaths.includes(pattern)
      ),
      "Fusion Claude write deny rules must cover git hooks/config, CI workflows, and husky hooks"
    );
    assert(
      /tools:\s*fusionClaudeTools\(\)/.test(mainSource) && /strictMcpConfig:\s*true/.test(mainSource),
      "Fusion launch should restrict Claude built-ins with --tools and isolate MCP with --strict-mcp-config"
    );
    assert(
      /normalizeFusionModel/.test(mainSource) &&
        /normalizeFusionCodexModel/.test(mainSource) &&
        /normalizeFusionEffort/.test(mainSource) &&
        /normalizeFusionRunMode/.test(mainSource),
      "Fusion launch should normalize Claude model, Codex model, effort controls, and run mode"
    );
    assert(
      /payload\.codexEffort \?\? payload\.effort/.test(mainSource) &&
        /codexEffort: fusionCodexEffort/.test(mainSource) &&
        /effort: fusionClaudeEffort/.test(mainSource),
      "Fusion launch should pass independent Claude and Codex effort settings"
    );
    assert(
      /steerFusionSession\(payload\.id, payload\.text\)/.test(mainSource) &&
        /interruptFusionSession\(payload\.id\)/.test(mainSource) &&
        /setFusionSessionMode\(payload\.id, mode\)/.test(mainSource) &&
        /fusion-chat:update-settings/.test(mainSource) &&
        /updateFusionSettings\(payload\.id/.test(mainSource),
      "Fusion main process should route steer/interrupt/mode/live settings to the terminal-scoped adapter control path"
    );
    const agentTelemetrySource = fs.readFileSync(path.join(rootDir, "backend", "agentTelemetry.cjs"), "utf8");
    assert(
      /VIBE_FUSION_RUN_MODE: runMode/.test(agentTelemetrySource) &&
        /VIBE_FUSION_RUN_MODE_FILE: runModeFile/.test(agentTelemetrySource) &&
        /setFusionSessionMode/.test(agentTelemetrySource),
      "Fusion telemetry should persist and update per-session run mode"
    );
    const hostSource = fs.readFileSync(path.join(rootDir, "backend", "fusionChatHost.cjs"), "utf8");
    assert(
      /FUSION PLAN MODE IS ACTIVE/.test(hostSource) &&
        /msg\.type === "mode"/.test(hostSource) &&
        /buildFusionInputContent\(text, normalizeFusionRunMode\(state\.mode\), steer\)/.test(hostSource),
      "Fusion chat host should apply the Plan mode read-only turn directive"
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
