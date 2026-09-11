// Model/version drift watchdog for the Fusion model lists and vendored CLI pins.
//
//   node scripts/dev/model-drift.cjs [--json <path>] [--md <path>] [--no-fail]
//
// Compares the curated Fusion catalog (frontend/components/fusionSlashMenu.ts)
// and the vendored CLI versions against upstream truth:
//   - Codex: live `codex debug models` via the vendored/PATH binary (sees
//     server-side ChatGPT models); CI fallback = the bundled models.json from
//     openai/codex main, which misses server-side-only entries.
//   - Claude: api.anthropic.com/v1/models via local Claude OAuth, or
//     ANTHROPIC_API_KEY when set (CI).
//   - npm dist-tags for @openai/codex, @moonshot-ai/kimi-code (pins we hold)
//     and @anthropic-ai/claude-code / opencode-ai (informational, unpinned).
//
// Exits 1 when drift is found (unless --no-fail). Run via `npm run
// check:model-drift`; the model-drift.yml workflow runs it on a schedule and
// files the report as a GitHub issue.

const fs = require("fs");
const path = require("path");
const https = require("https");
const esbuild = require("esbuild");

const rootDir = path.join(__dirname, "..", "..");
const codexModels = require("../../backend/codexModels.cjs");
const claudeModels = require("../../backend/claudeModels.cjs");

const UPSTREAM_CODEX_MODELS_URL =
  "https://raw.githubusercontent.com/openai/codex/main/codex-rs/models-manager/models.json";
const NPM_PACKAGES = {
  codex: "@openai/codex",
  kimi: "@moonshot-ai/kimi-code",
  claude: "@anthropic-ai/claude-code",
  opencode: "opencode-ai"
};

// ---- args ----
const args = process.argv.slice(2);
function flagValue(name) {
  const index = args.indexOf(name);
  if (index < 0) return null;
  const value = args[index + 1];
  return typeof value === "string" && !value.startsWith("--") ? value : null;
}
const jsonOutPath = flagValue("--json");
const mdOutPath = flagValue("--md");
const noFail = args.includes("--no-fail");

// ---- report assembly ----
// status: "ok" | "drift" | "skipped"
const sections = [];
function addSection(title) {
  const section = { title, status: "ok", lines: [] };
  sections.push(section);
  return section;
}
function line(section, kind, text) {
  section.lines.push({ kind, text });
  if (kind === "drift") section.status = "drift";
}
function skipSection(section, reason) {
  section.status = "skipped";
  section.lines.push({ kind: "skip", text: reason });
}

// ---- our state ----
function loadCuratedMenu() {
  const source = path.join(rootDir, "frontend", "components", "fusionSlashMenu.ts");
  const compiled = esbuild.transformSync(fs.readFileSync(source, "utf8"), {
    loader: "ts",
    format: "cjs"
  }).code;
  const mod = { exports: {} };
  new Function("module", "exports", "require", compiled)(mod, mod.exports, require);
  return mod.exports;
}

function quickPresetCodexModel() {
  try {
    const pane = fs.readFileSync(
      path.join(rootDir, "frontend", "components", "FusionChatPane.tsx"),
      "utf8"
    );
    const match = pane.match(/plannerFamily\s*===\s*"codex"\s*\?\s*"([^"]+)"/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function vendoredCodexVersion() {
  const dir = path.join(rootDir, "vendor", "codex-appserver");
  try {
    const versions = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d+\.\d+\.\d+$/.test(entry.name))
      .map((entry) => entry.name);
    return versions.length === 1 ? versions[0] : null;
  } catch {
    return null;
  }
}

function vendoredKimiVersion() {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(rootDir, "vendor", "kimi-custom", "package.json"), "utf8")
    );
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

// ---- upstream fetches ----
function fetchJson(url, { headers = {}, timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    const req = https.get(url, { headers: { "user-agent": "vibeTerminal model-drift", ...headers }, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        let json = null;
        try {
          json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          // non-JSON body
        }
        resolve({ status: res.statusCode || 0, json });
      });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve({ status: 0, json: null });
    });
    req.on("error", () => resolve({ status: 0, json: null }));
  });
}

async function npmLatestVersion(pkg) {
  const encoded = pkg.replace("/", "%2f");
  const { json } = await fetchJson(`https://registry.npmjs.org/${encoded}/latest`);
  return json && typeof json.version === "string" ? json.version : null;
}

async function getCodexCatalog() {
  const exe = process.platform === "win32" ? "codex.exe" : "codex";
  const vendored = path.join(
    rootDir,
    "vendor",
    "codex-bin",
    `${process.platform}-${process.arch}`,
    exe
  );
  const command = fs.existsSync(vendored) ? vendored : "codex";
  const live = await codexModels.fetchCodexModelCatalog({ command, timeoutMs: 20000 });
  if (live) {
    return { source: `live \`codex debug models\` (${command})`, models: live, retirements: [] };
  }

  const { json } = await fetchJson(UPSTREAM_CODEX_MODELS_URL);
  // A JSON body without a models array (renamed fields, error page) must read
  // as "unknown", not as "every curated model vanished".
  if (!json || !Array.isArray(json.models)) return null;
  const entries = json.models;
  const retirements = entries
    .filter((entry) => entry && (entry.retirement_at || entry.upgrade))
    .map((entry) => ({
      id: entry.slug,
      retirementAt: entry.retirement_at || entry.upgrade?.retirement_at || null,
      replacement:
        entry.upgrade && typeof entry.upgrade.model === "string" ? entry.upgrade.model : null
    }));
  const models = codexModels.sanitizeCodexModels(json);
  if (!models.length) return null;
  return {
    source:
      "bundled catalog from openai/codex main (no codex binary/auth here — ChatGPT-only server-side models not visible)",
    models,
    retirements
  };
}

async function getClaudeCatalog() {
  if (process.env.ANTHROPIC_API_KEY) {
    const viaKey = await claudeModels.fetchClaudeModelCatalog({
      connection: { baseUrl: "https://api.anthropic.com", apiKey: process.env.ANTHROPIC_API_KEY }
    });
    if (viaKey) return { source: "Anthropic /v1/models (ANTHROPIC_API_KEY)", models: viaKey };
  }
  const viaOauth = await claudeModels.fetchClaudeModelCatalog();
  if (viaOauth) return { source: "Anthropic /v1/models (local Claude OAuth)", models: viaOauth };
  return null;
}

// ---- diff helpers ----
// Upstream models we deliberately leave OUT of the curated list; absence is
// not drift. gpt-5.4 / gpt-5.4-mini retire 2026-08-31 and auto-migrate to
// gpt-5.6-terra/luna, so listing them would be churn. gpt-5.2 only appears in
// the bundled (no-auth) catalog — the live ChatGPT catalog doesn't serve it.
const IGNORED_UPSTREAM_CODEX_MODELS = new Set(["gpt-5.4", "gpt-5.4-mini", "gpt-5.2"]);

function versionParts(id, prefix) {
  // claude-opus-4-8 -> [4, 8]; claude-opus-5 -> [5]; date suffixes tolerated.
  const rest = id.slice(prefix.length);
  const parts = rest.split("-").map((piece) => parseInt(piece, 10));
  return parts.length && parts.every((n) => Number.isFinite(n)) ? parts : null;
}

function compareVersionParts(a, b) {
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const left = a[index] || 0;
    const right = b[index] || 0;
    if (left !== right) return left - right;
  }
  return 0;
}

function newestClaudeModel(models, prefix) {
  let best = null;
  for (const model of models) {
    if (!model.id.startsWith(prefix)) continue;
    const parts = versionParts(model.id, prefix);
    if (!parts) continue;
    if (!best || compareVersionParts(parts, best.parts) > 0) {
      best = { id: model.id, label: model.label, parts };
    }
  }
  return best;
}

function effortKey(efforts) {
  return [...efforts].filter((effort) => effort !== "auto").sort().join(",");
}

// ---- checks ----
function checkCodexModels(menu, catalog) {
  const section = addSection(`Codex models (${catalog.source})`);
  const curated = menu.FAMILY_MODEL_OPTIONS.codex.filter((model) => model.id !== "auto");
  const liveIds = new Set(catalog.models.map((model) => model.id.toLowerCase()));
  const curatedEfforts = menu.CURATED_CODEX_MODEL_EFFORTS;
  if (!curatedEfforts) {
    line(
      section,
      "info",
      "CURATED_CODEX_MODEL_EFFORTS is not exported from fusionSlashMenu.ts — per-model effort check inactive"
    );
  }

  for (const model of catalog.models) {
    if (IGNORED_UPSTREAM_CODEX_MODELS.has(model.id.toLowerCase())) continue;
    if (!menu.FAMILY_MODEL_OPTIONS.codex.some((entry) => entry.id.toLowerCase() === model.id.toLowerCase())) {
      line(
        section,
        "drift",
        `MISSING from curated list: ${model.id} ("${model.label}"${
          model.supportedEfforts ? `, efforts: ${model.supportedEfforts.join("/")}` : ""
        }${model.isDefault ? ", upstream default" : ""})`
      );
    }
  }

  for (const model of curated) {
    const live = catalog.models.find(
      (entry) => entry.id.toLowerCase() === model.id.toLowerCase()
    );
    if (!live) {
      line(section, "drift", `NO LONGER SERVED upstream: ${model.id} ("${model.label}") — remove candidate`);
      continue;
    }
    const ours = curatedEfforts ? curatedEfforts[model.id.toLowerCase()] : null;
    if (ours && Array.isArray(live.supportedEfforts) && live.supportedEfforts.length) {
      if (effortKey(ours) !== effortKey(live.supportedEfforts)) {
        line(
          section,
          "drift",
          `Effort drift on ${model.id}: curated ${effortKey(ours)} vs upstream ${effortKey(live.supportedEfforts)}`
        );
      }
    }
  }

  for (const retired of catalog.retirements) {
    const curatedHere = curated.some(
      (model) => model.id.toLowerCase() === String(retired.id || "").toLowerCase()
    );
    line(
      section,
      "info",
      `Retiring upstream: ${retired.id}${retired.retirementAt ? ` at ${retired.retirementAt}` : ""}${
        retired.replacement ? ` → ${retired.replacement}` : ""
      }${curatedHere ? " — still in our curated list" : ""}`
    );
  }

  const quick = quickPresetCodexModel();
  if (!quick) {
    line(section, "info", "Quick-preset Codex model not found in FusionChatPane.tsx — check disabled");
  } else if (!liveIds.has(quick.toLowerCase())) {
    line(
      section,
      "drift",
      `Quick preset (FusionChatPane.tsx) targets ${quick}, which is not in the upstream catalog`
    );
  }

  if (section.status === "ok") {
    line(section, "ok", `curated list matches upstream (${catalog.models.length} models)`);
  }
}

function checkClaudeModels(menu, catalog) {
  const section = addSection(`Claude models (${catalog.source})`);
  const families = [
    { prefix: "claude-opus-", label: menu.OPUS_LABEL, alias: "opus" },
    { prefix: "claude-sonnet-", label: menu.SONNET_LABEL, alias: "sonnet" },
    {
      prefix: "claude-fable-",
      label: (menu.FAMILY_MODEL_OPTIONS.claude.find((model) => model.id === "fable") || {}).label || "Fable",
      alias: "fable"
    }
  ];
  for (const family of families) {
    const newest = newestClaudeModel(catalog.models, family.prefix);
    if (!newest) {
      line(section, "info", `no ${family.prefix}* ids in the catalog — alias \`${family.alias}\` status unknown`);
      continue;
    }
    const upstreamLabel = newest.label.replace(/^Claude\s+/, "");
    if (upstreamLabel !== family.label) {
      line(
        section,
        "drift",
        `\`${family.alias}\` alias now tracks ${newest.id} ("${upstreamLabel}") but our label says "${family.label}"`
      );
    }
  }
  if (section.status === "ok") {
    line(section, "ok", "alias labels match the newest catalog entries");
  }
}

async function checkVersions() {
  const section = addSection("CLI version pins");
  const checks = [
    { name: "codex (vendored)", pkg: NPM_PACKAGES.codex, current: vendoredCodexVersion(), pinned: true },
    { name: "kimi-code (vendored fork)", pkg: NPM_PACKAGES.kimi, current: vendoredKimiVersion(), pinned: true },
    { name: "claude-code (unpinned)", pkg: NPM_PACKAGES.claude, current: null, pinned: false },
    { name: "opencode (unpinned)", pkg: NPM_PACKAGES.opencode, current: null, pinned: false }
  ];
  for (const check of checks) {
    const latest = await npmLatestVersion(check.pkg);
    if (!latest) {
      line(section, "info", `${check.name}: could not reach npm for ${check.pkg}`);
      continue;
    }
    if (check.pinned) {
      if (!check.current) {
        line(section, "info", `${check.name}: latest ${latest}; no local pin found to compare`);
      } else if (check.current !== latest) {
        line(section, "drift", `${check.name}: vendored ${check.current} → latest ${latest}`);
      } else {
        line(section, "ok", `${check.name}: ${check.current} is current`);
      }
    } else {
      line(section, "info", `${check.name}: latest ${latest} (we do not pin it)`);
    }
  }
}

// ---- report ----
const MARKS = { drift: "[DRIFT]", ok: "[ok]", info: "[info]", skip: "[skip]" };

function renderMarkdown() {
  const driftCount = sections.filter((section) => section.status === "drift").length;
  const lines = [
    `# Model drift report — ${new Date().toISOString().slice(0, 10)}`,
    "",
    driftCount
      ? `**${driftCount} section(s) drifted.**`
      : "**No drift — curated lists and pins match upstream.**",
    ""
  ];
  for (const section of sections) {
    lines.push(`## ${section.title} — ${section.status.toUpperCase()}`);
    for (const entry of section.lines) {
      lines.push(`- ${MARKS[entry.kind] || entry.kind} ${entry.text}`);
    }
    lines.push("");
  }
  lines.push(
    "---",
    "Generated by `scripts/dev/model-drift.cjs`. Codex catalog note: without an authed codex binary the check uses the bundled upstream catalog, which can miss ChatGPT-only server-side models."
  );
  return lines.join("\n");
}

async function main() {
  const menu = loadCuratedMenu();

  const [codexCatalog, claudeCatalog] = await Promise.all([getCodexCatalog(), getClaudeCatalog()]);

  if (codexCatalog) {
    checkCodexModels(menu, codexCatalog);
  } else {
    skipSection(addSection("Codex models"), "no codex binary and upstream bundled catalog unreachable");
  }

  if (claudeCatalog) {
    checkClaudeModels(menu, claudeCatalog);
  } else {
    skipSection(
      addSection("Claude models"),
      "no local Claude OAuth credential and ANTHROPIC_API_KEY not set"
    );
  }

  await checkVersions();

  const markdown = renderMarkdown();
  console.log(markdown);

  if (jsonOutPath) {
    fs.writeFileSync(
      jsonOutPath,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          drift: sections.some((section) => section.status === "drift"),
          sections
        },
        null,
        2
      )
    );
  }
  if (mdOutPath) {
    fs.writeFileSync(mdOutPath, markdown + "\n");
  }

  const drift = sections.some((section) => section.status === "drift");
  if (drift && !noFail) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`model-drift: ${error && error.stack ? error.stack : error}`);
  process.exitCode = 2;
});
