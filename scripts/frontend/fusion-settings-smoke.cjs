// Fusion settings-layer smoke.
//
// Locks the Fusion pane's model/effort selection behavior: per-engine effort
// enums (codex has NO "max" — verified against the codex 0.142 binary:
// minimal|low|medium|high|xhigh|ultra), legacy "max"→"xhigh" coercion at every
// layer, model validation before restart, and the menu-activation semantics.
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
  buildSlashMenu,
  normalizeFusionCodexEffort,
  normalizeFusionModel,
  isValidClaudeModelId,
  CODEX_EFFORT_VALUES,
  FREE_TEXT_SLASH_COMMANDS
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

// ---- menu behavior: bare '/claude' must NOT commit a model reset ----
// The CURRENT model leads the list, so Enter (activates index 0) is a
// harmless "Already using …" no-op instead of silently reverting to Opus.
{
  const menu = buildSlashMenu("/claude", { model: "sonnet" });
  assert(
    menu.items[0]?.command === "/claude sonnet" &&
      menu.items[0]?.desc.includes("current"),
    "bare /claude must lead with the CURRENT model marked as current"
  );
}
{
  const menu = buildSlashMenu("/codex", { codexModel: "gpt-5.5" });
  assert(
    menu.items[0]?.command === "/codex gpt-5.5" &&
      menu.items[0]?.desc.includes("current"),
    "bare /codex must lead with the CURRENT execution model marked as current"
  );
}
{
  // A custom current model (outside the catalog) still leads the list.
  const menu = buildSlashMenu("/claude", { model: "claude-opus-4-6" });
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
  const menu = buildSlashMenu("/claude son", { model: "opus" });
  assert(
    menu.items.length === 1 && menu.items[0].command === "/claude sonnet",
    "typing '/claude son' must filter the submenu down to Sonnet"
  );
}
{
  // Unmatched-but-launchable id → explicit "Use '<id>'" escape row.
  const menu = buildSlashMenu("/claude claude-opus-4-6", { model: "opus" });
  assert(
    menu.items.length === 1 &&
      menu.items[0].command === "/claude claude-opus-4-6" &&
      menu.items[0].label.includes("claude-opus-4-6"),
    "an unmatched valid claude id must surface as a 'Use <id>' row"
  );
}
{
  // Unmatched AND unlaunchable → empty menu (Enter then hits validation).
  const menu = buildSlashMenu("/claude gpt-5.5", { model: "opus" });
  assert(
    menu.items.length === 0,
    "an id claude can't launch must NOT get a menu row"
  );
}
{
  const menu = buildSlashMenu("/codex gpt-5.4-custom", { codexModel: "auto" });
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
  const menu = buildSlashMenu("/claude ");
  assert(
    menu.title === "Planning Model" && menu.items.length > 0,
    "'/claude ' must open the Planning Model submenu"
  );
}

// ---- source contracts for wiring that lives inside the components ----
const pane = fs.readFileSync(
  path.join(rootDir, "frontend", "components", "FusionChatPane.tsx"),
  "utf8"
);
const app = fs.readFileSync(path.join(rootDir, "frontend", "App.tsx"), "utf8");
const main = fs.readFileSync(path.join(rootDir, "backend", "main.cjs"), "utf8");
const adapter = fs.readFileSync(
  path.join(rootDir, "backend", "fusion-adapter.cjs"),
  "utf8"
);
const host = fs.readFileSync(
  path.join(rootDir, "backend", "fusionChatHost.cjs"),
  "utf8"
);

// Claude planning effort must NEVER leak into the codex effort: the pane
// omits codexEffort when it's auto, and main used to backfill it from the
// CLAUDE effort (`payload.codexEffort ?? payload.effort`) — the UI then said
// "Execution Auto" while every delegation ran at the claude level.
assert(
  !main.includes("payload.codexEffort ?? payload.effort") &&
    main.includes("normalizeFusionCodexEffort(payload.codexEffort)"),
  "main must read the codex effort ONLY from payload.codexEffort"
);
assert(
  /if \(\s*(value|effort)\s*===\s*"max"\s*\)\s*(\{\s*)?return "xhigh"/.test(app) &&
    /if \(\s*(value|effort)\s*===\s*"max"\s*\)\s*(\{\s*)?return "xhigh"/.test(
      fs.readFileSync(menuSource, "utf8")
    ),
  "App and the menu module must coerce legacy codex effort 'max' to 'xhigh'"
);
assert(
  adapter.includes("function cleanCodexEffort") &&
    adapter.includes('=== "max" ? "xhigh"'),
  "fusion-adapter must self-heal stale fusion-settings.json/env carrying 'max'"
);

// Model validation before restart + speed-preset honesty.
assert(
  pane.includes("isValidClaudeModelId(settings.model)") &&
    pane.includes("is not a Claude model this pane can launch"),
  "pane must refuse unknown planning-model ids instead of restarting into a dead claude process"
);
assert(
  pane.includes("Unknown speed preset"),
  "unknown /speed values must error, not be reinterpreted as a planning model"
);

// Speed/effort shortcuts must not clobber the model pick: only the "fast"
// presets (whose label advertises the faster model) may set one.
assert(
  !pane.includes('applySettings({ model: "opus", claudeEffort'),
  "/opus effort and non-fast presets must NOT force the model back to opus"
);
assert(
  pane.includes('applySettings({ claudeEffort: "high" }, "planning speed")') &&
    pane.includes('applySettings({ claudeEffort: "auto", codexEffort: "auto" }, "Fusion speed")'),
  "balanced/deep/max presets must be effort-only (model-preserving)"
);
assert(
  pane.includes('applySettings({ codexEffort: "xhigh" }, "execution speed")'),
  "speed presets must map the top execution level to xhigh, never codex 'max'"
);

// Composer navigation: Esc dismisses the menu without erasing input; Shift+Tab
// never toggles the mode while a slash command is being typed; Tab in slash
// input can't blur the composer; hover-highlight arms on real mouse movement.
assert(
  pane.includes("setSlashMenuDismissed(true)") &&
    pane.includes("!slashMenuDismissed"),
  "Esc must dismiss the slash menu while KEEPING the typed input"
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
