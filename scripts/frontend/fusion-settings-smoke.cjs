// Fusion settings-layer smoke.
//
// Locks the Fusion pane's per-role FAMILY/model/effort selection behavior:
// each role (planner/executor) picks a family — Claude (claude CLI) or Codex
// (codex app-server) — then a model, through an Open Fusion-style two-stage
// picker. Per-family effort enums (codex has NO "max" — verified against the
// codex 0.142 binary: minimal|low|medium|high|xhigh|ultra), legacy
// "max"→"xhigh" coercion at every layer, legacy field migration
// (model/claudeEffort → planner, codexModel/codexEffort → executor), model
// validation before restart, and the menu-activation semantics.
//
// The slash-menu logic lives in frontend/components/fusionSlashMenu.ts (pure,
// extracted exactly so this smoke can exercise REAL behavior): it is
// esbuild-transpiled and imported here. Wiring that still lives inside the
// component (keydown handlers, IPC) is covered by source-contract greps.

const fs = require("fs");
const path = require("path");
const esbuild = require("esbuild");

const rootDir = path.join(__dirname, "..", "..");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

// ---- load the real menu module ----
const menuSource = path.join(rootDir, "frontend", "components", "fusionSlashMenu.ts");
const compiled = esbuild.transformSync(fs.readFileSync(menuSource, "utf8"), {
  loader: "ts",
  format: "cjs"
}).code;
const menuModule = { exports: {} };
new Function("module", "exports", "require", compiled)(
  menuModule,
  menuModule.exports,
  require
);
const {
  buildFusionPicker,
  buildSlashMenu,
  familyMaxEffort,
  normalizeFusionCodexEffort,
  normalizeFusionModel,
  normalizeFusionRoleEffort,
  normalizeFusionRoleSettings,
  isValidClaudeModelId,
  resolveModelArgument,
  CODEX_EFFORT_VALUES,
  FREE_TEXT_SLASH_COMMANDS,
  FUSION_SPEED_VALUES,
  FUSION_SLASH_COMMANDS
} = menuModule.exports;

// ---- per-engine effort enums ----
assert(
  !CODEX_EFFORT_VALUES.includes("max") &&
    CODEX_EFFORT_VALUES.includes("minimal") &&
    CODEX_EFFORT_VALUES.includes("ultra"),
  "codex effort enum must be codex's own (minimal..ultra, NO 'max' — codex rejects it)"
);
assert(
  normalizeFusionCodexEffort("max") === "xhigh",
  "legacy codex effort 'max' must coerce to 'xhigh'"
);
assert(
  normalizeFusionCodexEffort(undefined) === "auto",
  "absent codex effort means auto — never inherited from the claude effort"
);
// Cross-family coercion: a saved effort survives a family flip at the nearest
// real level instead of failing every turn as an unknown variant.
assert(
  normalizeFusionRoleEffort("claude", "ultra") === "max" &&
    normalizeFusionRoleEffort("claude", "minimal") === "low" &&
    normalizeFusionRoleEffort("codex", "max") === "xhigh",
  "efforts must coerce across families at the nearest real level"
);
assert(
  familyMaxEffort("claude") === "max" && familyMaxEffort("codex") === "xhigh",
  "the 'max' preset must map to each family's own top level"
);

// ---- model validation ----
assert(
  isValidClaudeModelId("opus") &&
    isValidClaudeModelId("sonnet") &&
    isValidClaudeModelId("fable") &&
    isValidClaudeModelId("claude-opus-4-8") &&
    !isValidClaudeModelId("gpt-5.5") &&
    !isValidClaudeModelId("son"),
  "claude model validation must accept known aliases + claude-* ids and refuse the rest"
);
assert(
  normalizeFusionModel("fast") === "sonnet",
  "the 'fast' shorthand maps to sonnet"
);

// ---- legacy migration: old fields land on the right roles ----
{
  const migrated = normalizeFusionRoleSettings({
    model: "sonnet",
    claudeEffort: "max",
    codexModel: "gpt-5.5",
    codexEffort: "max"
  });
  assert(
    migrated.plannerFamily === "claude" &&
      migrated.plannerModel === "sonnet" &&
      migrated.plannerEffort === "max" &&
      migrated.plannerFast === false &&
      migrated.executorFamily === "codex" &&
      migrated.executorModel === "gpt-5.5" &&
      migrated.executorEffort === "xhigh" &&
      migrated.executorFast === false,
    "legacy settings must migrate to planner(claude)/executor(codex) with per-family effort coercion"
  );
}
{
  const defaults = normalizeFusionRoleSettings(null);
  assert(
      defaults.plannerFamily === "claude" &&
      defaults.plannerModel === "opus" &&
      defaults.plannerFast === false &&
      defaults.executorFamily === "codex" &&
      defaults.executorModel === "auto" &&
      defaults.executorFast === false,
    "empty settings must land on the stock planner opus / executor codex-default pair with fast serving off"
  );
}
{
  const explicit = normalizeFusionRoleSettings({
    plannerFast: true,
    executorFast: true
  });
  assert(
    explicit.plannerFast === true && explicit.executorFast === true,
    "explicit fast serving flags must survive settings normalization"
  );
}

// ---- typed model arguments resolve to a family (or refuse) ----
assert(
  resolveModelArgument("codex/gpt-5.5")?.family === "codex" &&
    resolveModelArgument("claude/sonnet")?.family === "claude" &&
    resolveModelArgument("opus")?.family === "claude" &&
    resolveModelArgument("gpt-5.5")?.family === "codex" &&
    resolveModelArgument("totally-unknown-model") === null,
  "typed model args must resolve by slug or shape and refuse unattributable ids"
);

// ---- the Open Fusion-style picker: family stage → model stage ----
{
  // Family stage: the role's CURRENT family leads and is marked, so Enter
  // drills into where the user already is (never a silent switch).
  const menu = buildFusionPicker({ role: "planner" }, "", { plannerFamily: "codex" });
  assert(
    menu.items[0]?.command === "__family:codex" &&
      menu.items[0]?.desc.includes("current") &&
      menu.items.some((item) => item.command === "__family:claude"),
    "planner family stage must lead with the current family marked as current"
  );
}
{
  // Model stage: current model marked + front-loaded — Enter is a no-op pick.
  const menu = buildFusionPicker(
    { role: "planner", family: "codex" },
    "",
    { plannerFamily: "codex", plannerModel: "gpt-5.5" }
  );
  assert(
    menu.items[0]?.command === "__model:codex/gpt-5.5" &&
      menu.items[0]?.desc.includes("current"),
    "picker model stage must lead with the CURRENT model marked as current"
  );
}
{
  // Executor on the Claude family — the cross-family quadrant.
  const menu = buildFusionPicker(
    { role: "executor", family: "claude" },
    "",
    { executorFamily: "claude", executorModel: "sonnet" }
  );
  assert(
    menu.items[0]?.command === "__model:claude/sonnet" &&
      menu.items[0]?.desc.includes("current"),
    "executor claude model stage must mark the current claude executor model"
  );
}
{
  // Unmatched-but-launchable id → explicit "Use '<id>'" escape row.
  const menu = buildFusionPicker(
    { role: "executor", family: "codex" },
    "gpt-9-custom",
    { executorFamily: "codex", executorModel: "auto" }
  );
  assert(
    menu.items.length === 1 &&
      menu.items[0].command === "__model:codex/gpt-9-custom",
    "an unmatched valid id in the picker must surface as a 'Use <id>' row"
  );
}
{
  const visibleCommands = FUSION_SLASH_COMMANDS.map((cmd) => cmd.name);
  assert(
    JSON.stringify(visibleCommands) ===
      JSON.stringify([
        "/plan",
        "/auto",
        "/mode",
        "/planner",
        "/executor",
        "/models",
        "/details",
        "/compact",
        "/resume",
        "/clear",
        "/help"
      ]),
    "the visible Fusion slash palette must expose one settings submenu per role"
  );
  assert(
    !visibleCommands.includes("/planner-model") &&
      !visibleCommands.includes("/executor-model") &&
      !visibleCommands.includes("/speed") &&
      !visibleCommands.includes("/effort") &&
      !visibleCommands.includes("/fast"),
    "legacy typed settings commands must not remain as top-level visible menu entries"
  );
  const menu = buildSlashMenu("/");
  assert(
    menu.items.map((item) => item.command || item.fill).includes("/planner ") &&
      menu.items.map((item) => item.command || item.fill).includes("/executor ") &&
      !menu.items.some((item) =>
        ["/planner-model", "/executor-model", "/speed ", "/effort ", "/fast"].includes(
          item.command || item.fill
        )
      ),
    "top-level slash menu rows must drill into /planner and /executor, not the old overlapping settings trees"
  );
}

// ---- role settings submenus: model + effort + fast per role ----
{
  const context = {
    plannerFamily: "claude",
    plannerModel: "sonnet",
    plannerEffort: "high",
    plannerFast: true,
    executorFamily: "codex",
    executorModel: "gpt-5.5",
    executorEffort: "ultra",
    executorFast: false
  };
  const menu = buildSlashMenu("/planner ", context);
  const model = menu.items.find((item) => item.key === "planner-control-model");
  const effort = menu.items.find((item) => item.command === "/effort planning high");
  const fastOn = menu.items.find((item) => item.command === "/fast planner on");
  const fastOff = menu.items.find((item) => item.command === "/fast planner off");
  assert(
    menu.title === "Planner (Claude)" &&
      model?.label === "Model — Sonnet 4.5" &&
      model.command === "/planner-model" &&
      effort?.label === "Effort — High" &&
      effort.desc.includes("current") &&
      fastOn?.label === "Fast serving — On" &&
      fastOn.desc.includes("current") &&
      fastOff?.label === "Fast serving — Off" &&
      !fastOff.desc.includes("current"),
    "/planner submenu must expose model picker, current effort, and current fast-serving controls"
  );
}
{
  const context = {
    plannerFamily: "claude",
    plannerModel: "opus",
    plannerEffort: "auto",
    plannerFast: false,
    executorFamily: "codex",
    executorModel: "gpt-5.5",
    executorEffort: "ultra",
    executorFast: false
  };
  const menu = buildSlashMenu("/executor ", context);
  const model = menu.items.find((item) => item.key === "executor-control-model");
  const effort = menu.items.find((item) => item.command === "/effort execution ultra");
  const fastOn = menu.items.find((item) => item.command === "/fast executor on");
  const fastOff = menu.items.find((item) => item.command === "/fast executor off");
  assert(
    menu.title === "Executor (Codex)" &&
      model?.label === "Model — GPT-5.5" &&
      model.command === "/executor-model" &&
      effort?.label === "Effort — Ultra" &&
      effort.desc.includes("current") &&
      fastOn?.label === "Fast serving — On" &&
      fastOff?.label === "Fast serving — Off" &&
      fastOff.desc.includes("current") &&
      !menu.items.some((item) => item.label === "Effort — Max"),
    "/executor submenu must expose the Codex effort enum (Ultra present, Max absent) and current fast-serving controls"
  );
}
{
  const plannerFast = buildSlashMenu("/planner fast", {
    plannerFamily: "claude",
    plannerFast: true
  });
  const executorEffort = buildSlashMenu("/executor effort", {
    executorFamily: "codex",
    executorEffort: "ultra"
  });
  assert(
    plannerFast.items.some((item) => item.command === "/fast planner on") &&
      plannerFast.items.some((item) => item.command === "/fast planner off") &&
      executorEffort.items.some((item) => item.command === "/effort execution ultra") &&
      !executorEffort.items.some((item) => item.command === "/effort execution max"),
    "role submenu filtering must keep per-role fast and effort settings reachable by clicking"
  );
}

// ---- menu behavior: bare '/claude' must NOT commit a model reset ----
// The CURRENT model leads the list, so Enter (activates index 0) is a
// harmless "Already using …" no-op instead of silently reverting to Opus.
{
  const menu = buildSlashMenu("/claude", { plannerFamily: "claude", plannerModel: "sonnet" });
  assert(
    menu.items[0]?.command === "/claude sonnet" &&
      menu.items[0]?.desc.includes("current"),
    "bare /claude must lead with the CURRENT model marked as current"
  );
}
{
  const menu = buildSlashMenu("/codex", { executorFamily: "codex", executorModel: "gpt-5.5" });
  assert(
    menu.items[0]?.command === "/codex gpt-5.5" &&
      menu.items[0]?.desc.includes("current"),
    "bare /codex must lead with the CURRENT execution model marked as current"
  );
}
{
  // A custom current model (outside the catalog) still leads the list.
  const menu = buildSlashMenu("/claude", {
    plannerFamily: "claude",
    plannerModel: "claude-opus-4-6"
  });
  assert(
    menu.items[0]?.command === "/claude claude-opus-4-6",
    "a custom current planning model must lead the /claude submenu"
  );
}

// ---- menu behavior: typing after /claude FILTERS instead of closing ----
assert(
  !FREE_TEXT_SLASH_COMMANDS.includes("/claude"),
  "/claude must not be a free-text command — its argument filters the submenu"
);
{
  const menu = buildSlashMenu("/claude son", { plannerFamily: "claude", plannerModel: "opus" });
  assert(
    menu.items.length === 1 && menu.items[0].command === "/claude sonnet",
    "typing '/claude son' must filter the submenu down to Sonnet"
  );
}
{
  // Unmatched-but-launchable id → explicit "Use '<id>'" escape row.
  const menu = buildSlashMenu("/claude claude-opus-4-6", {
    plannerFamily: "claude",
    plannerModel: "opus"
  });
  assert(
    menu.items.length === 1 &&
      menu.items[0].command === "/claude claude-opus-4-6" &&
      menu.items[0].label.includes("claude-opus-4-6"),
    "an unmatched valid claude id must surface as a 'Use <id>' row"
  );
}
{
  // Unmatched AND unlaunchable → empty menu (Enter then hits validation).
  const menu = buildSlashMenu("/claude gpt-5.5", {
    plannerFamily: "claude",
    plannerModel: "opus"
  });
  assert(
    menu.items.length === 0,
    "an id claude can't launch must NOT get a menu row"
  );
}
{
  const context = {
    plannerFamily: "claude",
    plannerModel: "opus",
    liveCatalog: {
      claude: [
        { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
        { id: "sonnet", label: "Duplicate Sonnet Alias" }
      ]
    }
  };
  const menu = buildSlashMenu("/claude", context);
  assert(
    menu.items[0]?.command === "/claude opus" &&
      menu.items[1]?.command === "/claude sonnet" &&
      menu.items[2]?.command === "/claude fable" &&
      menu.items[3]?.command === "/claude claude-sonnet-5" &&
      menu.items[3]?.label === "Claude Sonnet 5" &&
      !menu.items.some((item) => item.key.includes("live-sonnet")),
    "live Claude catalog rows must append below curated aliases and dedupe ids already in the curated list"
  );
  const picker = buildFusionPicker({ role: "planner" }, "", context);
  assert(
    picker.items.find((item) => item.command === "__family:claude")?.desc.includes("4 models"),
    "family picker counts must include curated + deduped live Claude models"
  );
}
{
  const menu = buildSlashMenu("/claude", {
    plannerFamily: "claude",
    plannerModel: "claude-sonnet-5",
    liveCatalog: {
      claude: [{ id: "claude-sonnet-5", label: "Claude Sonnet 5" }]
    }
  });
  assert(
    menu.items[0]?.command === "/claude claude-sonnet-5" &&
      menu.items[0]?.desc.includes("current"),
    "a selected live Claude model must be marked current and moved to the front"
  );
}
{
  const menu = buildSlashMenu("/codex gpt-5.4-custom", {
    executorFamily: "codex",
    executorModel: "auto"
  });
  assert(
    menu.items.length === 1 && menu.items[0].command === "/codex gpt-5.4-custom",
    "an unmatched codex id must surface as a 'Use <id>' row"
  );
}

// ---- menu activation traps stay fixed ----
{
  const menu = buildSlashMenu("/speed maxx");
  assert(
    menu.items.length === 0,
    "unmatched command-with-argument input must yield an empty menu, never the full command list"
  );
}
{
  assert(
    FUSION_SPEED_VALUES.includes("quick") && !FUSION_SPEED_VALUES.includes("fast"),
    "the old downgrade speed preset must be named quick, not fast"
  );
  const menu = buildSlashMenu("/speed");
  assert(
    menu.items.some((item) => item.command === "/speed fusion quick") &&
      !menu.items.some((item) => item.command === "/speed fusion fast"),
    "/speed must present quick as the primary downgrade preset"
  );
}
{
  const menu = buildSlashMenu("/claude ");
  assert(
    menu.title === "Planner Model (Claude)" && menu.items.length > 0,
    "'/claude ' must open the Planner Model submenu"
  );
}

// ---- source contracts for wiring that lives inside the components ----
const pane = fs.readFileSync(
  path.join(rootDir, "frontend", "components", "FusionChatPane.tsx"),
  "utf8"
);
const app = fs.readFileSync(path.join(rootDir, "frontend", "App.tsx"), "utf8");
const main = fs.readFileSync(path.join(rootDir, "backend", "main.cjs"), "utf8");
const preload = fs.readFileSync(path.join(rootDir, "preload", "preload.cjs"), "utf8");
const adapter = fs.readFileSync(
  path.join(rootDir, "backend", "fusion-adapter.cjs"),
  "utf8"
);
const host = fs.readFileSync(
  path.join(rootDir, "backend", "fusionChatHost.cjs"),
  "utf8"
);

// The planner effort must NEVER leak into the executor effort: the pane omits
// the executor effort when it's auto, and main used to backfill it from the
// PLANNER effort (`payload.codexEffort ?? payload.effort`) — the UI then said
// "Execution Auto" while every delegation ran at the planner's level.
assert(
  !main.includes("payload.codexEffort ?? payload.effort") &&
    !main.includes("payload.executorEffort ?? payload.effort") &&
    main.includes("payload.executorEffort ?? payload.codexEffort"),
  "main must read the executor effort ONLY from executor fields (legacy codexEffort ok, planner effort never)"
);
assert(
  main.includes('ipcMain.handle("fusion-model-catalog:list"') &&
    main.includes("fetchClaudeModelCatalog") &&
    main.includes('return { ok: true, family, models: null };'),
  "main must expose Claude live model catalog IPC with null fallback for non-live families/failures"
);
assert(
  preload.includes("fusionModelCatalog") &&
    preload.includes('ipcRenderer.invoke("fusion-model-catalog:list", payload)'),
  "preload must expose only the sanitized Fusion model catalog IPC surface"
);
assert(
  pane.includes("liveModelCatalog") &&
    pane.includes("window.vibe?.fusionModelCatalog?.list") &&
    pane.includes("liveCatalog: liveModelCatalog"),
  "FusionChatPane must fetch live catalogs and pass them into the shared picker context"
);
// All three layers route legacy "max" through per-family coercion.
assert(
  app.includes("normalizeFusionRoleSettings"),
  "App must normalize Fusion settings through the shared per-role funnel"
);
assert(
  /if \(lower === "max"\) \{\s*\n\s*return "xhigh";/.test(
    fs.readFileSync(menuSource, "utf8")
  ),
  "the menu module must coerce legacy codex effort 'max' to 'xhigh'"
);
assert(
  adapter.includes("function cleanCodexEffort") &&
    adapter.includes('=== "max" ? "xhigh"'),
  "fusion-adapter must self-heal stale fusion-settings.json/env carrying 'max'"
);

// Model validation before restart + speed-preset honesty.
assert(
  pane.includes("isValidFamilyModelId(nextPlannerFamily, settings.plannerModel)") &&
    pane.includes("is not a Claude model this pane can launch"),
  "pane must refuse unknown planner-model ids instead of restarting into a dead process"
);
assert(
  pane.includes("Unknown speed preset"),
  "unknown /speed values must error, not be reinterpreted as a planning model"
);

// Speed/effort shortcuts must not clobber the model pick: only the "quick"
// downgrade preset may set one.
assert(
  !pane.includes('plannerModel: "opus", plannerEffort'),
  "non-quick presets must NOT force the model back to opus"
);
assert(
  pane.includes('if (preset === "quick")') &&
    pane.includes("quickPlannerModel") &&
    pane.includes('applySettings({ plannerModel: quickPlannerModel, plannerEffort: "low" }, "planning speed")'),
  "/speed quick must keep the old downgrade behavior under the new name"
);
assert(
  pane.includes('applySettings({ plannerEffort: "high" }, "planning speed")') &&
    pane.includes('applySettings({ plannerEffort: "auto", executorEffort: "auto" }, "Fusion speed")'),
  "balanced/deep presets must be effort-only (model-preserving)"
);
assert(
  pane.includes("familyMaxEffort(executorFamily)"),
  "the top execution level must come from the executor family's own enum (xhigh for codex), never codex 'max'"
);
assert(
  !pane.includes('applySpeedPreset("harness", "fast")') &&
    pane.includes('applySettings({ plannerFast: next, executorFast: next }, "fast serving")') &&
    pane.includes('normalized === "/fast" || normalized.startsWith("/fast ")') &&
    pane.includes("Use /planner and /executor to set each role's model, effort, and fast serving") &&
    pane.includes("Advanced: /planner-model, /executor-model"),
  "/fast must toggle real fast serving flags instead of invoking the old speed preset"
);
assert(
  pane.includes('function normalizeFamilyAliasScope') &&
    pane.includes('normalizeFamilyAliasScope("claude", "planning")') &&
    pane.includes('normalizeFamilyAliasScope("codex", "execution")') &&
    pane.includes("plannerMatches !== executorMatches") &&
    pane.includes("scope = normalizeRoleScope(lower)"),
  "family aliases in /fast, /speed, and /effort must resolve against the selected planner/executor families"
);
assert(
  !pane.includes("Pick another with /claude.") &&
    pane.includes("Pick another with /planner-model."),
  "planner model errors must point at /planner-model so Codex planners are not told to use Claude-only shorthand"
);
assert(
  pane.includes('plannerFamilyRef.current !== "claude"') &&
    pane.includes("Context compaction isn't available for the Codex planner.") &&
    pane.includes('window.vibe?.fusionChat?.sendUserTurn(session.id, "/compact")'),
  "/compact must stay Claude-planner only and must not send a literal /compact turn to a Codex planner"
);
assert(
  pane.includes("function askHumanPromptFromResult") &&
    pane.includes("setPendingDecision(pending)") &&
    pane.includes("askHumanPromptFromResult(parsed)") &&
    pane.includes("disabled={modeSwitching || implementingPlan}"),
  "ask_human tool results must prompt for typed user input without disabling the composer"
);
{
  const paneRestartBlock = pane.slice(
    pane.indexOf("const requiresRestart ="),
    pane.indexOf("const notice = session.started")
  );
  const appRestartBlock = app.slice(
    app.indexOf("const requiresRestart ="),
    app.indexOf("const executorSettingsChanged =")
  );
  assert(
    !paneRestartBlock.includes("plannerFast") &&
      !paneRestartBlock.includes("executorFast") &&
      !appRestartBlock.includes("plannerFast") &&
      !appRestartBlock.includes("executorFast"),
    "fast serving flag changes must not enter the pane restart predicate"
  );
  assert(
    app.includes("fastSettingsChanged") &&
      app.includes("plannerFast: next.plannerFast") &&
      app.includes("executorFast: next.executorFast"),
    "fast serving changes must use the live update-settings path"
  );
}

// Composer navigation: Esc dismisses the menu without erasing input (and backs
// a picker out one stage per press); Shift+Tab never toggles the mode while a
// slash command is being typed; Tab in slash input can't blur the composer;
// hover-highlight arms on real mouse movement.
assert(
  pane.includes("setSlashMenuDismissed(true)") &&
    pane.includes("!slashMenuDismissed"),
  "Esc must dismiss the slash menu while KEEPING the typed input"
);
assert(
  pane.includes('if (picker && "role" in picker && picker.family)') &&
    pane.includes("setPicker({ role: picker.role })"),
  "Esc in the picker must back out one stage (model → family) per press"
);
// The saved-chat resume picker: /resume lists this folder's Fusion chats
// (newest first) instead of blind-resuming the stashed last chat.
assert(
  pane.includes("function openResumePicker") &&
    pane.includes('command: `__resume:${thread.id}`') &&
    pane.includes("provider: plannerFamily") &&
    pane.includes("fusion: true"),
  "/resume must open the saved-chat picker listing the planner family's chats for this folder"
);
assert(
  pane.includes('"open in another pane"') &&
    pane.includes("claimedThreadIds?.includes(threadId)"),
  "the resume picker must mark and refuse chats already open in another pane"
);
assert(
  pane.includes("!slashMenuOpen && !inputIsSlashCommand"),
  "Shift+Tab must not toggle Plan/Auto while the menu is open OR a slash command is typed"
);
assert(
  pane.includes('e.key === "Tab" && inputIsSlashCommand'),
  "Tab while typing a slash command must not blur the composer"
);
assert(
  pane.includes("onMouseMove={() => setSlashIndex(i)}") &&
    !pane.includes("onMouseEnter={() => setSlashIndex(i)}"),
  "menu hover-highlight must arm on mousemove, not on the menu appearing under the pointer"
);

// Silent dead turns: complete assistant errors + result.is_error must surface.
assert(
  host.includes('msg.type === "assistant"') &&
    host.includes('"turn-error"') &&
    host.includes("isError: Boolean(msg.is_error)") ||
    (host.includes("const isError = Boolean(msg.is_error);") &&
      host.includes('type: "turn-error"')),
  "fusionChatHost must surface synthetic assistant errors and result.is_error"
);
assert(
  pane.includes('case "turn-error"') && pane.includes("event.isError"),
  "the pane must render turn errors instead of ending the turn silently"
);

// Cross-session persistence: new panes start from the last-used settings.
assert(
  app.includes("rememberFusionSettings(") &&
    app.includes("lastFusionSettings()") &&
    app.includes("rememberOpenFusionModels(") &&
    app.includes("lastOpenFusionModels()"),
  "model picks must persist across sessions for both Fusion and Open Fusion"
);

// Transcript preservation across settings restarts.
assert(
  /setMessages\(\(prev\) =>\s*restartNotice\s*\?\s*\[\s*\.\.\.prev,/.test(pane),
  "settings restarts must keep the visible transcript and append the notice"
);

console.log("Fusion settings smoke passed");
