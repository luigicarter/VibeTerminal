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
      plannerFamily: "codex",
      plannerFast: true,
      executorFamily: "codex",
      codexBin,
      codexModel: "gpt-5.5",
      codexEffort: "max",
      executorFast: true,
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
    assert(
      /acceptance criteria are visual/i.test(prompt) &&
        /capture a screenshot or image file, actually view it/i.test(prompt) &&
        /verified only by code reading/i.test(prompt),
      "system prompt must require visual evidence for visual delegations (render + view, not code-read)"
    );
    assert(
      /Edit and Write are blocked/i.test(prompt) && /NO file-edit tools/i.test(prompt),
      "system prompt must state Claude has no file-edit tools (all code written by Codex)"
    );
    assert(
      !/you write the UI code directly/i.test(prompt) && !/Edit or Write UI files directly/i.test(prompt),
      "system prompt must not invite Claude to write code directly"
    );
    assert(/Full-file replacement is still valid/i.test(prompt), "system prompt must allow justified full-file replacements through Codex");
    assert(/Speed and exploration routing/i.test(prompt), "system prompt must include Codex-fed exploration guidance");
    assert(/exploratory work, file fetching, large searches/i.test(prompt), "system prompt must route broad exploration through Codex");
    assert(/Bash is blocked/i.test(prompt), "system prompt must state Bash is blocked for Claude");
    assert(/ALL execution work goes through Codex/i.test(prompt), "system prompt must route execution through Codex");
    assert(/Read\/Grep\/Glob/i.test(prompt), "system prompt must keep read-only review through Read/Grep/Glob");
    assert(
      /capability you do not have directly/i.test(prompt) &&
        /delegate to Codex instead of guessing, refusing, or describing your limitation/i.test(prompt) &&
        /future tool or environment\s+capability outside your direct Read\/Grep\/Glob surface/i.test(prompt) &&
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
      adapter.tool_timeout_sec === 14_400,
      "fusion-codex MCP tool calls should stay alive for the four-hour planner ceiling"
    );
    assert(
      adapter.env.CODEX_HOME && adapter.env.CODEX_HOME.endsWith(".codex"),
      "adapter env missing CODEX_HOME (needed so the embedded binary reuses the user's login)"
    );
    assert(files.settingsFile && fs.existsSync(files.settingsFile), "missing Fusion Codex settings file");
    const fusionSettings = JSON.parse(fs.readFileSync(files.settingsFile, "utf8"));
    assert(fusionSettings.plannerFamily === "codex", "settings file missing the selected planner family");
    assert(fusionSettings.plannerFast === true, "settings file missing plannerFast");
    assert(fusionSettings.fastMode === true, "settings file missing Claude planner fastMode");
    assert(fusionSettings.executorFamily === "codex", "settings file missing the selected executor family");
    assert(fusionSettings.executorFast === true, "settings file missing executorFast");
    assert(fusionSettings.codexModel === "gpt-5.5", "settings file missing the selected Codex model");
    assert(fusionSettings.codexEffort === "max", "settings file missing the selected Codex effort");
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
        buildFusionSystemPrompt().includes("Edit and Write are blocked"),
      "buildFusionSystemPrompt is missing the read-only/speed routing instructions"
    );
    assert(
      buildFusionSystemPrompt().includes("goalReached"),
      "buildFusionSystemPrompt is missing the structured verifier fields"
    );
    assert(
      buildFusionSystemPrompt().includes("Codex-managed blocked"),
      "buildFusionSystemPrompt is missing protected native goal status behavior"
    );
    assert(
      buildFusionSystemPrompt().includes("Concurrent edits (shared checkout)") &&
        buildFusionSystemPrompt().includes("hold that") &&
        buildFusionSystemPrompt().includes("Codex editing files"),
      "buildFusionSystemPrompt is missing the concurrent-edits (foreign drift) guidance"
    );
    assert(
      buildFusionSystemPrompt().includes("## Checkpointed delegation") &&
        buildFusionSystemPrompt().includes("ONE codex_implement call per milestone") &&
        buildFusionSystemPrompt().includes("BEFORE delegating the") &&
        buildFusionSystemPrompt().includes("Withholding forward knowledge") &&
        buildFusionSystemPrompt().includes("expected checkpoint state"),
      "buildFusionSystemPrompt is missing the checkpointed delegation protocol"
    );
    assert(
      buildFusionSystemPrompt().includes("## Background delegation") &&
        buildFusionSystemPrompt().includes("FUSION BACKGROUND TASK") &&
        buildFusionSystemPrompt().includes("Default stays FOREGROUND") &&
        buildFusionSystemPrompt().includes("codex_cancel {taskId}") &&
        buildFusionSystemPrompt().includes("codex_task_status") &&
        buildFusionSystemPrompt().includes("asks how a background task is going") &&
        buildFusionSystemPrompt().includes("Plan mode") &&
        buildFusionSystemPrompt().includes("Never run milestones that"),
      "buildFusionSystemPrompt is missing the background delegation contract"
    );
    assert(
      buildFusionSystemPrompt().includes("switch families mid-thread"),
      "buildFusionSystemPrompt is missing the mid-thread engine/model identity clause"
    );
    assert(
      buildFusionSystemPrompt().includes("The executor preflights named capabilities") &&
        buildFusionSystemPrompt().includes("tell the user exactly what to connect") &&
        buildFusionSystemPrompt().includes("hold the dependent"),
      "buildFusionSystemPrompt is missing the capability connect-escalation rule"
    );
    assert(
      buildFusionSystemPrompt().includes("## Orchestration triage") &&
        buildFusionSystemPrompt().includes("cheapest sufficient level") &&
        buildFusionSystemPrompt().includes("parallel scouts") &&
        buildFusionSystemPrompt().includes("Never scout what one read answers"),
      "buildFusionSystemPrompt is missing the orchestration triage ladder"
    );
    assert(
      buildFusionSystemPrompt().includes("## Parallel execution safety check") &&
        buildFusionSystemPrompt().includes("Disjoint file ownership") &&
        buildFusionSystemPrompt().includes("No ordering dependency") &&
        buildFusionSystemPrompt().includes("fileConflicts") &&
        buildFusionSystemPrompt().includes("integration verification") &&
        buildFusionSystemPrompt().includes("never auto-completes the native goal"),
      "buildFusionSystemPrompt is missing the mandatory parallel execution safety check"
    );
    assert(
      buildFusionSystemPrompt().includes("MAY run as one parallel fan-out"),
      "buildFusionSystemPrompt should allow independent milestones to fan out after the safety check"
    );
    {
      const hostSource = fs.readFileSync(path.join(rootDir, "backend", "fusionChatHost.cjs"), "utf8");
      assert(
        /Right-size the research/.test(hostSource) && /parallel scouts/.test(hostSource),
        "planModeDirective should steer plan-mode research through right-sized parallel scouts"
      );
    }
    const mainSource = fs.readFileSync(path.join(rootDir, "backend", "main.cjs"), "utf8");
    assert(/function fusionClaudeAllowedTools/.test(mainSource), "Fusion allowed tools helper not found in main.cjs");
    assert(/function fusionClaudeTools/.test(mainSource), "Fusion --tools helper not found in main.cjs");
    function extractStringArrayConst(source, constName) {
      const match = source.match(new RegExp(`const\\s+${constName}\\s*=\\s*\\[([\\s\\S]*?)\\];`));
      assert(match, `${constName} not found in main.cjs`);
      return [...match[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]);
    }
    const bridgeTools = extractStringArrayConst(mainSource, "FUSION_CODEX_BRIDGE_TOOLS");
    const builtinTools = extractStringArrayConst(mainSource, "FUSION_CLAUDE_BUILTIN_TOOLS");
    const allowList = [...builtinTools, ...bridgeTools];
    assert(
      ["Edit", "Write", "NotebookEdit", "Bash"].every(
        (tool) => !allowList.includes(tool)
      ),
      "Fusion Claude allowlist must not grant any write/execution tools - all code goes through Codex"
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
      allowList.some((entry) => entry.includes("codex_steer_resolve")),
      "Fusion allowlist should expose codex_steer_resolve for planner-first mid-turn steering"
    );
    assert(
      allowList.some((entry) => entry.includes("codex_watch_build")),
      "Fusion allowlist should expose codex_watch_build for host-supervised detached builds"
    );
    assert(
      allowList.some((entry) => entry.includes("codex_task_status")),
      "Fusion allowlist should expose the read-only detached-task status peek"
    );
    assert(
      mainSource.includes("getBuildSupervisorDir()") &&
        mainSource.includes("buildSupervisorDir: getBuildSupervisorDir()"),
      "Fusion launch should pass the host build-supervisor directory to the adapter"
    );
    assert(
      /disallowedTools:\s*fusionClaudeDisallowedTools\(\)/.test(mainSource) &&
        /return \["Bash", \.\.\.FUSION_CLAUDE_EDIT_DENY_TOOLS\]\.join\(","\)/.test(mainSource),
      "Fusion Claude must hard-block Bash plus the edit tools via --disallowedTools"
    );
    const editDenyTools = extractStringArrayConst(
      mainSource,
      "FUSION_CLAUDE_EDIT_DENY_TOOLS"
    );
    assert(
      ["Edit", "Write", "NotebookEdit"].every((tool) =>
        editDenyTools.includes(tool)
      ),
      "Fusion Claude edit deny list must hard-block every current file-edit tool"
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
      // The executor effort must come ONLY from executor fields (legacy
      // codexEffort included) — the old `?? payload.effort` fallback silently
      // applied the PLANNER effort to every delegation whenever execution was
      // on Auto.
      !/payload\.codexEffort \?\? payload\.effort/.test(mainSource) &&
        !/payload\.executorEffort \?\? payload\.effort/.test(mainSource) &&
        /payload\.executorEffort \?\? payload\.codexEffort/.test(mainSource) &&
        /executorEffort: fusionExecutorEffort/.test(mainSource) &&
        /effort: plannerEffort/.test(mainSource) &&
        // Per-role families reach both the telemetry files and the host.
        /normalizeFusionFamily\(payload\.plannerFamily, "claude"\)/.test(mainSource) &&
        /normalizeFusionFamily\(payload\.executorFamily, "codex"\)/.test(mainSource) &&
        /plannerFamily,\s*\n\s*plannerFast,/.test(mainSource) &&
        /settingsFile: files\.settingsFile/.test(mainSource) &&
        /executorFast/.test(mainSource),
      "Fusion launch should pass independent per-role effort/family/fast settings"
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
      /subtype: "apply_flag_settings"/.test(hostSource) &&
        /settings: \{ fastMode: state\.plannerFast \}/.test(hostSource),
      "Fusion chat host should apply Claude planner fastMode live"
    );
    assert(
      /FUSION PLAN MODE IS ACTIVE/.test(hostSource) &&
        /msg\.type === "mode"/.test(hostSource) &&
        /const runMode = normalizeFusionRunMode\(state\.mode\);/.test(hostSource) &&
        /buildFusionInputContent\(text, runMode, steer, nudge\)/.test(hostSource),
      "Fusion chat host should apply the Plan mode read-only turn directive (with the completion-gate nudge arm)"
    );

    assert(
      /rawExecutorModel/.test(mainSource) &&
        /rawExecutorModel\.toLowerCase\(\) !== "auto"/.test(mainSource) &&
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
