// Fusion settings-layer smoke.
//
// Locks the 2026-07-02 rewrite of the Fusion pane's model/effort selection:
// per-engine effort enums (codex has NO "max" — verified against the codex
// 0.142 binary: minimal|low|medium|high|xhigh|ultra), legacy "max"→"xhigh"
// coercion at every layer, model validation before restart, and the
// menu-activation trap fixes. Source-contract checks (grep-style, like
// workspace-smoke) because the pane's helpers live inside the component.

const fs = require("fs");
const path = require("path");

const rootDir = path.join(__dirname, "..", "..");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

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

// ---- per-engine effort enums ----
assert(
  pane.includes("CODEX_EFFORT_LABELS") &&
    pane.includes('ultra: "Ultra"') &&
    pane.includes('minimal: "Minimal"'),
  "pane must carry codex's own effort vocabulary (minimal..ultra)"
);
assert(
  !/CODEX_EFFORT_LABELS[^}]*max:/s.test(pane.slice(pane.indexOf("CODEX_EFFORT_LABELS"), pane.indexOf("CODEX_EFFORT_LABELS") + 400)),
  "codex effort labels must NOT offer 'max' — codex rejects it as an unknown variant"
);
assert(
  pane.includes('applySettings({ codexEffort: "xhigh" }, "execution speed")') &&
    pane.includes('claudeEffort: "max", codexEffort: "xhigh"'),
  "speed presets must map the top execution level to xhigh, never codex 'max'"
);

// ---- legacy max→xhigh coercion at every layer ----
for (const [name, source] of [
  ["FusionChatPane", pane],
  ["App.tsx", app],
  ["main.cjs", main]
]) {
  assert(
    /if \(\s*(value|effort)\s*===\s*"max"\s*\)\s*(\{\s*)?return "xhigh"/.test(source),
    `${name} must coerce legacy codex effort "max" to "xhigh"`
  );
}
assert(
  adapter.includes("function cleanCodexEffort") &&
    adapter.includes('=== "max" ? "xhigh"'),
  "fusion-adapter must self-heal stale fusion-settings.json/env carrying 'max'"
);
assert(
  main.includes("normalizeFusionCodexEffort(payload.codexEffort ?? payload.effort)") &&
    main.includes("normalizeFusionCodexEffort(payload.codexEffort)"),
  "main must route BOTH codex-effort ingestion points through the codex normalizer"
);

// ---- model validation before restart ----
assert(
  pane.includes("CLAUDE_MODEL_ALIAS_PATTERN") &&
    pane.includes("isValidClaudeModelId(settings.model)") &&
    pane.includes("is not a Claude model this pane can launch"),
  "pane must refuse unknown planning-model ids instead of restarting into a dead claude process"
);
assert(
  pane.includes("Unknown speed preset"),
  "unknown /speed values must error, not be reinterpreted as a planning model"
);

// ---- menu activation traps ----
assert(
  pane.includes('lower === "/claude" || lower.startsWith("/claude ")'),
  "'/claude ' must open a Planning Model submenu (previously fell back to the command list with /plan at index 0)"
);
assert(
  /if \(\/\\s\/\.test\(trimmed\)\) \{\s*return \{ title: "", items: \[\] \};/.test(pane),
  "unmatched command-with-argument input must yield an empty menu, never the full command list"
);
assert(
  pane.includes('e.key === "Tab" && e.shiftKey && !slashMenuOpen'),
  "Shift+Tab must not toggle Plan/Auto while the slash menu is open"
);

// ---- catalogs + transcript preservation ----
assert(
  pane.includes("CODEX_MODEL_OPTIONS") &&
    pane.includes('"gpt-5.1-codex-max"') &&
    pane.includes('id: "sonnet", label: `Model ${SONNET_LABEL}`'),
  "pane must ship curated Claude/Codex model catalogs (incl. Sonnet in the planning options)"
);
assert(
  /setMessages\(\(prev\) =>\s*restartNotice\s*\?\s*\[\s*\.\.\.prev,/.test(pane),
  "settings restarts must keep the visible transcript and append the notice"
);

console.log("Fusion settings smoke passed");
