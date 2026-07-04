import type {
  FusionClaudeModel,
  FusionCodexEffort,
  FusionCodexModel,
  FusionEffort
} from "../types";

// Pure slash-menu + settings-normalization logic for the Fusion pane.
// Extracted from FusionChatPane.tsx so scripts/frontend/fusion-settings-smoke.cjs
// can exercise the REAL menu behavior (esbuild-transpiled) instead of grepping
// component source.

export const OPUS_LABEL = "Opus 4.8";
export const SONNET_LABEL = "Sonnet 4.5";
export const DEFAULT_FUSION_MODEL: FusionClaudeModel = "opus";
export const DEFAULT_FUSION_CODEX_MODEL: FusionCodexModel = "auto";
export const DEFAULT_FUSION_EFFORT: FusionEffort = "auto";
export const DEFAULT_FUSION_CODEX_EFFORT: FusionCodexEffort = "auto";
export const FUSION_MODEL_ID_PATTERN = /^[A-Za-z0-9._:/@+-]+$/;

// Planning-side effort: the exact `claude --effort` enum ("auto" = omit).
export const FUSION_EFFORT_LABELS: Record<FusionEffort, string> = {
  auto: "Auto",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
  max: "Max"
};
// Execution-side effort: codex's OWN enum (verified against the 0.142 binary:
// minimal|low|medium|high|xhigh|ultra). It has NO "max" — offering one poisoned
// every delegation with an unknown-variant error until the user changed it.
export const CODEX_EFFORT_LABELS: Record<FusionCodexEffort, string> = {
  auto: "Auto",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
  ultra: "Ultra"
};
export const FUSION_EFFORT_VALUES = Object.keys(FUSION_EFFORT_LABELS) as FusionEffort[];
export const CODEX_EFFORT_VALUES = Object.keys(CODEX_EFFORT_LABELS) as FusionCodexEffort[];

// Curated model catalogs — the Fusion analogue of Open Fusion's provider
// catalog. Claude's CLI accepts the aliases below (or full claude-* ids);
// Codex ids were read out of the shipped 0.142 binary. Custom ids stay
// possible via free text, but they are validated before anything restarts.
export const CLAUDE_MODEL_OPTIONS: { id: FusionClaudeModel; label: string; desc: string }[] = [
  { id: "opus", label: `Model ${OPUS_LABEL}`, desc: "Deep planning and review (default)" },
  { id: "sonnet", label: `Model ${SONNET_LABEL}`, desc: "Faster, lighter planning" }
];
export const CODEX_MODEL_OPTIONS: { id: FusionCodexModel; label: string; desc: string }[] = [
  { id: "auto", label: "Model Codex default", desc: "Use the configured execution model (default)" },
  { id: "gpt-5.5", label: "Model GPT-5.5", desc: "Latest general Codex model" },
  { id: "gpt-5.3-codex", label: "Model GPT-5.3 Codex", desc: "Coding-tuned" },
  { id: "gpt-5.1-codex-max", label: "Model GPT-5.1 Codex Max", desc: "Deep agentic coding (supports XHigh)" },
  { id: "gpt-5.1-codex-mini", label: "Model GPT-5.1 Codex Mini", desc: "Fast and inexpensive" }
];
// Claude model ids we allow through to `claude --model`: the known aliases
// (per `claude --help`: opus, sonnet, fable — plus our "fast" shorthand) or a
// full claude-* id. Anything else previously restarted the pane into a claude
// process that exited immediately — a dead pane with no explanation.
export const CLAUDE_MODEL_ALIAS_PATTERN = /^(opus|sonnet|fast|fable|claude-[a-z0-9.:-]+)$/i;

export interface SlashCommand {
  name: string;
  arg?: string;
  desc: string;
  takesArg?: boolean;
  submenu?: boolean;
}

export interface SlashMenuItem {
  key: string;
  label: string;
  desc: string;
  command?: string;
  fill?: string;
}

export interface SlashMenu {
  title: string;
  items: SlashMenuItem[];
}

// What the menu needs to know about the pane's live settings: used to mark and
// front-load the CURRENT model so Enter on a bare "/claude"/"/codex" is a
// harmless no-op ("Already using …") instead of silently committing a reset
// (the old menus put the default at index 0, so muscle-memory Enter reverted
// the user's model — the "picks don't stick" bug).
export interface SlashMenuContext {
  model?: string;
  codexModel?: string;
}

// The "/" palette — the Fusion equivalent of the slash menu a real CLI draws
// inside xterm. Every entry routes back through handleSlashCommand.
export const FUSION_SLASH_COMMANDS: SlashCommand[] = [
  { name: "/plan", desc: "Switch Fusion to Plan mode" },
  { name: "/auto", desc: "Switch Fusion to Auto mode" },
  { name: "/mode", desc: "Toggle Auto/Plan mode" },
  { name: "/speed", desc: "Fusion speed presets", submenu: true },
  { name: "/effort", desc: "Fusion reasoning effort", submenu: true },
  { name: "/opus", desc: "Advanced planning role settings", submenu: true },
  { name: "/codex", desc: "Advanced execution role settings", submenu: true },
  { name: "/fast", desc: "Switch Fusion to the fast preset" },
  { name: "/claude", arg: "<model>", desc: "Set the planning model", takesArg: true, submenu: true },
  { name: "/models", desc: "Show the current models and effort" },
  { name: "/details", desc: "Toggle tool execution details" },
  { name: "/resume", desc: "Resume the last Claude Fusion chat" },
  { name: "/clear", desc: "Clear this conversation" },
  { name: "/help", desc: "List the available commands" }
];

// Commands whose argument is raw free text that should NOT be menu-filtered.
// "/claude" is deliberately NOT here anymore: typing after it now FILTERS the
// Planning Model submenu (like /codex and every Open Fusion picker) instead of
// closing the menu mid-keystroke; unmatched-but-valid ids surface as an
// explicit "Use '<id>'" row.
export const FREE_TEXT_SLASH_COMMANDS = ["/model claude", "/model codex"];

export type FusionRoleScope = "harness" | "planning" | "execution";
export type FusionSpeedPreset = "fast" | "balanced" | "deep" | "max";

export const FUSION_SPEED_LABELS: Record<FusionSpeedPreset, string> = {
  fast: "Fast",
  balanced: "Balanced",
  deep: "Deep",
  max: "Max"
};

export const FUSION_SPEED_VALUES = Object.keys(FUSION_SPEED_LABELS) as FusionSpeedPreset[];

export const roleName = (scope: FusionRoleScope) =>
  scope === "planning"
    ? "Planning"
    : scope === "execution"
      ? "Execution"
      : "Fusion";

export const scopeCommand = (scope: FusionRoleScope) =>
  scope === "harness" ? "fusion" : scope;

// Each role lists ITS engine's effort vocabulary: planning = the claude CLI
// enum, execution = codex's (which adds minimal/ultra and lacks max). The
// harness scope uses the shared subset both engines accept.
export const effortItems = (prefix: string, scope: FusionRoleScope = "harness"): SlashMenuItem[] =>
  (scope === "execution"
    ? (CODEX_EFFORT_VALUES as string[])
    : (FUSION_EFFORT_VALUES as string[])
  ).map((effort) => ({
    key: `${prefix}-${scope}-effort-${effort}`,
    label: `${roleName(scope)} ${
      scope === "execution"
        ? CODEX_EFFORT_LABELS[effort as FusionCodexEffort]
        : FUSION_EFFORT_LABELS[effort as FusionEffort]
    }`,
    desc:
      scope === "harness"
        ? effort === "auto"
          ? "Use runtime defaults across the harness"
          : `Set both Fusion roles to ${effort}`
        : effort === "auto"
          ? `Use the runtime default for ${roleName(scope).toLowerCase()}`
          : `Set ${roleName(scope).toLowerCase()} effort to ${effort}`,
    command:
      prefix === "/effort"
        ? `${prefix} ${scopeCommand(scope)} ${effort}`
        : `${prefix} effort ${effort}`
  }));

// Speed presets are EFFORT presets: they keep the user's model picks. The only
// exception is "fast", whose whole point is the faster planning model — its
// description says so explicitly. (They used to silently hard-reset the model
// to Opus, which read as "my model pick didn't stick".)
export const speedItems = (scope: FusionRoleScope): SlashMenuItem[] =>
  FUSION_SPEED_VALUES.map((preset) => ({
    key: `speed-${scope}-${preset}`,
    label: `${roleName(scope)} ${FUSION_SPEED_LABELS[preset]}`,
    desc:
      scope === "harness"
        ? preset === "fast"
          ? "Sonnet planning and low effort everywhere"
          : preset === "balanced"
            ? "Automatic effort across Fusion (keeps your models)"
            : preset === "deep"
              ? "High effort across Fusion (keeps your models)"
              : "Max planning / XHigh execution effort (keeps your models)"
        : scope === "planning"
          ? preset === "fast"
            ? "Sonnet planning at low effort"
            : preset === "balanced"
              ? "Automatic planning effort (keeps your model)"
              : preset === "deep"
                ? "High planning effort (keeps your model)"
                : "Max planning effort (keeps your model)"
          : preset === "fast"
            ? "Low execution effort"
            : preset === "balanced"
              ? "Automatic execution effort"
              : preset === "deep"
                ? "High execution effort"
                : "XHigh execution effort (codex's top level)",
    command: `/speed ${scopeCommand(scope)} ${preset}`
  }));

export const filterSlashItems = (items: SlashMenuItem[], query: string) => {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return items;
  return items.filter((item) =>
    `${item.label} ${item.desc}`.toLowerCase().includes(normalized)
  );
};

export function hasFreeTextSlashArgument(input: string) {
  const normalized = input.trim().replace(/\s+/g, " ").toLowerCase();
  return FREE_TEXT_SLASH_COMMANDS.some((command) =>
    normalized.startsWith(command + " ") &&
      normalized.slice(command.length).trim().length > 0
  );
}

const markCurrent = (desc: string) => `${desc} · current`;

// Catalog rows with the pane's CURRENT model marked and moved to the front.
// A current model outside the catalog (custom id) gets its own leading row so
// the user can always see what is active.
function claudeModelRows(context?: SlashMenuContext): SlashMenuItem[] {
  const current = String(context?.model || "").trim().toLowerCase();
  const rows = CLAUDE_MODEL_OPTIONS.map((model) => ({
    key: `claude-model-${model.id}`,
    label: model.label,
    desc: current === model.id ? markCurrent(model.desc) : model.desc,
    command: `/claude ${model.id}`
  }));
  if (!current) return rows;
  const currentIndex = CLAUDE_MODEL_OPTIONS.findIndex((model) => model.id === current);
  if (currentIndex > 0) {
    const [row] = rows.splice(currentIndex, 1);
    rows.unshift(row);
  } else if (currentIndex < 0) {
    rows.unshift({
      key: "claude-model-current",
      label: `Model ${current}`,
      desc: markCurrent("Custom planning model"),
      command: `/claude ${current}`
    });
  }
  return rows;
}

function codexModelRows(context?: SlashMenuContext): SlashMenuItem[] {
  const current = String(context?.codexModel || "auto").trim().toLowerCase() || "auto";
  const rows = CODEX_MODEL_OPTIONS.map((model) => ({
    key: `codex-model-${model.id}`,
    label: model.label,
    desc: current === model.id ? markCurrent(model.desc) : model.desc,
    command: `/codex ${model.id}`
  }));
  const currentIndex = CODEX_MODEL_OPTIONS.findIndex((model) => model.id === current);
  if (currentIndex > 0) {
    const [row] = rows.splice(currentIndex, 1);
    rows.unshift(row);
  } else if (currentIndex < 0) {
    rows.unshift({
      key: "codex-model-current",
      label: `Model ${current}`,
      desc: markCurrent("Custom execution model"),
      command: `/codex ${current}`
    });
  }
  return rows;
}

export function buildSlashMenu(input: string, context?: SlashMenuContext): SlashMenu {
  if (!input.startsWith("/")) {
    return { title: "", items: [] };
  }

  if (hasFreeTextSlashArgument(input)) {
    return { title: "", items: [] };
  }

  const trimmed = input.trim();
  const lower = trimmed.toLowerCase();
  const submenu = (command: string, title: string, items: SlashMenuItem[]) => {
    const query = lower.startsWith(`${command} `)
      ? trimmed.slice(command.length).trim()
      : "";
    return { title, items: filterSlashItems(items, query), query };
  };

  if (lower === "/opus" || lower.startsWith("/opus ")) {
    const { title, items } = submenu("/opus", "Planning Role", [
      ...claudeModelRows(context),
      {
        key: "opus-speed",
        label: "Speed",
        desc: "Planning speed presets",
        fill: "/speed planning "
      },
      {
        key: "opus-effort",
        label: "Effort",
        desc: "Planning effort levels",
        fill: "/effort planning "
      },
      ...effortItems("/opus", "planning")
    ]);
    return { title, items };
  }

  // "/claude " is the fill the command palette itself inserts for "set the
  // planning model" — it MUST land in a model submenu. Typing after it
  // FILTERS the catalog; a query that matches nothing but is a launchable id
  // becomes an explicit "Use '<id>'" row (never a dead menu, never /plan).
  if (lower === "/claude" || lower.startsWith("/claude ")) {
    const { title, items, query } = submenu("/claude", "Planning Model", claudeModelRows(context));
    if (query && items.length === 0 && isValidClaudeModelId(query)) {
      return {
        title,
        items: [
          {
            key: "claude-custom-query",
            label: `Use '${query}'`,
            desc: "Set this planning model id",
            command: `/claude ${query}`
          }
        ]
      };
    }
    return { title, items };
  }

  if (lower === "/codex" || lower.startsWith("/codex ")) {
    const { title, items, query } = submenu("/codex", "Execution Role", [
      ...codexModelRows(context),
      {
        key: "codex-custom",
        label: "Custom model",
        desc: "Type an execution model id",
        fill: "/codex "
      },
      {
        key: "codex-speed",
        label: "Speed",
        desc: "Execution speed presets",
        fill: "/speed execution "
      },
      {
        key: "codex-effort",
        label: "Effort",
        desc: "Execution effort levels",
        fill: "/effort execution "
      },
      ...effortItems("/codex", "execution")
    ]);
    if (
      query &&
      items.length === 0 &&
      FUSION_MODEL_ID_PATTERN.test(query) &&
      query.length <= 96
    ) {
      return {
        title,
        items: [
          {
            key: "codex-custom-query",
            label: `Use '${query}'`,
            desc: "Set this execution model id",
            command: `/codex ${query}`
          }
        ]
      };
    }
    return { title, items };
  }

  if (lower === "/speed planning" || lower.startsWith("/speed planning ")) {
    const { title, items } = submenu("/speed planning", "Fusion Speed / Planning", speedItems("planning"));
    return { title, items };
  }

  if (lower === "/speed execution" || lower.startsWith("/speed execution ")) {
    const { title, items } = submenu("/speed execution", "Fusion Speed / Execution", speedItems("execution"));
    return { title, items };
  }

  if (lower === "/speed fusion" || lower.startsWith("/speed fusion ")) {
    const { title, items } = submenu("/speed fusion", "Fusion Speed / Whole Harness", speedItems("harness"));
    return { title, items };
  }

  if (lower === "/speed" || lower.startsWith("/speed ")) {
    const { title, items } = submenu("/speed", "Fusion Speed", [
      {
        key: "speed-fusion",
        label: "Whole harness",
        desc: "Presets for planning and execution together",
        fill: "/speed fusion "
      },
      {
        key: "speed-planning",
        label: "Planning role",
        desc: "Planning and review speed",
        fill: "/speed planning "
      },
      {
        key: "speed-execution",
        label: "Execution role",
        desc: "Implementation and verification speed",
        fill: "/speed execution "
      },
      ...speedItems("harness")
    ]);
    return { title, items };
  }

  if (lower === "/effort planning" || lower.startsWith("/effort planning ")) {
    const { title, items } = submenu("/effort planning", "Fusion Effort / Planning", effortItems("/effort", "planning"));
    return { title, items };
  }

  if (lower === "/effort execution" || lower.startsWith("/effort execution ")) {
    const { title, items } = submenu("/effort execution", "Fusion Effort / Execution", effortItems("/effort", "execution"));
    return { title, items };
  }

  if (lower === "/effort fusion" || lower.startsWith("/effort fusion ")) {
    const { title, items } = submenu("/effort fusion", "Fusion Effort / Whole Harness", effortItems("/effort", "harness"));
    return { title, items };
  }

  if (lower === "/effort" || lower.startsWith("/effort ")) {
    const { title, items } = submenu("/effort", "Fusion Effort", [
      {
        key: "effort-fusion",
        label: "Whole harness",
        desc: "Set both Fusion roles together",
        fill: "/effort fusion "
      },
      {
        key: "effort-planning",
        label: "Planning role",
        desc: "Planning and review effort",
        fill: "/effort planning "
      },
      {
        key: "effort-execution",
        label: "Execution role",
        desc: "Implementation and verification effort",
        fill: "/effort execution "
      },
      ...effortItems("/effort", "harness")
    ]);
    return { title, items };
  }

  // A command with an argument in progress ("/something …") that no submenu
  // above claimed must NOT fall back to the full command list: Enter would
  // activate whatever sits at index 0 (historically /plan — a silent mode
  // switch). No matching context → no menu.
  if (/\s/.test(trimmed)) {
    return { title: "", items: [] };
  }

  const token = input.startsWith("/") && !/\s/.test(input) ? input.slice(1).toLowerCase() : "";
  const commands = FUSION_SLASH_COMMANDS.filter((cmd) => cmd.name.slice(1).startsWith(token));
  return {
    title: "Commands",
    items: commands.map((cmd) => ({
      key: cmd.name,
      label: `${cmd.name}${cmd.arg ? ` ${cmd.arg}` : ""}`,
      desc: cmd.desc,
      command: cmd.takesArg || cmd.submenu ? undefined : cmd.name,
      fill: cmd.takesArg || cmd.submenu ? `${cmd.name} ` : undefined
    }))
  };
}

export function normalizeModelId(value: unknown, fallback: string) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (
    !trimmed ||
    trimmed.length > 96 ||
    !FUSION_MODEL_ID_PATTERN.test(trimmed)
  ) {
    return fallback;
  }

  return trimmed;
}

export function normalizeFusionModel(value: unknown): FusionClaudeModel {
  const model = normalizeModelId(value, DEFAULT_FUSION_MODEL);
  const lower = model.toLowerCase();
  if (lower === "fast") return "sonnet";
  if (lower === "opus" || lower === "sonnet") return lower;
  return model;
}

export function normalizeFusionCodexModel(value: unknown): FusionCodexModel {
  const model = normalizeModelId(value, DEFAULT_FUSION_CODEX_MODEL);
  const lower = model.toLowerCase();
  return lower === "auto" || lower === "default" ? DEFAULT_FUSION_CODEX_MODEL : model;
}

export function normalizeFusionEffort(value: unknown): FusionEffort {
  return FUSION_EFFORT_VALUES.includes(value as FusionEffort)
    ? (value as FusionEffort)
    : DEFAULT_FUSION_EFFORT;
}

export function normalizeFusionCodexEffort(value: unknown): FusionCodexEffort {
  // Legacy saved panes (and old fusion-settings.json files) carry "max",
  // which codex rejects as an unknown variant: coerce to its nearest real
  // level instead of letting it fail every delegation.
  if (value === "max") {
    return "xhigh";
  }
  return CODEX_EFFORT_VALUES.includes(value as FusionCodexEffort)
    ? (value as FusionCodexEffort)
    : DEFAULT_FUSION_CODEX_EFFORT;
}

export function isValidClaudeModelId(value: string) {
  return CLAUDE_MODEL_ALIAS_PATTERN.test(value.trim());
}
