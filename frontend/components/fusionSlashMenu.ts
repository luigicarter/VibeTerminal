import type {
  FusionCodexEffort,
  FusionEffort,
  FusionFamily,
  FusionRoleEffort
} from "../types";

// Pure slash-menu + settings-normalization logic for the Fusion pane.
// Extracted from FusionChatPane.tsx so scripts/frontend/fusion-settings-smoke.cjs
// can exercise the REAL menu behavior (esbuild-transpiled) instead of grepping
// component source.
//
// 2026-07-03: per-role FAMILIES. The planner and executor each pick a family —
// Claude (claude CLI) or Codex (codex app-server) — and then a model inside it,
// through the same two-stage picker Open Fusion uses for providers→models
// (minus connect/API keys: both families ride existing subscriptions).

export const OPUS_LABEL = "Opus 4.8";
export const SONNET_LABEL = "Sonnet 4.5";

export type FusionRole = "planner" | "executor";

export const FUSION_FAMILY_VALUES: FusionFamily[] = ["claude", "codex"];
export const DEFAULT_PLANNER_FAMILY: FusionFamily = "claude";
export const DEFAULT_EXECUTOR_FAMILY: FusionFamily = "codex";

// Default model per (role, family). "auto" (codex only) = let the runtime use
// its configured default model.
export const DEFAULT_ROLE_MODELS: Record<FusionRole, Record<FusionFamily, string>> = {
  planner: { claude: "opus", codex: "auto" },
  executor: { claude: "sonnet", codex: "auto" }
};

export const DEFAULT_FUSION_MODEL = DEFAULT_ROLE_MODELS.planner.claude;
export const DEFAULT_FUSION_CODEX_MODEL = DEFAULT_ROLE_MODELS.executor.codex;
export const DEFAULT_FUSION_EFFORT: FusionEffort = "auto";
export const DEFAULT_FUSION_CODEX_EFFORT: FusionCodexEffort = "auto";
export const FUSION_MODEL_ID_PATTERN = /^[A-Za-z0-9._:/@+-]+$/;

// Claude-side effort: the exact `claude --effort` enum ("auto" = omit).
export const FUSION_EFFORT_LABELS: Record<FusionEffort, string> = {
  auto: "Auto",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
  max: "Max"
};
// Codex-side effort: codex's OWN enum (verified against the 0.142 binary:
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

export const familyEffortValues = (family: FusionFamily): string[] =>
  family === "codex" ? (CODEX_EFFORT_VALUES as string[]) : (FUSION_EFFORT_VALUES as string[]);

export const familyEffortLabel = (family: FusionFamily, effort: string): string =>
  family === "codex"
    ? CODEX_EFFORT_LABELS[effort as FusionCodexEffort] || effort
    : FUSION_EFFORT_LABELS[effort as FusionEffort] || effort;

// The family catalog — the Fusion analogue of Open Fusion's provider list.
// Two entries, both subscription-backed; no connect/key flows.
export const FUSION_FAMILY_OPTIONS: { id: FusionFamily; name: string; desc: string }[] = [
  {
    id: "claude",
    name: "Claude",
    desc: "Anthropic models via the claude CLI (Claude subscription)"
  },
  {
    id: "codex",
    name: "Codex",
    desc: "OpenAI models via the codex CLI (ChatGPT subscription)"
  }
];

// Curated model catalogs per family. Role-neutral descriptions: either role
// can run either family. Claude's CLI accepts the aliases below (or full
// claude-* ids); Codex ids were read out of the shipped 0.142 binary. Custom
// ids stay possible via free text, validated before anything restarts.
export const FAMILY_MODEL_OPTIONS: Record<
  FusionFamily,
  { id: string; label: string; desc: string }[]
> = {
  claude: [
    { id: "opus", label: OPUS_LABEL, desc: "Most capable Anthropic model" },
    { id: "sonnet", label: SONNET_LABEL, desc: "Fast, lighter Anthropic model" }
  ],
  codex: [
    { id: "auto", label: "Codex default", desc: "Use codex's configured default model" },
    { id: "gpt-5.5", label: "GPT-5.5", desc: "Latest general OpenAI model" },
    { id: "gpt-5.3-codex", label: "GPT-5.3 Codex", desc: "Coding-tuned" },
    { id: "gpt-5.1-codex-max", label: "GPT-5.1 Codex Max", desc: "Deep agentic coding (supports XHigh)" },
    { id: "gpt-5.1-codex-mini", label: "GPT-5.1 Codex Mini", desc: "Fast and inexpensive" }
  ]
};

// Kept for existing imports; same data as FAMILY_MODEL_OPTIONS with the
// legacy "Model X" label style dropped.
export const CLAUDE_MODEL_OPTIONS = FAMILY_MODEL_OPTIONS.claude;
export const CODEX_MODEL_OPTIONS = FAMILY_MODEL_OPTIONS.codex;

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
  // Selecting the bare command opens a STATE-driven picker in the pane
  // (Open Fusion's family→model drill-in) instead of a text-filter submenu.
  picker?: FusionRole;
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
// front-load the CURRENT family/model so Enter on a bare picker is a harmless
// no-op ("Already using …") instead of silently committing a reset (the old
// menus put the default at index 0, so muscle-memory Enter reverted the
// user's model — the "picks don't stick" bug).
export interface SlashMenuContext {
  plannerFamily?: FusionFamily | string;
  plannerModel?: string;
  plannerEffort?: string;
  executorFamily?: FusionFamily | string;
  executorModel?: string;
  executorEffort?: string;
}

// The "/" palette — the Fusion equivalent of the slash menu a real CLI draws
// inside xterm. Every entry routes back through handleSlashCommand.
export const FUSION_SLASH_COMMANDS: SlashCommand[] = [
  { name: "/plan", desc: "Switch Fusion to Plan mode" },
  { name: "/auto", desc: "Switch Fusion to Auto mode" },
  { name: "/mode", desc: "Toggle Auto/Plan mode" },
  { name: "/planner-model", desc: "Pick the planner family and model", picker: "planner" },
  { name: "/executor-model", desc: "Pick the executor family and model", picker: "executor" },
  { name: "/speed", desc: "Fusion speed presets", submenu: true },
  { name: "/effort", desc: "Fusion reasoning effort", submenu: true },
  { name: "/fast", desc: "Switch Fusion to the fast preset" },
  { name: "/models", desc: "Show the current models and effort" },
  { name: "/details", desc: "Toggle tool execution details" },
  { name: "/compact", desc: "Summarize the conversation to free context" },
  { name: "/resume", desc: "Resume the last Fusion chat" },
  { name: "/clear", desc: "Clear this conversation" },
  { name: "/help", desc: "List the available commands" }
];

// Commands whose argument is raw free text that should NOT be menu-filtered.
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

const asFamily = (value: unknown, fallback: FusionFamily): FusionFamily =>
  value === "claude" || value === "codex" ? value : fallback;

export function normalizeFusionFamily(value: unknown, fallback: FusionFamily): FusionFamily {
  const lower = typeof value === "string" ? value.trim().toLowerCase() : "";
  return asFamily(lower, fallback);
}

export const contextPlannerFamily = (context?: SlashMenuContext): FusionFamily =>
  normalizeFusionFamily(context?.plannerFamily, DEFAULT_PLANNER_FAMILY);

export const contextExecutorFamily = (context?: SlashMenuContext): FusionFamily =>
  normalizeFusionFamily(context?.executorFamily, DEFAULT_EXECUTOR_FAMILY);

const scopeFamily = (scope: FusionRoleScope, context?: SlashMenuContext): FusionFamily =>
  scope === "execution" ? contextExecutorFamily(context) : contextPlannerFamily(context);

// Effort values usable by a SCOPE: a role lists ITS family's enum; the
// harness scope lists the values BOTH current families accept, so a shared
// pick can never poison one side with an unknown variant.
export function scopeEffortValues(scope: FusionRoleScope, context?: SlashMenuContext): string[] {
  if (scope !== "harness") {
    return familyEffortValues(scopeFamily(scope, context));
  }
  const plannerValues = familyEffortValues(contextPlannerFamily(context));
  const executorValues = new Set(familyEffortValues(contextExecutorFamily(context)));
  return plannerValues.filter((effort) => executorValues.has(effort));
}

export const effortItems = (
  prefix: string,
  scope: FusionRoleScope = "harness",
  context?: SlashMenuContext
): SlashMenuItem[] =>
  scopeEffortValues(scope, context).map((effort) => ({
    key: `${prefix}-${scope}-effort-${effort}`,
    label: `${roleName(scope)} ${familyEffortLabel(scopeFamily(scope, context), effort)}`,
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
// exception is "fast", whose whole point is a faster planning model — its
// description says so explicitly.
const fastPlannerModelLabel = (context?: SlashMenuContext) =>
  contextPlannerFamily(context) === "codex" ? "GPT-5.1 Codex Mini" : SONNET_LABEL;

// The "max" preset maps to each family's own top level.
export const familyMaxEffort = (family: FusionFamily): FusionRoleEffort =>
  family === "codex" ? "xhigh" : "max";

export const speedItems = (scope: FusionRoleScope, context?: SlashMenuContext): SlashMenuItem[] =>
  FUSION_SPEED_VALUES.map((preset) => ({
    key: `speed-${scope}-${preset}`,
    label: `${roleName(scope)} ${FUSION_SPEED_LABELS[preset]}`,
    desc:
      scope === "harness"
        ? preset === "fast"
          ? `${fastPlannerModelLabel(context)} planning and low effort everywhere`
          : preset === "balanced"
            ? "Automatic effort across Fusion (keeps your models)"
            : preset === "deep"
              ? "High effort across Fusion (keeps your models)"
              : "Top planning and execution effort (keeps your models)"
        : scope === "planning"
          ? preset === "fast"
            ? `${fastPlannerModelLabel(context)} planning at low effort`
            : preset === "balanced"
              ? "Automatic planning effort (keeps your model)"
              : preset === "deep"
                ? "High planning effort (keeps your model)"
                : "Top planning effort (keeps your model)"
          : preset === "fast"
            ? "Low execution effort"
            : preset === "balanced"
              ? "Automatic execution effort"
              : preset === "deep"
                ? "High execution effort"
                : "Top execution effort for the executor's family",
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

const roleCurrent = (role: FusionRole, context?: SlashMenuContext) =>
  role === "planner"
    ? {
        family: contextPlannerFamily(context),
        model: normalizeFusionRoleModel(
          contextPlannerFamily(context),
          "planner",
          context?.plannerModel
        )
      }
    : {
        family: contextExecutorFamily(context),
        model: normalizeFusionRoleModel(
          contextExecutorFamily(context),
          "executor",
          context?.executorModel
        )
      };

// Catalog rows for one family with the role's CURRENT model marked and moved
// to the front. A current model outside the catalog (custom id) gets its own
// leading row so the user can always see what is active.
export function familyModelRows(
  role: FusionRole,
  family: FusionFamily,
  context: SlashMenuContext | undefined,
  commandFor: (family: FusionFamily, modelId: string) => string
): SlashMenuItem[] {
  const current = roleCurrent(role, context);
  const isCurrentFamily = current.family === family;
  const options = FAMILY_MODEL_OPTIONS[family];
  const rows = options.map((model) => ({
    key: `${role}-${family}-model-${model.id}`,
    label: model.label,
    desc:
      isCurrentFamily && current.model === model.id ? markCurrent(model.desc) : model.desc,
    command: commandFor(family, model.id)
  }));
  if (!isCurrentFamily) return rows;
  const currentIndex = options.findIndex((model) => model.id === current.model);
  if (currentIndex > 0) {
    const [row] = rows.splice(currentIndex, 1);
    rows.unshift(row);
  } else if (currentIndex < 0) {
    rows.unshift({
      key: `${role}-${family}-model-current`,
      label: current.model,
      desc: markCurrent(`Custom ${family} model`),
      command: commandFor(family, current.model)
    });
  }
  return rows;
}

// ---- Open Fusion-style state picker (family stage → model stage) ----
// The pane drives this with a PickerState {role, family?}; the composer input
// is only a filter while the picker is open. Selection commands are tagged
// (__family:… advances a stage, __model:… commits) exactly like Open Fusion's
// __provider:/__model: tags.
export type FusionPickerState = { role: FusionRole; family?: FusionFamily } | null;

export const pickerRoleLabel = (role: FusionRole) =>
  role === "planner" ? "Planner" : "Executor";

export function buildFusionPicker(
  picker: { role: FusionRole; family?: FusionFamily },
  query: string,
  context?: SlashMenuContext
): SlashMenu {
  const filter = query.trim().toLowerCase();
  const current = roleCurrent(picker.role, context);

  if (!picker.family) {
    const families = FUSION_FAMILY_OPTIONS.map((family) => {
      const models = FAMILY_MODEL_OPTIONS[family.id];
      const isCurrent = current.family === family.id;
      return {
        key: `picker-${picker.role}-family-${family.id}`,
        label: family.name,
        desc: isCurrent
          ? markCurrent(`${models.length} models · ${family.desc}`)
          : `${models.length} models · ${family.desc}`,
        command: `__family:${family.id}`
      };
    });
    // Current family leads so Enter drills into where the user already is.
    families.sort((a, b) => {
      const aCurrent = a.command === `__family:${current.family}` ? 0 : 1;
      const bCurrent = b.command === `__family:${current.family}` ? 0 : 1;
      return aCurrent - bCurrent;
    });
    const items = filterSlashItems(families, filter);
    return {
      title: `${pickerRoleLabel(picker.role)} family`,
      items
    };
  }

  const family = picker.family;
  const rows = familyModelRows(
    picker.role,
    family,
    context,
    (fam, modelId) => `__model:${fam}/${modelId}`
  );
  let items = filterSlashItems(rows, filter);
  // An unmatched-but-launchable id becomes an explicit "Use '<id>'" row —
  // never a dead menu.
  if (filter && items.length === 0 && isValidFamilyModelId(family, filter)) {
    items = [
      {
        key: `picker-${picker.role}-${family}-custom-query`,
        label: `Use '${filter}'`,
        desc: `Set this ${family} model id`,
        command: `__model:${family}/${filter}`
      }
    ];
  }
  return {
    title: `${pickerRoleLabel(picker.role)} model — ${
      FUSION_FAMILY_OPTIONS.find((f) => f.id === family)?.name || family
    }`,
    items
  };
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

  // Legacy typed shorthands survive the picker era with family-explicit
  // semantics: "/claude <model>" sets the PLANNER to the Claude family,
  // "/codex <model>" sets the EXECUTOR to the Codex family. Typing after
  // either FILTERS its family catalog; an unmatched-but-valid id surfaces as
  // an explicit "Use '<id>'" row (never a dead menu, never /plan).
  if (lower === "/claude" || lower.startsWith("/claude ")) {
    const rows = familyModelRows("planner", "claude", context, (_f, id) => `/claude ${id}`);
    const { title, items, query } = submenu("/claude", "Planner Model (Claude)", rows);
    if (query && items.length === 0 && isValidClaudeModelId(query)) {
      return {
        title,
        items: [
          {
            key: "claude-custom-query",
            label: `Use '${query}'`,
            desc: "Set this planner model id",
            command: `/claude ${query}`
          }
        ]
      };
    }
    return { title, items };
  }

  if (lower === "/codex" || lower.startsWith("/codex ")) {
    const rows = [
      ...familyModelRows("executor", "codex", context, (_f, id) => `/codex ${id}`),
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
      ...effortItems("/codex", "execution", context)
    ];
    const { title, items, query } = submenu("/codex", "Executor Model (Codex)", rows);
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
            desc: "Set this executor model id",
            command: `/codex ${query}`
          }
        ]
      };
    }
    return { title, items };
  }

  if (lower === "/speed planning" || lower.startsWith("/speed planning ")) {
    const { title, items } = submenu("/speed planning", "Fusion Speed / Planning", speedItems("planning", context));
    return { title, items };
  }

  if (lower === "/speed execution" || lower.startsWith("/speed execution ")) {
    const { title, items } = submenu("/speed execution", "Fusion Speed / Execution", speedItems("execution", context));
    return { title, items };
  }

  if (lower === "/speed fusion" || lower.startsWith("/speed fusion ")) {
    const { title, items } = submenu("/speed fusion", "Fusion Speed / Whole Harness", speedItems("harness", context));
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
      ...speedItems("harness", context)
    ]);
    return { title, items };
  }

  if (lower === "/effort planning" || lower.startsWith("/effort planning ")) {
    const { title, items } = submenu("/effort planning", "Fusion Effort / Planning", effortItems("/effort", "planning", context));
    return { title, items };
  }

  if (lower === "/effort execution" || lower.startsWith("/effort execution ")) {
    const { title, items } = submenu("/effort execution", "Fusion Effort / Execution", effortItems("/effort", "execution", context));
    return { title, items };
  }

  if (lower === "/effort fusion" || lower.startsWith("/effort fusion ")) {
    const { title, items } = submenu("/effort fusion", "Fusion Effort / Whole Harness", effortItems("/effort", "harness", context));
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
      ...effortItems("/effort", "harness", context)
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
      // Picker commands run as commands: handleSlashCommand opens the
      // state-driven family→model picker instead of filling text.
      command: cmd.picker ? cmd.name : cmd.takesArg || cmd.submenu ? undefined : cmd.name,
      fill: cmd.picker ? undefined : cmd.takesArg || cmd.submenu ? `${cmd.name} ` : undefined
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

export function isValidClaudeModelId(value: string) {
  return CLAUDE_MODEL_ALIAS_PATTERN.test(value.trim());
}

export function isValidFamilyModelId(family: FusionFamily, value: string) {
  const trimmed = value.trim();
  if (family === "claude") {
    return isValidClaudeModelId(trimmed);
  }
  return (
    trimmed.length > 0 && trimmed.length <= 96 && FUSION_MODEL_ID_PATTERN.test(trimmed)
  );
}

// Per-family model normalization. Claude coerces the "fast" shorthand and
// refuses ids the CLI cannot launch; codex treats auto/default as "auto".
export function normalizeFusionRoleModel(
  family: FusionFamily,
  role: FusionRole,
  value: unknown
): string {
  const fallback = DEFAULT_ROLE_MODELS[role][family];
  const model = normalizeModelId(value, fallback);
  const lower = model.toLowerCase();
  if (family === "codex") {
    return lower === "auto" || lower === "default" ? "auto" : model;
  }
  if (lower === "fast") return "sonnet";
  if (lower === "opus" || lower === "sonnet") return lower;
  return isValidClaudeModelId(model) ? model : fallback;
}

// Per-family effort normalization with CROSS-family coercion, so a saved
// effort survives a family flip at the nearest real level instead of failing
// every turn as an unknown variant.
export function normalizeFusionRoleEffort(
  family: FusionFamily,
  value: unknown
): FusionRoleEffort {
  const lower = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (family === "codex") {
    // Legacy saved panes (and old fusion-settings.json files) carry "max",
    // which codex rejects as an unknown variant: coerce to its nearest real
    // level instead of letting it fail every delegation.
    if (lower === "max") {
      return "xhigh";
    }
    return CODEX_EFFORT_VALUES.includes(lower as FusionCodexEffort)
      ? (lower as FusionCodexEffort)
      : DEFAULT_FUSION_CODEX_EFFORT;
  }
  if (lower === "minimal") return "low";
  if (lower === "ultra") return "max";
  return FUSION_EFFORT_VALUES.includes(lower as FusionEffort)
    ? (lower as FusionEffort)
    : DEFAULT_FUSION_EFFORT;
}

// ---- legacy single-family normalizers (kept as thin wrappers; App/main and
// the smokes still import them, and they define the migration semantics) ----

export function normalizeFusionModel(value: unknown) {
  return normalizeFusionRoleModel("claude", "planner", value);
}

export function normalizeFusionCodexModel(value: unknown) {
  return normalizeFusionRoleModel("codex", "executor", value);
}

export function normalizeFusionEffort(value: unknown): FusionEffort {
  return normalizeFusionRoleEffort("claude", value) as FusionEffort;
}

export function normalizeFusionCodexEffort(value: unknown): FusionCodexEffort {
  return normalizeFusionRoleEffort("codex", value) as FusionCodexEffort;
}

// One-stop migration/normalization for a raw settings-ish object (saved
// session fields, localStorage seed, IPC payload). Legacy shapes map as:
// model/claudeEffort → planner (claude family), codexModel/codexEffort →
// executor (codex family).
export interface NormalizedFusionRoleSettings {
  plannerFamily: FusionFamily;
  plannerModel: string;
  plannerEffort: FusionRoleEffort;
  executorFamily: FusionFamily;
  executorModel: string;
  executorEffort: FusionRoleEffort;
}

export function normalizeFusionRoleSettings(raw: {
  plannerFamily?: unknown;
  plannerModel?: unknown;
  plannerEffort?: unknown;
  executorFamily?: unknown;
  executorModel?: unknown;
  executorEffort?: unknown;
  model?: unknown;
  claudeEffort?: unknown;
  codexModel?: unknown;
  codexEffort?: unknown;
  effort?: unknown;
} | null | undefined): NormalizedFusionRoleSettings {
  const source = raw || {};
  const plannerFamily = normalizeFusionFamily(source.plannerFamily, DEFAULT_PLANNER_FAMILY);
  const executorFamily = normalizeFusionFamily(source.executorFamily, DEFAULT_EXECUTOR_FAMILY);
  const plannerModel = normalizeFusionRoleModel(
    plannerFamily,
    "planner",
    source.plannerModel ?? (plannerFamily === "claude" ? source.model : undefined)
  );
  const executorModel = normalizeFusionRoleModel(
    executorFamily,
    "executor",
    source.executorModel ?? (executorFamily === "codex" ? source.codexModel : undefined)
  );
  const plannerEffort = normalizeFusionRoleEffort(
    plannerFamily,
    source.plannerEffort ?? source.claudeEffort ?? source.effort
  );
  const executorEffort = normalizeFusionRoleEffort(
    executorFamily,
    source.executorEffort ?? source.codexEffort
  );
  return {
    plannerFamily,
    plannerModel,
    plannerEffort,
    executorFamily,
    executorModel,
    executorEffort
  };
}

// Display label for a (family, model) pair — used by the composer meta row,
// notices, and /models output.
export function fusionRoleModelLabel(family: FusionFamily, model: string): string {
  const match = FAMILY_MODEL_OPTIONS[family].find((option) => option.id === model);
  if (match) return match.label;
  return model;
}

export const familyDisplayName = (family: FusionFamily) =>
  FUSION_FAMILY_OPTIONS.find((option) => option.id === family)?.name ||
  (family === "codex" ? "Codex" : "Claude");

// Resolve a typed model argument to a family: explicit "family/model" slugs
// win; bare ids are inferred by shape. Returns null when the id could not be
// attributed (the caller shows an error instead of guessing).
export function resolveModelArgument(
  raw: string
): { family: FusionFamily; model: string } | null {
  const trimmed = raw.trim();
  const slug = /^(claude|codex)\/(.+)$/i.exec(trimmed);
  if (slug) {
    const family = slug[1].toLowerCase() as FusionFamily;
    const model = slug[2].trim();
    return isValidFamilyModelId(family, model) ? { family, model } : null;
  }
  if (isValidClaudeModelId(trimmed)) {
    return { family: "claude", model: trimmed };
  }
  if (/^(auto|default|gpt-|o[0-9]|codex)/i.test(trimmed) && isValidFamilyModelId("codex", trimmed)) {
    return { family: "codex", model: trimmed };
  }
  return null;
}
