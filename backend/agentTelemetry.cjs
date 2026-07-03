const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const url = require("url");

const SHIM_BASE_DIR =
  process.env.VIBE_AGENT_SHIM_BASE_DIR ||
  path.join(process.cwd(), ".tmp", "vibe-agent-shims");
const OWNER_MARKER = ".vibe-agent-shims.json";
const MAX_EVENT_BYTES = 64 * 1024;
const MAX_SESSION_ID_BYTES = 512;
const PROVIDERS = ["codex", "claude", "opencode", "cursor-agent"];
const OPEN_FUSION_MODEL_ID_PATTERN = /^[A-Za-z0-9._:/@+-]+$/;
// Open Fusion deliberately ships with NO default models: assuming a vendor pair
// on pane open fails the moment the app-owned credential store is empty, and it
// second-guesses the user. "" means "not chosen yet" — the pane gates the first
// turn on connect-a-provider + pick instead.
const OPEN_FUSION_MODEL_UNSET = "";

function normalizeFusionRunMode(value) {
  return String(value || "").trim().toLowerCase() === "plan" ? "plan" : "auto";
}

function isValidOpenFusionModel(value) {
  const model = typeof value === "string" ? value.trim() : "";
  return Boolean(
    model &&
      model.length <= 96 &&
      OPEN_FUSION_MODEL_ID_PATTERN.test(model) &&
      model.toLowerCase() !== "auto" &&
      model.toLowerCase() !== "default"
  );
}

function normalizeOpenFusionModel(value, fallback) {
  const normalizedFallback = fallback || OPEN_FUSION_MODEL_UNSET;
  return isValidOpenFusionModel(value) ? value.trim() : normalizedFallback;
}

function openFusionPlannerPrompt() {
  return [
    "# Open Fusion Planner",
    "",
    "You are the primary Planner/intelligence layer inside vibeTerminal Open Fusion.",
    "You are the human-facing agent. Stay in the loop as the observer and steerer.",
    "",
    "Responsibilities:",
    "- Understand the user's goal and decide the next step.",
    "- Use the task tool with the investigator subagent for read-only scouting:",
    "  repo layout, relevant files, constraints, and facts you need before deciding.",
    "  The investigator is permission-locked read-only, so it can never change state.",
    "- Use the task tool with the executor subagent for concrete implementation work.",
    "- Do not perform code edits or shell commands yourself.",
    "- Review the executor's summary, diffs, command results, tests, and self-review.",
    "- Decide whether the task is done or whether the executor needs a better corrective instruction.",
    "- If more work is needed, write a specific follow-up task for the executor.",
    "- If the executor reports files changing underneath it (another agent or tool",
    "  editing the same folder), surface that overlap to the user and let them decide",
    "  how to proceed instead of silently re-delegating over the foreign changes.",
    "",
    "Completion rule:",
    "The executor may recommend that work is complete, but you own the final done/not-done decision.",
    "Only present completion to the user after you have reviewed the evidence and are satisfied."
  ].join("\n");
}

function openFusionExecutorPrompt() {
  return [
    "# Open Fusion Executor",
    "",
    "You are the executor subagent inside vibeTerminal Open Fusion.",
    "The Planner delegates concrete work to you and owns the final completion decision.",
    "",
    "Responsibilities:",
    "- Implement code changes.",
    "- Run shell commands, tests, builds, and inspections needed to validate the work.",
    "- Interpret command results and fix issues you find.",
    "- Self-review your changes before returning control.",
    "- Report changed files, commands run, validation results, remaining risks, and a recommendation.",
    "",
    "Concurrent edits: the user may run other agent panes or tools against this",
    "same folder. If an edit is rejected because the file changed after you read",
    "it, re-read before retrying - and if the new content is not your own work,",
    "another agent may be editing this checkout: include that overlap in your",
    "report instead of overwriting the foreign changes.",
    "",
    "Do not claim final completion directly to the user. Return evidence to the Planner so it can decide done vs another correction pass."
  ].join("\n");
}

function openFusionInvestigatorPrompt() {
  return [
    "# Open Fusion Investigator",
    "",
    "You are the read-only investigator subagent inside vibeTerminal Open Fusion.",
    "You do scouting passes so the Planner can make architecture, design, and delegation decisions.",
    "Your permissions are locked read-only: file edits, shell commands, and further delegation are denied.",
    "",
    "Responsibilities:",
    "- Gather the repo context the Planner asked for with read, glob, and grep.",
    "- Prefer fast file discovery, targeted reads, and concise summaries over broad narration.",
    "",
    "Return a concise report with:",
    "- Findings: concrete facts and constraints.",
    "- Files: relevant file paths and why they matter.",
    "- Snippets: short quoted code snippets only when they are essential.",
    "- Suggested next step: what the Planner should decide or delegate next."
  ].join("\n");
}

function openFusionResolvedModels(options = {}) {
  return {
    plannerModel: normalizeOpenFusionModel(
      options.plannerModel,
      OPEN_FUSION_MODEL_UNSET
    ),
    executorModel: normalizeOpenFusionModel(
      options.executorModel,
      OPEN_FUSION_MODEL_UNSET
    )
  };
}

function openFusionCommandContents(options = {}) {
  const { plannerModel, executorModel } = openFusionResolvedModels(options);

  return {
    delegate: {
      description: "Delegate work to the Open Fusion executor subagent",
      agent: "executor",
      model: executorModel || undefined,
      subtask: true,
      template: [
        "Execute this Open Fusion task as the executor subagent.",
        "",
        "$ARGUMENTS",
        "",
        "Return concise evidence for the Planner: changed files, commands run, validation results, risks, and whether you recommend another pass."
      ].join("\n")
    },
    investigate: {
      description: "Run a read-only Open Fusion investigation pass",
      agent: "investigator",
      model: executorModel || undefined,
      subtask: true,
      template: [
        "Investigate this read-only as the Open Fusion investigator subagent.",
        "",
        "$ARGUMENTS",
        "",
        "Return findings, relevant files, essential snippets, and the suggested next step for the Planner."
      ].join("\n")
    },
    review: {
      description: "Ask the Open Fusion Planner to review executor evidence",
      agent: "planner",
      model: plannerModel || undefined,
      template: [
        "Review the executor evidence below as the Open Fusion Planner.",
        "",
        "$ARGUMENTS",
        "",
        "Decide whether the work is complete. If it is not complete, write the next concrete instruction for the executor."
      ].join("\n")
    },
    fusion: {
      description: "Show the Open Fusion roles and native CLI controls",
      agent: "planner",
      model: plannerModel || undefined,
      template: [
        "Briefly explain the active Open Fusion operating model to the user.",
        "",
        "Mention:",
        "- Brain/Planner is the primary, human-facing, read-only agent.",
        "- Executor is the delegated implementation subagent.",
        "- Investigator is the permission-locked read-only scouting subagent.",
        "- Use /delegate <task> for executor work and /investigate <question> for read-only scouting.",
        "- Use /brain-model or /executor-model for pane-scoped model settings.",
        "- Use OpenCode's native /models for live Brain model selection in the TUI."
      ].join("\n")
    }
  };
}

function commandMarkdown(command) {
  const frontmatter = [
    "---",
    `description: ${JSON.stringify(command.description || "")}`,
    command.agent ? `agent: ${JSON.stringify(command.agent)}` : null,
    command.model ? `model: ${JSON.stringify(command.model)}` : null,
    command.subtask === true ? "subtask: true" : null,
    "---",
    ""
  ].filter((line) => line !== null);

  return `${frontmatter.join("\n")}${command.template}\n`;
}

function readOpenFusionModelState(modelStatePath) {
  try {
    const data = JSON.parse(fs.readFileSync(modelStatePath, "utf8"));
    // Invalid saved values fall back to the launch opts (undefined here), not
    // to the hard defaults, so a corrupt models.json cannot beat an explicit
    // launch-time model.
    return {
      plannerModel: isValidOpenFusionModel(data?.plannerModel)
        ? data.plannerModel.trim()
        : undefined,
      executorModel: isValidOpenFusionModel(data?.executorModel)
        ? data.executorModel.trim()
        : undefined
    };
  } catch {
    return {};
  }
}

function openFusionTuiPluginSource() {
  return [
    "// vibeterminal-openfusion-tui - auto-generated by vibeTerminal.",
    "// Pane-scoped OpenCode TUI commands. Safe no-op outside Open Fusion.",
    "const MODEL_PATTERN = /^[A-Za-z0-9._:/@+-]+$/;",
    "const MAX_MODEL_LENGTH = 96;",
    "",
    "function validModel(value) {",
    "  const model = String(value || '').trim();",
    "  if (!model || model.length > MAX_MODEL_LENGTH || !MODEL_PATTERN.test(model)) return false;",
    "  const lower = model.toLowerCase();",
    "  return lower !== 'auto' && lower !== 'default';",
    "}",
    "",
    "function defaultModels() {",
    "  return {",
    "    plannerModel: process.env.VIBE_TERMINAL_OPEN_FUSION_PLANNER_MODEL || '',",
    "    executorModel: process.env.VIBE_TERMINAL_OPEN_FUSION_EXECUTOR_MODEL || ''",
    "  };",
    "}",
    "",
    "async function readState() {",
    "  const file = process.env.VIBE_TERMINAL_OPEN_FUSION_MODEL_STATE;",
    "  const defaults = defaultModels();",
    "  if (!file) return defaults;",
    "  try {",
    "    const fs = await import('node:fs/promises');",
    "    const data = JSON.parse(await fs.readFile(file, 'utf8'));",
    "    return {",
    "      plannerModel: validModel(data?.plannerModel) ? String(data.plannerModel).trim() : defaults.plannerModel,",
    "      executorModel: validModel(data?.executorModel) ? String(data.executorModel).trim() : defaults.executorModel",
    "    };",
    "  } catch (_error) {",
    "    return defaults;",
    "  }",
    "}",
    "",
    "async function writeState(patch) {",
    "  const file = process.env.VIBE_TERMINAL_OPEN_FUSION_MODEL_STATE;",
    "  if (!file) return null;",
    "  const fs = await import('node:fs/promises');",
    "  const path = await import('node:path');",
    "  const current = await readState();",
    "  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };",
    "  await fs.mkdir(path.dirname(file), { recursive: true });",
    "  await fs.writeFile(file, `${JSON.stringify(next, null, 2)}\\n`);",
    "  return next;",
    "}",
    "",
    "function toast(api, title, message, variant = 'info') {",
    "  api.ui.toast({ title, message, variant, duration: 6000 });",
    "}",
    "",
    "function roleKey(role) {",
    "  return role === 'planner' ? 'plannerModel' : 'executorModel';",
    "}",
    "",
    "function roleLabel(role) {",
    "  return role === 'planner' ? 'Brain' : 'Executor';",
    "}",
    "",
    "async function loadCatalog(api) {",
    "  const result = await api.client.provider.list();",
    "  const data = result && typeof result === 'object' && 'data' in result ? result.data : result;",
    "  if (!data || !Array.isArray(data.all)) throw new Error('provider catalog unavailable');",
    "  return {",
    "    all: data.all,",
    "    connected: new Set(Array.isArray(data.connected) ? data.connected : [])",
    "  };",
    "}",
    "",
    "async function saveModel(api, role, model, provider) {",
    "  await writeState({ [roleKey(role)]: model });",
    "  api.ui.dialog.clear();",
    "  toast(api, 'Open Fusion', `${roleLabel(role)} model saved for the next pane restart: ${model}`, 'success');",
    "  if (provider && provider.needsAuth) {",
    "    toast(api, 'Open Fusion', `Provider '${provider.id}' is not connected. Run: opencode auth login ${provider.id}`, 'warning');",
    "  }",
    "}",
    "",
    "function promptCustomModel(api, role, current) {",
    "  api.ui.dialog.replace(() => api.ui.DialogPrompt({",
    "    title: `${roleLabel(role)} model`,",
    "    placeholder: 'provider/model',",
    "    value: current || '',",
    "    onConfirm: (value) => {",
    "      const model = String(value || '').trim();",
    "      if (!validModel(model)) {",
    "        toast(api, 'Open Fusion', 'Use an explicit provider/model id.', 'warning');",
    "        return;",
    "      }",
    "      saveModel(api, role, model).catch((error) => {",
    "        toast(api, 'Open Fusion', `Could not save model: ${error?.message || error}`, 'error');",
    "      });",
    "    },",
    "    onCancel: () => api.ui.dialog.clear()",
    "  }));",
    "}",
    "",
    "function pickModel(api, role, provider, connected, current) {",
    "  const models = Object.values(provider.models || {})",
    "    .filter((model) => model && model.id && model.status !== 'deprecated')",
    "    .sort((a, b) => String(b.release_date || '').localeCompare(String(a.release_date || '')));",
    "  const options = models.map((model) => ({",
    "    title: model.name || model.id,",
    "    value: `${provider.id}/${model.id}`,",
    "    description: model.id",
    "  }));",
    "  options.push({",
    "    title: 'Custom model id...',",
    "    value: '__custom__',",
    "    description: 'Type any provider/model id'",
    "  });",
    "  api.ui.dialog.replace(() => api.ui.DialogSelect({",
    "    title: `${roleLabel(role)} model - ${provider.name || provider.id}`,",
    "    placeholder: 'Search models',",
    "    options,",
    "    current: current || undefined,",
    "    onSelect: (option) => {",
    "      if (!option) return;",
    "      if (option.value === '__custom__') {",
    "        promptCustomModel(api, role, current);",
    "        return;",
    "      }",
    "      saveModel(api, role, option.value, {",
    "        id: provider.id,",
    "        needsAuth: !connected.has(provider.id)",
    "      }).catch((error) => {",
    "        toast(api, 'Open Fusion', `Could not save model: ${error?.message || error}`, 'error');",
    "      });",
    "    }",
    "  }));",
    "}",
    "",
    "function pickProvider(api, role) {",
    "  Promise.all([readState(), loadCatalog(api)]).then(([state, catalog]) => {",
    "    const current = state[roleKey(role)] || '';",
    "    const providers = catalog.all.slice().sort((a, b) => {",
    "      const rank = Number(!catalog.connected.has(a.id)) - Number(!catalog.connected.has(b.id));",
    "      return rank || String(a.name || a.id).localeCompare(String(b.name || b.id));",
    "    });",
    "    const options = providers.map((provider) => ({",
    "      title: provider.name || provider.id,",
    "      value: provider.id,",
    "      description: catalog.connected.has(provider.id)",
    "        ? 'connected'",
    "        : `needs auth: opencode auth login ${provider.id}`,",
    "      category: catalog.connected.has(provider.id) ? 'Connected' : 'Available'",
    "    }));",
    "    options.push({",
    "      title: 'Custom model id...',",
    "      value: '__custom__',",
    "      description: 'Type any provider/model id',",
    "      category: 'Other'",
    "    });",
    "    api.ui.dialog.replace(() => api.ui.DialogSelect({",
    "      title: `${roleLabel(role)} provider`,",
    "      placeholder: 'Search providers',",
    "      options,",
    "      current: current.split('/')[0] || undefined,",
    "      onSelect: (option) => {",
    "        if (!option) return;",
    "        if (option.value === '__custom__') {",
    "          promptCustomModel(api, role, current);",
    "          return;",
    "        }",
    "        const provider = providers.find((entry) => entry.id === option.value);",
    "        if (provider) pickModel(api, role, provider, catalog.connected, current);",
    "      }",
    "    }));",
    "  }).catch((error) => {",
    "    toast(api, 'Open Fusion', `Could not load the provider catalog (${error?.message || error}); enter a model id instead.`, 'warning');",
    "    readState().then((state) => promptCustomModel(api, role, state[roleKey(role)] || ''));",
    "  });",
    "}",
    "",
    "async function showStatus(api) {",
    "  const state = await readState();",
    "  let connected = null;",
    "  try {",
    "    connected = (await loadCatalog(api)).connected;",
    "  } catch (_error) {",
    "    connected = null;",
    "  }",
    "  const describe = (model) => {",
    "    if (!model) return 'unset';",
    "    const providerID = model.split('/')[0];",
    "    return connected && providerID && !connected.has(providerID) ? `${model} (needs auth)` : model;",
    "  };",
    "  toast(api, 'Open Fusion', `Brain: ${describe(state.plannerModel)} | Executor: ${describe(state.executorModel)}`);",
    "}",
    "",
    "export default {",
    "  id: 'vibeterminal-openfusion-tui',",
    "  tui: async (api) => {",
    "    if (process.env.VIBE_TERMINAL_OPEN_FUSION !== '1') return;",
    "    const commands = [",
    "        {",
    "          namespace: 'palette',",
    "          name: 'openfusion.brain_model',",
    "          title: 'Set Brain model',",
    "          desc: 'Pick the pane-scoped Open Fusion Brain provider/model for the next restart',",
    "          category: 'Open Fusion',",
    "          slashName: 'brain-model',",
    "          slashAliases: ['brain'],",
    "          run: () => pickProvider(api, 'planner')",
    "        },",
    "        {",
    "          namespace: 'palette',",
    "          name: 'openfusion.executor_model',",
    "          title: 'Set Executor model',",
    "          desc: 'Pick the pane-scoped Open Fusion Executor provider/model for the next restart',",
    "          category: 'Open Fusion',",
    "          slashName: 'executor-model',",
    "          slashAliases: ['executor', 'body', 'body-model'],",
    "          run: () => pickProvider(api, 'executor')",
    "        },",
    "        {",
    "          namespace: 'palette',",
    "          name: 'openfusion.brain_model_live',",
    "          title: 'Switch live Brain model',",
    "          desc: 'Open OpenCode model selector for the current Brain turn',",
    "          category: 'Open Fusion',",
    "          slashName: 'brain-model-live',",
    "          slashAliases: ['brain-live'],",
    "          run: () => api.keymap.dispatchCommand('model.list')",
    "        },",
    "        {",
    "          namespace: 'palette',",
    "          name: 'openfusion.status',",
    "          title: 'Show Open Fusion status',",
    "          desc: 'Show pane-scoped Brain and Executor model settings',",
    "          category: 'Open Fusion',",
    "          slashName: 'openfusion',",
    "          slashAliases: ['fusion-status'],",
    "          run: () => showStatus(api).catch(() => {})",
    "        }",
    "      ];",
    "    if (typeof api.keymap?.registerLayer === 'function') {",
    "      api.keymap.registerLayer({ commands, bindings: [] });",
    "      return;",
    "    }",
    "    if (typeof api.command?.register === 'function') {",
    "      // Legacy v1 command API expects { value, description, slash, onSelect }.",
    "      api.command.register(() => commands.map((command) => ({",
    "        title: command.title,",
    "        value: command.name,",
    "        description: command.desc,",
    "        category: command.category,",
    "        slash: { name: command.slashName, aliases: command.slashAliases },",
    "        onSelect: () => command.run()",
    "      })));",
    "      return;",
    "    }",
    "    toast(api, 'Open Fusion', 'This OpenCode TUI build does not expose plugin command registration.', 'warning');",
    "  }",
    "};",
    ""
  ].join("\n");
}

function openFusionTheme() {
  return {
    $schema: "https://opencode.ai/theme.json",
    defs: {
      bg: "#0d1110",
      panel: "#101817",
      panel2: "#17211f",
      text: "#f3f2ea",
      muted: "#9aa9a3",
      cyan: "#25d9ff",
      green: "#62e66f",
      amber: "#f5b944",
      red: "#ff6571"
    },
    theme: {
      primary: { dark: "cyan", light: "#007b9b" },
      secondary: { dark: "green", light: "#267338" },
      accent: { dark: "amber", light: "#946214" },
      error: { dark: "red", light: "#bf2738" },
      warning: { dark: "amber", light: "#946214" },
      success: { dark: "green", light: "#267338" },
      text: { dark: "text", light: "#111814" },
      muted: { dark: "muted", light: "#53615b" },
      background: { dark: "bg", light: "#f8faf6" },
      surface: { dark: "panel", light: "#ffffff" },
      panel: { dark: "panel2", light: "#eef5f1" }
    }
  };
}

function openFusionConfigContents(options = {}) {
  const { plannerModel, executorModel } = openFusionResolvedModels(options);
  const inlinePrompts = options.inlinePrompts === true;

  return {
    $schema: "https://opencode.ai/config.json",
    default_agent: "planner",
    // Unset models are OMITTED (JSON.stringify drops undefined) rather than
    // defaulted: with the app-owned credential store there is no vendor pair
    // to assume, and a missing model must surface as "pick one", not as
    // opencode silently choosing on the user's behalf.
    model: plannerModel || undefined,
    command: openFusionCommandContents({ plannerModel, executorModel }),
    agent: {
      planner: {
        description:
          "Primary Open Fusion planner. Observes, delegates to executor, reviews evidence, and gates completion.",
        mode: "primary",
        model: plannerModel || undefined,
        prompt: inlinePrompts
          ? openFusionPlannerPrompt()
          : "{file:./openfusion-planner.md}",
        permission: {
          edit: "deny",
          bash: "deny",
          task: {
            "*": "deny",
            executor: "allow",
            investigator: "allow"
          }
        }
      },
      executor: {
        description:
          "Open Fusion executor. Implements code, runs commands, fixes issues, self-reviews, and reports evidence to the planner.",
        mode: "subagent",
        model: executorModel || undefined,
        hidden: false,
        prompt: inlinePrompts
          ? openFusionExecutorPrompt()
          : "{file:./openfusion-executor.md}"
      },
      investigator: {
        description:
          "Open Fusion read-only investigator. Scouts repo context for the planner; cannot edit, run commands, or delegate.",
        mode: "subagent",
        model: executorModel || undefined,
        hidden: false,
        prompt: inlinePrompts
          ? openFusionInvestigatorPrompt()
          : "{file:./openfusion-investigator.md}",
        // Hard read-only: no edits, no shell, and no task laundering (it must
        // not be able to reach the executor to write on its behalf).
        permission: {
          edit: "deny",
          bash: "deny",
          task: {
            "*": "deny"
          }
        }
      }
    }
  };
}

function pathEnvKey(env = process.env, platform = process.platform) {
  if (platform !== "win32") {
    return "PATH";
  }

  const matchingKey = Object.keys(env).find((key) => key.toLowerCase() === "path");
  return matchingKey || "Path";
}

function isInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function safeRemoveDir(target, baseDir = SHIM_BASE_DIR) {
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(target);
  if (!isInside(resolvedBase, resolvedTarget)) {
    return false;
  }

  try {
    fs.rmSync(resolvedTarget, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100
    });
    return true;
  } catch {
    return false;
  }
}

function isProcessAlive(pid) {
  const normalizedPid = Number(pid);
  if (!Number.isInteger(normalizedPid) || normalizedPid <= 0) {
    return false;
  }

  try {
    process.kill(normalizedPid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function readMarker(dir) {
  try {
    const marker = JSON.parse(
      fs.readFileSync(path.join(dir, OWNER_MARKER), "utf8")
    );
    return marker?.owner === "vibeTerminal-agent-shims" ? marker : null;
  } catch {
    return null;
  }
}

function writeMarker(dir, marker) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, OWNER_MARKER),
    `${JSON.stringify(
      {
        owner: "vibeTerminal-agent-shims",
        pid: process.pid,
        createdAt: new Date().toISOString(),
        ...marker
      },
      null,
      2
    )}\n`
  );
}

function cleanupStaleShimDirs(options = {}) {
  const baseDir = options.baseDir || SHIM_BASE_DIR;
  const currentRunId = options.currentRunId;

  if (!fs.existsSync(baseDir)) {
    return [];
  }

  const removed = [];
  for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    const entryPath = path.join(baseDir, entry.name);
    const marker = readMarker(entryPath);
    if (!marker || marker.runId === currentRunId) {
      continue;
    }

    if (!options.removeLive && isProcessAlive(marker.pid)) {
      continue;
    }

    if (safeRemoveDir(entryPath, baseDir)) {
      removed.push(entryPath);
    }
  }

  return removed;
}

// Open Fusion per-pane dirs must OUTLIVE the run (models.json carries the TUI
// picker choices to the next pane restart), so unlike shim dirs they cannot be
// GC'd by runId/pid. Instead, sweep dirs whose files have not been touched for
// a month: every pane launch rewrites its config, so any pane still in the
// workspace refreshes itself long before the cutoff.
const OPEN_FUSION_STALE_DIR_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function cleanupStaleOpenFusionDirs(openFusionBaseDir, maxAgeMs = OPEN_FUSION_STALE_DIR_MAX_AGE_MS) {
  const sessionsDir = path.join(openFusionBaseDir, "sessions");
  let entries;
  try {
    entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const removed = [];
  const cutoff = Date.now() - maxAgeMs;
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const dir = path.join(sessionsDir, entry.name);
    let newest = 0;
    for (const probe of ["models.json", "tui.json"]) {
      try {
        newest = Math.max(newest, fs.statSync(path.join(dir, probe)).mtimeMs);
      } catch {
        // probe file missing; fall back to the dir mtime below
      }
    }
    if (!newest) {
      try {
        newest = fs.statSync(dir).mtimeMs;
      } catch {
        continue;
      }
    }
    if (newest >= cutoff) {
      continue;
    }
    if (safeRemoveDir(dir, sessionsDir)) {
      removed.push(dir);
    }
  }

  return removed;
}

// ---- app-owned OpenCode home (Open Fusion data ownership) ----
// Open Fusion owns ALL of its data: conversation threads (opencode.db),
// credentials (auth.json), and config live under vibeTerminal's userData —
// never in the user's personal OpenCode install. opencode 1.17 resolves its
// data tree from XDG_DATA_HOME and its global-config dir from XDG_CONFIG_HOME
// (verified in the shipped binary; there is no OPENCODE_DATA escape hatch), so
// pointing both at this home isolates threads, auth, snapshots, and logs in
// one move — and stops ~/.config/opencode/* from loading into pane servers.
// The home is app-level (shared by every pane), NOT per-pane: /connect in one
// pane must serve them all, and it must survive the stale-pane-dir sweep.
function openFusionOpencodeHomePaths(openFusionBaseDir) {
  const homeDir = path.join(openFusionBaseDir, "opencode-home");
  return {
    homeDir,
    dataDir: path.join(homeDir, "data"),
    configDir: path.join(homeDir, "config")
  };
}

function globalOpencodeDataDir(env = process.env) {
  const xdgData = env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(xdgData, "opencode");
}

// One-time migration: threads created before isolation live in the user's
// global store (opencode 1.17 keeps sessions/messages in opencode.db at the
// data-dir root). Seed the app store with a best-effort copy of the db files
// so existing panes stay resumable. Credentials are deliberately NOT copied —
// the user's personal auth.json is not ours to replicate; providers are
// reconnected inside the app. Personal CLI threads ride along inside the db
// snapshot but never surface: discovery filters by launch-time cutoff and
// resume only confirms ids the app itself saved.
function migrateOpenFusionThreadsFromGlobal(dataDir, env = process.env) {
  const markerPath = path.join(dataDir, "opencode", ".vibe-migrated-from-global.json");
  if (fs.existsSync(markerPath)) {
    return { migrated: false, copied: [] };
  }
  const globalDir = globalOpencodeDataDir(env);
  const targetDir = path.join(dataDir, "opencode");
  fs.mkdirSync(targetDir, { recursive: true });
  const copied = [];
  // Copy -wal/-shm alongside the db: SQLite recovers a WAL snapshot via frame
  // checksums, so a mid-write copy degrades to "some tail turns missing", not
  // a corrupt store.
  for (const name of ["opencode.db", "opencode.db-wal", "opencode.db-shm"]) {
    const source = path.join(globalDir, name);
    try {
      if (fs.existsSync(source) && !fs.existsSync(path.join(targetDir, name))) {
        fs.copyFileSync(source, path.join(targetDir, name));
        copied.push(name);
      }
    } catch {
      // Best-effort: an unreadable global store means a fresh app store.
    }
  }
  try {
    fs.writeFileSync(
      markerPath,
      `${JSON.stringify({ migratedAt: new Date().toISOString(), copied, from: globalDir }, null, 2)}\n`
    );
  } catch {
    // Marker write failed — the existsSync guards above keep this idempotent.
  }
  return { migrated: copied.length > 0, copied };
}

function ensureOpenFusionOpencodeHome(openFusionBaseDir, env = process.env) {
  const paths = openFusionOpencodeHomePaths(openFusionBaseDir);
  // Pre-create $XDG_CONFIG_HOME/opencode empty: the app's role config arrives
  // per-pane via OPENCODE_CONFIG/OPENCODE_CONFIG_CONTENT, and an empty global
  // config dir is what keeps the user's ~/.config/opencode out of the loop.
  fs.mkdirSync(path.join(paths.configDir, "opencode"), { recursive: true });
  fs.mkdirSync(path.join(paths.dataDir, "opencode"), { recursive: true });
  migrateOpenFusionThreadsFromGlobal(paths.dataDir, env);
  return paths;
}

function quoteCmd(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function quotePowerShell(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function windowsPowerShellCommand() {
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  const candidate = path.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
  return fs.existsSync(candidate) ? candidate : "powershell.exe";
}

function windowsPowerShellShimSource(provider) {
  return [
    "$ErrorActionPreference = 'Continue'",
    `$Provider = ${quotePowerShell(provider)}`,
    "$ProviderArgs = @($args)",
    "",
    "function Send-VibeEvent {",
    "  param([string]$Type, [hashtable]$Extra)",
    "  if ([string]::IsNullOrEmpty($env:VIBE_TERMINAL_CALLBACK_URL) -or [string]::IsNullOrEmpty($env:VIBE_TERMINAL_TELEMETRY_TOKEN) -or [string]::IsNullOrEmpty($env:VIBE_TERMINAL_SESSION_ID)) {",
    "    return",
    "  }",
    "",
    "  try {",
    "    $payload = [ordered]@{",
    "      type = $Type",
    "      provider = $Provider",
    "      sessionId = $env:VIBE_TERMINAL_SESSION_ID",
    "      argv = @($ProviderArgs)",
    "      cwd = (Get-Location).ProviderPath",
    "      pid = $PID",
    "      timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()",
    "    }",
    "",
    "    if ($Extra) {",
    "      foreach ($key in $Extra.Keys) {",
    "        $payload[$key] = $Extra[$key]",
    "      }",
    "    }",
    "",
    "    $body = $payload | ConvertTo-Json -Compress -Depth 8",
    "    $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)",
    "    $request = [System.Net.WebRequest]::Create($env:VIBE_TERMINAL_CALLBACK_URL)",
    "    $request.Method = 'POST'",
    "    $request.Timeout = 1000",
    "    $request.ContentType = 'application/json'",
    "    $request.ContentLength = $bytes.Length",
    "    $request.Headers.Set('x-vibe-telemetry-token', $env:VIBE_TERMINAL_TELEMETRY_TOKEN)",
    "    $stream = $request.GetRequestStream()",
    "    try {",
    "      $stream.Write($bytes, 0, $bytes.Length)",
    "    } finally {",
    "      $stream.Dispose()",
    "    }",
    "    $response = $request.GetResponse()",
    "    if ($response) {",
    "      $response.Dispose()",
    "    }",
    "  } catch {",
    "    return",
    "  }",
    "}",
    "",
    "function Get-CommandCandidates {",
    "  param([string]$Command)",
    "  if ([System.IO.Path]::GetFileName($Command) -ne $Command) {",
    "    return @($Command)",
    "  }",
    "",
    "  $preferred = @('.exe', '.ps1', '.cmd', '.bat', '.com')",
    "  $pathExt = @()",
    "  if (-not [string]::IsNullOrEmpty($env:PATHEXT)) {",
    "    $pathExt = $env:PATHEXT -split ';' | Where-Object { $_ }",
    "  }",
    "",
    "  $extensions = @()",
    "  foreach ($extension in @($preferred + $pathExt)) {",
    "    $normalized = $extension.Trim()",
    "    if (-not $normalized) {",
    "      continue",
    "    }",
    "    if (-not $normalized.StartsWith('.')) {",
    "      $normalized = '.' + $normalized",
    "    }",
    "    $lower = $normalized.ToLowerInvariant()",
    "    if ($extensions -notcontains $lower) {",
    "      $extensions += $lower",
    "    }",
    "  }",
    "",
    "  $names = @()",
    "  foreach ($extension in $extensions) {",
    '    $names += "$Command$extension"',
    "  }",
    "  return $names",
    "}",
    "",
    "function Resolve-RealCommand {",
    "  param([string]$Command)",
    "  $originalPath = $env:VIBE_TERMINAL_ORIGINAL_PATH",
    "  if ([string]::IsNullOrEmpty($originalPath)) {",
    "    return $null",
    "  }",
    "",
    "  $separator = [Regex]::Escape([string][System.IO.Path]::PathSeparator)",
    "  foreach ($dir in ($originalPath -split $separator)) {",
    "    if ([string]::IsNullOrWhiteSpace($dir)) {",
    "      continue",
    "    }",
    "",
    "    foreach ($candidate in (Get-CommandCandidates $Command)) {",
    "      $filePath = Join-Path $dir $candidate",
    "      if (Test-Path -LiteralPath $filePath -PathType Leaf) {",
    "        return (Resolve-Path -LiteralPath $filePath).ProviderPath",
    "      }",
    "    }",
    "  }",
    "",
    "  return $null",
    "}",
    "",
    "function Get-PowerShellCommand {",
    "  $candidate = Join-Path $PSHOME 'powershell.exe'",
    "  if (Test-Path -LiteralPath $candidate -PathType Leaf) {",
    "    return $candidate",
    "  }",
    "  return 'powershell.exe'",
    "}",
    "",
    "$Command = Resolve-RealCommand $Provider",
    "if (-not $Command) {",
    "  $message = 'vibeTerminal: could not find real ' + $Provider + ' executable on the original PATH.'",
    "  Send-VibeEvent 'agent.process.exited' @{ exitCode = 127; error = $message }",
    "  [Console]::Error.WriteLine($message)",
    "  exit 127",
    "}",
    "",
    "# Inject per-turn notification hooks for the threaded agents (see agentTelemetry.cjs).",
    "if ($Provider -eq 'claude' -and -not [string]::IsNullOrEmpty($env:VIBE_TERMINAL_CLAUDE_SETTINGS)) {",
    "  $ProviderArgs = @($ProviderArgs) + @('--settings', $env:VIBE_TERMINAL_CLAUDE_SETTINGS)",
    "}",
    "elseif ($Provider -eq 'codex' -and -not [string]::IsNullOrEmpty($env:VIBE_TERMINAL_NOTIFY_PROGRAM)) {",
    "  $notifyValue = \"notify=['powershell','-NoProfile','-ExecutionPolicy','Bypass','-File','$($env:VIBE_TERMINAL_NOTIFY_PROGRAM)','agent.completed']\"",
    "  $ProviderArgs = @($ProviderArgs) + @('-c', $notifyValue)",
    "}",
    "$env:Path = $env:VIBE_TERMINAL_ORIGINAL_PATH",
    "$ExitCode = 0",
    "$global:LASTEXITCODE = $null",
    "try {",
    "  $extension = [System.IO.Path]::GetExtension($Command).ToLowerInvariant()",
    "  if ($extension -eq '.ps1') {",
    "    & (Get-PowerShellCommand) -NoProfile -ExecutionPolicy Bypass -File $Command @ProviderArgs",
    "  } else {",
    "    & $Command @ProviderArgs",
    "  }",
    "",
    "  if ($null -ne $global:LASTEXITCODE) {",
    "    $ExitCode = [int]$global:LASTEXITCODE",
    "  } elseif (-not $?) {",
    "    $ExitCode = 1",
    "  }",
    "} catch {",
    "  $ExitCode = 1",
    "  [Console]::Error.WriteLine($_.Exception.Message)",
    "}",
    "",
    "Send-VibeEvent 'agent.process.exited' @{ exitCode = $ExitCode }",
    "exit $ExitCode"
  ].join(os.EOL);
}

function writeWrapper(shimDir, provider, runnerPath, nodePath) {
  if (process.platform === "win32") {
    const psWrapperPath = path.join(shimDir, `${provider}.ps1`);
    fs.writeFileSync(psWrapperPath, windowsPowerShellShimSource(provider));

    const wrapperPath = path.join(shimDir, `${provider}.cmd`);
    fs.writeFileSync(
      wrapperPath,
      [
        "@echo off",
        `${quoteCmd(windowsPowerShellCommand())} -NoProfile -ExecutionPolicy Bypass -File ${quoteCmd(psWrapperPath)} %*`,
        "exit /b %ERRORLEVEL%"
      ].join(os.EOL)
    );
    return wrapperPath;
  }

  const wrapperPath = path.join(shimDir, provider);
  fs.writeFileSync(
    wrapperPath,
    [
      "#!/usr/bin/env sh",
      `exec ${JSON.stringify(nodePath)} ${JSON.stringify(runnerPath)} ${JSON.stringify(provider)} "$@"`
    ].join("\n")
  );
  fs.chmodSync(wrapperPath, 0o755);
  return wrapperPath;
}

function normalizeSessionId(sessionId) {
  if (
    typeof sessionId !== "string" ||
    sessionId.length === 0 ||
    Buffer.byteLength(sessionId, "utf8") > MAX_SESSION_ID_BYTES
  ) {
    return null;
  }

  return sessionId;
}

function sessionDirName(sessionId) {
  const readable =
    sessionId
      .replace(/[^a-zA-Z0-9_-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 32) || "session";
  const hash = crypto
    .createHash("sha256")
    .update(sessionId)
    .digest("hex")
    .slice(0, 16);
  return `${readable}-${hash}`;
}

function shimRunnerSource() {
  return String.raw`const fs = require("fs");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");

const provider = process.argv[2];
let args = process.argv.slice(3);
const callbackUrl = process.env.VIBE_TERMINAL_CALLBACK_URL;
const token = process.env.VIBE_TERMINAL_TELEMETRY_TOKEN;
const sessionId = process.env.VIBE_TERMINAL_SESSION_ID;
const originalPath = process.env.VIBE_TERMINAL_ORIGINAL_PATH || "";

function pathKey(env = process.env) {
  if (process.platform !== "win32") return "PATH";
  return Object.keys(env).find((key) => key.toLowerCase() === "path") || "Path";
}

function post(event) {
  if (!callbackUrl || !token || !sessionId) return Promise.resolve();
  const body = JSON.stringify({
    ...event,
    provider,
    sessionId,
    argv: args,
    cwd: process.cwd(),
    pid: process.pid,
    timestamp: Date.now()
  });

  return new Promise((resolve) => {
    let url;
    try {
      url = new URL(callbackUrl);
    } catch {
      resolve();
      return;
    }

    const request = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: "POST",
      timeout: 1000,
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        "x-vibe-telemetry-token": token
      }
    }, (response) => {
      response.resume();
      response.on("end", resolve);
    });

    request.on("error", resolve);
    request.on("timeout", () => {
      request.destroy();
      resolve();
    });
    request.end(body);
  });
}

function candidates(command) {
  if (path.basename(command) !== command) return [command];
  if (process.platform !== "win32") return [command];
  const preferredExtensions = [".EXE", ".PS1", ".CMD", ".BAT", ".COM"];
  const pathext = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter(Boolean);
  const extensions = Array.from(new Set(preferredExtensions.concat(pathext)));
  return extensions.flatMap((extension) => [
    command + extension.toLowerCase(),
    command + extension.toUpperCase()
  ]);
}

function resolveRealCommand(command) {
  const pathParts = originalPath.split(path.delimiter).filter(Boolean);
  for (const dir of pathParts) {
    for (const candidate of candidates(command)) {
      const filePath = path.join(dir, candidate);
      try {
        if (fs.statSync(filePath).isFile()) {
          return filePath;
        }
      } catch {
        // Keep searching.
      }
    }
  }
  return null;
}

function quoteForCmd(value) {
  return "\"" + String(value).replace(/"/g, "\"\"") + "\"";
}

function powershellCommand() {
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  const candidate = path.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
  try {
    if (fs.statSync(candidate).isFile()) return candidate;
  } catch {
    // Fall back to PATH lookup below.
  }
  return "powershell.exe";
}

(async () => {
  const env = { ...process.env };
  env[pathKey(env)] = originalPath;

  const command = resolveRealCommand(provider);
  if (!command) {
    await post({
      type: "agent.process.exited",
      exitCode: 127,
      error: "Could not find real " + provider + " executable on the original PATH."
    });
    process.stderr.write("vibeTerminal: could not find real " + provider + " executable on the original PATH.\n");
    process.exit(127);
  }

  // Inject per-turn notification hooks for the threaded agents (see agentTelemetry.cjs).
  if (provider === "claude" && process.env.VIBE_TERMINAL_CLAUDE_SETTINGS) {
    args = args.concat(["--settings", process.env.VIBE_TERMINAL_CLAUDE_SETTINGS]);
  } else if (provider === "codex" && process.env.VIBE_TERMINAL_NOTIFY_PROGRAM) {
    args = args.concat([
      "-c",
      "notify=['" + process.env.VIBE_TERMINAL_NOTIFY_PROGRAM + "','agent.completed']"
    ]);
  }

  const isWindowsCommandScript =
    process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
  const isWindowsPowerShellScript =
    process.platform === "win32" && /\.ps1$/i.test(command);
  const child = isWindowsPowerShellScript
    ? spawn(powershellCommand(), [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        command,
        ...args
      ], {
        env,
        stdio: "inherit"
      })
    : isWindowsCommandScript
      ? spawn(process.env.ComSpec || "cmd.exe", [
        "/d",
        "/c",
        "\"" + [quoteForCmd(command)].concat(args.map(quoteForCmd)).join(" ") + "\""
      ], {
        env,
        stdio: "inherit",
        windowsVerbatimArguments: true
      })
    : spawn(command, args, {
        env,
        stdio: "inherit"
      });

  child.on("error", async (error) => {
    await post({
      type: "agent.process.exited",
      exitCode: 127,
      error: error.message
    });
    process.stderr.write(error.message + "\n");
    process.exit(127);
  });

  child.on("exit", async (code, signal) => {
    await post({
      type: "agent.process.exited",
      exitCode: code,
      signal
    });
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
})();`;
}

// The optional second notify argument. Whitelisted because the argument slot is
// not always ours: codex appends its own JSON payload after the type, so an
// unknown value must be dropped, never forwarded.
const NOTIFY_KNOWN_DETAILS = ["turn-start", "tool", "approval", "question"];

// Tiny Node script (POSIX) that POSTs a single attention event to the local
// telemetry callback. Invoked by the per-provider hooks as
// `node notify-hook.cjs <agent.completed|agent.waiting|agent.failed> [detail]`.
// It reads the pane id and callback details from the env the shim injected,
// ignores unknown extra args (codex appends a JSON payload) and stdin (claude
// pipes hook JSON), and exits quietly when run outside vibeTerminal.
function notifyHookSource() {
  return String.raw`const http = require("http");

const KNOWN_DETAILS = new Set(${JSON.stringify(NOTIFY_KNOWN_DETAILS)});
const type = process.argv[2];
const detailArg = process.argv[3] || "";
const detail = KNOWN_DETAILS.has(detailArg) ? detailArg : "";
const callbackUrl = process.env.VIBE_TERMINAL_CALLBACK_URL;
const token = process.env.VIBE_TERMINAL_TELEMETRY_TOKEN;
const sessionId = process.env.VIBE_TERMINAL_SESSION_ID;

if (!type || !callbackUrl || !token || !sessionId) {
  process.exit(0);
}

const body = JSON.stringify(
  detail
    ? { type, detail, sessionId, timestamp: Date.now() }
    : { type, sessionId, timestamp: Date.now() }
);

let url;
try {
  url = new URL(callbackUrl);
} catch {
  process.exit(0);
}

const request = http.request(
  {
    hostname: url.hostname,
    port: url.port,
    path: url.pathname,
    method: "POST",
    timeout: 1000,
    headers: {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
      "x-vibe-telemetry-token": token
    }
  },
  (response) => {
    response.resume();
    response.on("end", () => process.exit(0));
  }
);

request.on("error", () => process.exit(0));
request.on("timeout", () => {
  request.destroy();
  process.exit(0);
});
request.end(body);
`;
}

// Windows notify program body (PowerShell). Same contract as notifyHookSource
// but implemented without Node so it works regardless of whether the user has
// `node` on PATH. `$args[0]` is the attention type, `$args[1]` the optional
// whitelisted detail (codex appends its own JSON payload there, hence the guard).
function windowsNotifyPs1Source() {
  const knownDetails = NOTIFY_KNOWN_DETAILS.map((d) => `'${d}'`).join(", ");
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$Type = $args[0]",
    `$KnownDetails = @(${knownDetails})`,
    "$Detail = ''",
    "if ($args.Count -ge 2 -and $KnownDetails -contains [string]$args[1]) {",
    "  $Detail = [string]$args[1]",
    "}",
    "if ([string]::IsNullOrEmpty($Type) -or [string]::IsNullOrEmpty($env:VIBE_TERMINAL_CALLBACK_URL) -or [string]::IsNullOrEmpty($env:VIBE_TERMINAL_TELEMETRY_TOKEN) -or [string]::IsNullOrEmpty($env:VIBE_TERMINAL_SESSION_ID)) {",
    "  exit 0",
    "}",
    "try {",
    "  $payload = [ordered]@{",
    "    type = $Type",
    "    sessionId = $env:VIBE_TERMINAL_SESSION_ID",
    "    timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()",
    "  }",
    "  if ($Detail) {",
    "    $payload['detail'] = $Detail",
    "  }",
    "  $body = $payload | ConvertTo-Json -Compress",
    "  $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)",
    "  $request = [System.Net.WebRequest]::Create($env:VIBE_TERMINAL_CALLBACK_URL)",
    "  $request.Method = 'POST'",
    "  $request.Timeout = 1000",
    "  $request.ContentType = 'application/json'",
    "  $request.ContentLength = $bytes.Length",
    "  $request.Headers.Set('x-vibe-telemetry-token', $env:VIBE_TERMINAL_TELEMETRY_TOKEN)",
    "  $stream = $request.GetRequestStream()",
    "  try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }",
    "  $response = $request.GetResponse()",
    "  if ($response) { $response.Dispose() }",
    "} catch {",
    "  exit 0",
    "}",
    "exit 0"
  ].join(os.EOL);
}

// POSIX notify program: a shell wrapper that runs the Node hook. Forces
// ELECTRON_RUN_AS_NODE so the bundled Electron binary behaves as Node when it
// is used as the runtime (a no-op for a real `node`).
function posixNotifyShSource(nodePath, notifyHookPath) {
  return [
    "#!/usr/bin/env sh",
    `ELECTRON_RUN_AS_NODE=1 exec ${JSON.stringify(nodePath)} ${JSON.stringify(
      notifyHookPath
    )} "$@"`
  ].join("\n");
}

// One env-guarded notify program backs every Cursor hook (verified to fire only
// in the interactive CLI). Two shapes:
//   * turn START (beforeSubmitPrompt) passes the type as an argument
//     (`... agent.running`) so we never have to parse the prompt payload;
//   * turn END (stop) passes no argument, and the type is derived from the
//     `status` (completed|aborted|error) the hook pipes on stdin, so a single
//     `stop` reports done, failed, AND user-aborted — an interrupted turn is
//     not "done"; it is the user's turn, i.e. waiting.
// stdin is always drained (even when the type comes from the argument) so Cursor
// never blocks writing a large hook payload to a program that isn't reading it.
// The env guard makes the project hook inert for plain `cursor-agent` runs and
// the Cursor IDE, which carry no VIBE_TERMINAL_* env.
const CURSOR_HOOK_MARKER = "vibeterminal-cursor-notify";
const CURSOR_RUNNING_TYPE = "agent.running";
// The only types the notify program is ever allowed to POST. A bad/unknown
// argument or unparseable stdin therefore stays silent instead of POSTing junk.
const CURSOR_KNOWN_TYPES = [
  "agent.running",
  "agent.completed",
  "agent.waiting",
  "agent.failed"
];

function cursorTypeFromStatus(status) {
  const normalized = String(status || "");
  if (normalized === "error") {
    return "agent.failed";
  }
  if (normalized === "aborted") {
    return "agent.waiting";
  }
  return "agent.completed";
}

// Windows notify program (PowerShell). Type comes from the first argument (turn
// start) or, absent that, from the stdin JSON `status` (turn end); POSTs it.
function windowsCursorNotifyPs1Source() {
  const knownTypeGuard = CURSOR_KNOWN_TYPES.map(
    (type) => `$type -ne '${type}'`
  ).join(" -and ");
  return [
    `# ${CURSOR_HOOK_MARKER}`,
    "$ErrorActionPreference = 'SilentlyContinue'",
    "if ([string]::IsNullOrEmpty($env:VIBE_TERMINAL_CALLBACK_URL) -or [string]::IsNullOrEmpty($env:VIBE_TERMINAL_TELEMETRY_TOKEN) -or [string]::IsNullOrEmpty($env:VIBE_TERMINAL_SESSION_ID)) {",
    "  exit 0",
    "}",
    "$raw = ''",
    "try { $raw = [Console]::In.ReadToEnd() } catch { $raw = '' }",
    "if ($args.Count -ge 1 -and -not [string]::IsNullOrEmpty([string]$args[0])) {",
    "  $type = [string]$args[0]",
    "} else {",
    "  $status = ''",
    "  try { $status = [string]((($raw | ConvertFrom-Json)).status) } catch { $status = '' }",
    "  $type = if ($status -eq 'error') { 'agent.failed' } elseif ($status -eq 'aborted') { 'agent.waiting' } else { 'agent.completed' }",
    "}",
    `if (${knownTypeGuard}) { exit 0 }`,
    "try {",
    "  $payload = [ordered]@{",
    "    type = $type",
    "    sessionId = $env:VIBE_TERMINAL_SESSION_ID",
    "    provider = 'cursor'",
    "    timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()",
    "  }",
    "  $body = $payload | ConvertTo-Json -Compress",
    "  $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)",
    "  $request = [System.Net.WebRequest]::Create($env:VIBE_TERMINAL_CALLBACK_URL)",
    "  $request.Method = 'POST'",
    "  $request.Timeout = 1000",
    "  $request.ContentType = 'application/json'",
    "  $request.ContentLength = $bytes.Length",
    "  $request.Headers.Set('x-vibe-telemetry-token', $env:VIBE_TERMINAL_TELEMETRY_TOKEN)",
    "  $stream = $request.GetRequestStream()",
    "  try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }",
    "  $response = $request.GetResponse()",
    "  if ($response) { $response.Dispose() }",
    "} catch {",
    "  exit 0",
    "}",
    "exit 0"
  ].join(os.EOL);
}

// POSIX notify program (Node). Same contract as the PowerShell body: the type is
// the first argument (turn start) or derived from the stdin JSON `status` (turn
// end). A safety timer guarantees it proceeds even if stdin never closes, so the
// hook can never hang the agent.
function cursorNotifyHookSource() {
  return String.raw`const http = require("http");

const KNOWN_TYPES = new Set(${JSON.stringify(CURSOR_KNOWN_TYPES)});
const callbackUrl = process.env.VIBE_TERMINAL_CALLBACK_URL;
const token = process.env.VIBE_TERMINAL_TELEMETRY_TOKEN;
const sessionId = process.env.VIBE_TERMINAL_SESSION_ID;
const argType = process.argv[2] || "";

if (!callbackUrl || !token || !sessionId) {
  process.exit(0);
}

let raw = "";
let settled = false;

function finish() {
  if (settled) return;
  settled = true;

  let type = argType;
  if (!type) {
    let status = "";
    try {
      status = String(JSON.parse(raw).status || "");
    } catch {
      status = "";
    }
    type =
      status === "error"
        ? "agent.failed"
        : status === "aborted"
          ? "agent.waiting"
          : "agent.completed";
  }
  if (!KNOWN_TYPES.has(type)) {
    process.exit(0);
    return;
  }

  const body = JSON.stringify({ type, sessionId, provider: "cursor", timestamp: Date.now() });

  let url;
  try {
    url = new URL(callbackUrl);
  } catch {
    process.exit(0);
    return;
  }

  const request = http.request(
    {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: "POST",
      timeout: 1000,
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        "x-vibe-telemetry-token": token
      }
    },
    (response) => {
      response.resume();
      response.on("end", () => process.exit(0));
    }
  );

  request.on("error", () => process.exit(0));
  request.on("timeout", () => {
    request.destroy();
    process.exit(0);
  });
  request.end(body);
}

process.stdin.on("data", (chunk) => {
  raw += chunk.toString("utf8");
});
process.stdin.on("error", finish);
process.stdin.on("end", finish);
// Never hang if stdin is not piped/closed for some reason.
setTimeout(finish, 1500);
`;
}

function posixCursorNotifyShSource(nodePath, cursorNotifyHookPath) {
  return [
    "#!/usr/bin/env sh",
    `ELECTRON_RUN_AS_NODE=1 exec ${JSON.stringify(nodePath)} ${JSON.stringify(
      cursorNotifyHookPath
    )} "$@"`
  ].join("\n");
}

// Reject non-plain-object inputs (arrays, null) so a malformed hooks.json never
// gets spread into a corrupt shape.
function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isOurCursorEntry(entry) {
  return Boolean(
    entry &&
      typeof entry.command === "string" &&
      entry.command.includes(CURSOR_HOOK_MARKER)
  );
}

// The shell command Cursor runs for one of our hooks: invoke the notify program,
// passing the attention type as an argument for the running hooks and nothing for
// the stop hook (which derives it from stdin). Forward slashes in the Windows
// path dodge backslash escaping inside the JSON command string.
function cursorHookCommand(cursorNotifyProgramPath, isWin, type) {
  const arg = type ? ` ${type}` : "";
  return isWin
    ? `powershell -NoProfile -ExecutionPolicy Bypass -File "${cursorNotifyProgramPath.replace(
        /\\/g,
        "/"
      )}"${arg}`
    : `'${cursorNotifyProgramPath}'${arg}`;
}

// The set of project hooks vibeTerminal installs: turn-start "running" and
// turn-end completed/failed. Returns `{ event, command }` entries for merging.
function cursorHookEntries(cursorNotifyProgramPath, isWin) {
  return [
    {
      event: "beforeSubmitPrompt",
      command: cursorHookCommand(
        cursorNotifyProgramPath,
        isWin,
        CURSOR_RUNNING_TYPE
      )
    },
    {
      event: "stop",
      command: cursorHookCommand(cursorNotifyProgramPath, isWin)
    }
  ];
}

// Merge our env-guarded hooks into a Cursor `hooks.json` object without disturbing
// the user's own hooks. Idempotent: every prior vibeTerminal entry (identified by
// the marker the notify command carries) is dropped from EVERY event array before
// the current set is appended, so repeated launches never accumulate duplicates,
// a per-run notify path is always refreshed, and dropping an event we no longer
// register leaves no orphan. `entries` is `[{ event, command }]`.
function mergeCursorHooks(existing, entries) {
  const base = isPlainObject(existing) ? { ...existing } : {};
  base.version = base.version || 1;
  const hooks = isPlainObject(base.hooks) ? { ...base.hooks } : {};

  for (const key of Object.keys(hooks)) {
    if (Array.isArray(hooks[key])) {
      hooks[key] = hooks[key].filter((entry) => !isOurCursorEntry(entry));
    }
  }

  for (const { event, command } of entries) {
    const list = Array.isArray(hooks[event]) ? hooks[event] : [];
    hooks[event] = [...list, { command }];
  }

  // Drop any event array our filtering emptied (e.g. an event we used to
  // register but no longer do) so we never leave a bare `"event": []`.
  for (const key of Object.keys(hooks)) {
    if (Array.isArray(hooks[key]) && hooks[key].length === 0) {
      delete hooks[key];
    }
  }

  base.hooks = hooks;
  return base;
}

// Strip our entries from every event array in a Cursor hooks object (used on
// cleanup). Returns the trimmed object plus whether anything other than our own
// contribution remains, so the caller can delete a file vibeTerminal created.
function stripCursorHooks(existing) {
  const base = isPlainObject(existing) ? { ...existing } : {};
  const hooks = isPlainObject(base.hooks) ? { ...base.hooks } : {};

  for (const key of Object.keys(hooks)) {
    if (!Array.isArray(hooks[key])) {
      continue;
    }
    const filtered = hooks[key].filter((entry) => !isOurCursorEntry(entry));
    if (filtered.length > 0) {
      hooks[key] = filtered;
    } else {
      delete hooks[key];
    }
  }
  base.hooks = hooks;

  const hasOtherContent =
    Object.keys(hooks).length > 0 ||
    Object.keys(base).some((key) => key !== "version" && key !== "hooks");
  return { trimmed: base, hasOtherContent };
}

// The architect system prompt a Fusion pane's claude is launched with
// (`claude --append-system-prompt-file <file>`). Claude orchestrates and may
// write UI/design/frontend code directly; Codex owns all execution and remains
// the bug + goal-completion verifier.
function buildFusionSystemPrompt() {
  return [
    "# Terminal Fusion - you are the Claude orchestrator (Opus or Sonnet 5)",
    "",
    "You are running inside a **Fusion terminal**. You are the human-facing",
    "ORCHESTRATOR, ARCHITECT, DESIGNER, and long-horizon coding controller.",
    "Your counterpart, **Codex GPT-5.5**, is the executor, tester, bug reviewer,",
    "and goal-completion verifier.",
    "",
    "## Tooling (read this first)",
    "You have investigation tools (**Read, Grep, Glob**), direct file-edit tools",
    "for UI/design/frontend work (**Edit, Write**), and the Codex bridge tools.",
    "Use direct edits only for frontend UI/design code, renderer components,",
    "styling, and closely related user-facing copy.",
    "Path enforcement via `VIBE_FUSION_UI_WRITE_GLOBS` is deferred and not active",
    "in this build; keep direct edits to frontend/UI/design files by role discipline.",
    "",
    "## File edit decision policy",
    "Make the same editing decision a careful human engineer would make. For a",
    "local change, read the file and use **Edit** to replace the smallest coherent",
    "existing block that expresses the change. Do not rewrite whole files for",
    "routine line/function/style tweaks.",
    "Full-file replacement is still valid when creating or regenerating a file,",
    "replacing a generated/tiny artifact, or when a cohesive rewrite is genuinely",
    "safer than many fragile local edits. When you use **Write**, make that",
    "decision explicit to yourself and preserve unrelated content.",
    "",
    "## Concurrent edits (shared checkout)",
    "The user may run other agent panes or tools against this same folder. If",
    "Edit/Write is rejected because a file changed since you read it, first ask",
    "whether the change is explained by your own delegation - Codex editing files",
    "you just sent it is normal Fusion operation. If it is NOT (a file neither",
    "you nor Codex touched this turn has drifted), treat the rejection as a",
    "signal, not an obstacle: re-read the file, compare the drift against your",
    "intent, and if it looks like another agent's in-progress work, hold that",
    "edit and surface what you found to the user instead of overwriting it or",
    "silently retrying.",
    "",
    "## Speed and exploration routing",
    "Do not spend expensive Claude turns doing broad repo spelunking. For",
    "exploratory work, file fetching, large searches, dependency tracing, or",
    "multi-file context collection, delegate to **codex_investigate** with a request",
    "to investigate and return concise findings plus the relevant file paths or",
    "snippets. Use those findings to do the architecture/design thinking yourself.",
    "If the user's request depends on a capability you do not have directly,",
    "delegate to Codex instead of guessing, refusing, or describing your limitation.",
    "This includes command output, git state, GitHub/remote release data,",
    "CI/workflow status, network/API access, package/tool versions, OS/environment",
    "state, browser/screenshot/image work, and any future tool or environment",
    "capability outside your direct Read/Grep/Glob/Edit/Write surface.",
    "Use **codex_investigate** for read-only checks and context gathering. Use",
    "**codex_implement** when the request requires changing files, creating",
    "tags/releases, pushing, installing packages, or running build/test/debug",
    'commands. Do not answer "I cannot access X here" unless Codex has attempted',
    "the check or action and returned a concrete blocker.",
    "For UI/design/frontend work, you write the UI code directly when practical;",
    "then send Codex a verification/debugging pass with the files changed and what",
    "to test, including screenshots or browser checks when needed.",
    "",
    "You do NOT have shell execution. **Bash is blocked.** Do not run commands,",
    "builds, tests, debug scripts, package installs, screenshots, browser control,",
    "or image generation yourself. ALL execution work goes through Codex via",
    "**codex_implement**. Browser navigation/control/automation and picture/image",
    "generation are also Codex-owned execution work in Fusion.",
    "",
    "Use Read/Grep/Glob for pure read-only investigation yourself. Before",
    "delegating backend/core work, broad refactors, or execution-heavy work, do",
    "the cheap read-only triage that identifies files, constraints, existing",
    "patterns, and likely implementation shape. Do not round-trip pure reads,",
    "file discovery, or text search through Codex unless you need an independent",
    "verifier pass or a command/test/browser/image result.",
    "",
    "When the task is frontend/UI/design implementation, use Codex for broad",
    "exploration/debugging/verification, but keep Claude responsible for the UI",
    "design and code-writing decisions. Edit or Write UI files directly when that",
    "is the best engineering move, then delegate execution and verification to Codex.",
    "When the task needs backend/core changes, broad refactors, generated assets,",
    "runtime debugging, or any command output, delegate that work to Codex instead",
    "of trying to do it yourself.",
    "",
    "## Plan mode",
    "If the user switches Fusion to Plan mode, follow the per-turn Plan directive:",
    "investigate read-only and present a plan. Do not call Codex bridge execution",
    "tools until Auto mode is restored.",
    "",
    "## Your scope",
    "- Architecture and design decisions.",
    "- Long-horizon coding control through Codex's native goal state.",
    "- Direct UI/design/frontend edits when they do not require command execution.",
    "- Planning the work and splitting it into precise, self-contained tasks.",
    "- Guiding Codex with strategy, constraints, UI intent, debugging direction, and follow-up corrections.",
    "- Threat-modeling and debugging *strategy* (what to investigate and why).",
    "- Human-facing tradeoff reasoning and override decisions.",
    "- Reviewing diffs and verifier verdicts with Read/Grep/Glob.",
    '- "What are we missing?" analysis and tradeoff reasoning.',
    "",
    "## Codex's scope",
    "- ALL execution: builds, test runs, app launches, debug commands, package installs, and command output collection.",
    "- Screenshots, browser navigation/control/automation, and picture/image generation.",
    "- Backend/core implementation, broad refactors, exploratory file gathering, debugging, and any frontend verification work you delegate.",
    "- Following Claude's guidance while independently checking the implementation.",
    "- Reviewing for bugs, missed requirements, and whether the user's goal is actually reached.",
    "- Tracking the active objective in Codex's native per-thread goal state.",
    "- Returning a structured verifier verdict that gates completion.",
    "",
    "## Codex native goals",
    "For substantial user work, call **codex_goal_set** before the first",
    "codex_implement call. Treat this as Claude adopting Codex's long-horizon",
    "coding state: set `objective` to the user's top-level objective and",
    '`status:"active"`, then delegate concrete execution steps to Codex.',
    "Use **codex_goal_get** before final completion or when you need the current",
    "goal/usage state. Use **codex_goal_clear** only when the human abandons the",
    "objective or starts a separate unrelated objective.",
    "The Fusion adapter also creates a fallback Codex goal when codex_implement",
    "runs without one, and marks the native goal complete after a successful",
    "Codex verifier verdict. It does not overwrite Codex-managed blocked or",
    "usage/budget-limited goal states.",
    "",
    "## How to delegate to Codex",
    "Use **codex_investigate** for read-only repo scouting, file fetching, large",
    "searches, and findings that should feed Claude's thinking. Ask for concise",
    "findings, relevant file paths, and short snippets. This does not create a",
    "goal and does not run the implementation verifier.",
    "Use the **codex_implement** tool (NOT your shell, NOT `codex` directly) with",
    "complete, self-contained instructions - Codex does not share your context, so",
    "give it the files, intent, constraints, acceptance criteria, and what to verify.",
    "Delegate in fewer, larger chunks after your read-only triage. A good",
    "handoff bundles the relevant files and findings, the intended behavior,",
    "implementation constraints, likely touch points, acceptance criteria, and",
    "verification expectations into one coherent task. Do not split work into",
    "many small Codex calls for individual reads, single-file edits, or obvious",
    "follow-up checks when one self-contained implementation/review pass can",
    "cover them without losing accuracy. Larger chunks must carry more context,",
    "not vaguer instructions.",
    "If you edited frontend files directly, tell Codex what changed and ask it to",
    "review the diff, run the needed checks, debug failures, and verify completion.",
    "For picture/image generation include the visual intent, style, dimensions,",
    "asset paths, and acceptance criteria. For browser control include the URL,",
    "viewport or target environment, interaction steps, and what to verify.",
    "Codex runs tests/commands, generates images, controls browsers, fixes bugs,",
    "and verifies goal completion.",
    "Fusion Codex runs with full workspace access and does not prompt for routine",
    "command approvals; you may still see `needs_decision` for genuine questions",
    "or exceptional permission requests.",
    "codex_implement returns one of:",
    "",
    '- `{status:"completed", summary, files, goalReached, bugsFound,',
    '  missingRequirements, nextAction, verifierVerdict, goal}` - inspect the result.',
    '  If `goalReached:false`, `nextAction:"continue"`, bugs are listed, or',
    "  requirements are missing, you MUST continue or redelegate with precise",
    "  instructions. Do not tell the user the task is done.",
    '  If `nextAction:"ask_human"`, ask the human for the missing decision.',
    '  If `goalReached:true` and `nextAction:"done"`, you may finish.',
    '- `{status:"needs_decision", pendingId, kind, detail}` - Codex is asking a',
    "  question or surfaced an exceptional permission request. DECIDE IT YOURSELF and reply",
    "  with **codex_respond** (`decision`: accept | acceptForSession | decline |",
    "  cancel; for a question set decision to accept and put the answer in `note`).",
    "  Only ask the human when you genuinely cannot decide, especially for",
    "  credential risk, external account access, destructive intent, or unclear intent.",
    '- `{status:"failed", error}` - diagnose; if Codex is unavailable / not',
    "  authenticated, tell the user to run `codex login`.",
    "",
    "If a Codex turn seems stuck (codex_implement reports a turn already in",
    "progress with no pending decision, or a delegation hangs without progress),",
    "call **codex_cancel** to abort the stuck turn locally, then re-delegate. The",
    "Codex thread survives a cancel.",
    "",
    "## Completion gate",
    "Codex is the hard verifier for bugs and goal completion. If Codex says the",
    "goal is not reached, continue unless the human explicitly tells you to stop",
    "or you make an explicit higher-level override. If you override Codex, state",
    "`Codex verifier override:` followed by the reason in the transcript.",
    "Direct Claude frontend edits are not complete until Codex has reviewed and",
    "verified them. Always let Codex's verifier verdict gate completion.",
    "",
    "## User-facing style",
    "Present yourself as one Fusion agent. Do not narrate internal bridge mechanics",
    "such as goal tool calls, pending ids, raw JSON tool results, or tool-name",
    "availability warnings unless the user explicitly asks for implementation",
    "details. Summarize work in human terms: what you are checking, what changed,",
    "what passed, and what still needs a decision.",
    ""
  ].join("\n");
}
// Per-session claude settings file passed via `claude --settings <file>`. Adds
// hooks that fire the notify program on turn completion (Stop) and when claude
// needs the user (Notification). `--settings` merges over the user's own
// settings without mutating ~/.claude.
function buildClaudeSettingsJson(scriptPath, isWin) {
  const hook = (type, detail) => {
    // Keep the command shell-agnostic so it works whatever shell claude runs
    // hooks under: on Windows invoke powershell explicitly against the .ps1
    // (forward slashes dodge backslash-escaping in any shell); on POSIX run the
    // executable notify wrapper directly. The optional detail rides as a second
    // argument (whitelisted by the notify program).
    const args = detail ? `${type} ${detail}` : type;
    const command = isWin
      ? `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath.replace(
          /\\/g,
          "/"
        )}" ${args}`
      : `'${scriptPath}' '${type}'${detail ? ` '${detail}'` : ""}`;
    return { type: "command", command, timeout: 5 };
  };

  const settings = {
    hooks: {
      // Turn START: the user submitted a prompt. This is the interaction-proof
      // signal behind the sidebar "working" spinner, so typing or clicking the
      // pane never reads as working. Only THIS running event may override a
      // finished (done/failed) pill: a new turn legitimately supersedes the
      // previous result.
      UserPromptSubmit: [{ matcher: "*", hooks: [hook("agent.running")] }],
      // Tool activity: re-asserts "working" mid-turn (e.g. after a permission
      // approval). Tagged "tool" so the renderer routes it through the
      // done/failed latch — the hooks POST from independent short-lived
      // processes with no ordering guarantee, so a tool hook that lands AFTER
      // the turn's Stop must not resurrect a completed pane's spinner.
      PreToolUse: [{ matcher: "*", hooks: [hook("agent.running", "tool")] }],
      PostToolUse: [{ matcher: "*", hooks: [hook("agent.running", "tool")] }],
      Stop: [{ matcher: "*", hooks: [hook("agent.completed")] }],
      // Split so the pill can tell an approval prompt from an idle "your turn":
      // answering an approval has no hook of its own (PreToolUse fires before
      // the prompt, PostToolUse only when the tool ends), so the renderer flips
      // waiting->running on the user's answer keystroke for approvals only.
      Notification: [
        {
          matcher: "permission_prompt",
          hooks: [hook("agent.waiting", "approval")]
        },
        {
          matcher: "idle_prompt",
          hooks: [hook("agent.waiting", "question")]
        }
      ]
    }
  };

  return `${JSON.stringify(settings, null, 2)}\n`;
}

// Bump on ANY plugin-source change: installOpenCodePlugin only rewrites an
// installed copy when its version string differs.
const OPENCODE_PLUGIN_VERSION = "vibeterminal-notify-4";

// opencode cannot take a per-invocation hook, so we install one small plugin in
// the user's opencode config. It is guarded: it only POSTs when the
// VIBE_TERMINAL_* env vars are present, so a plain `opencode` run does nothing.
//
// Turn START (`agent.running`, the sidebar "working" spinner) is inferred from
// message-stream events: while the assistant is generating, opencode emits a
// burst of `message.*` events, so the FIRST one after idle reports "working" and
// the rest are throttled by the per-turn `busy` latch (reset on every mapped
// event: idle/error end the turn, permission prompts pause it).
//
// Child sessions (task-tool subagents, e.g. the Open Fusion executor) also emit
// `session.idle`/`session.error`, and a child finishing is NOT the pane's turn
// ending — the root session is still driving. Children are recognized by the
// `parentID` their session.created/updated info carries (payload shapes
// verified against opencode 1.17.11: session.idle={sessionID},
// session.created/updated={sessionID,info}, permission.*={...sessionID});
// unknown shapes leave the child set empty, so this fails OPEN to the old
// behavior. Permission asks are never filtered — the user answers them in this
// TUI whichever session raised them.
// NOTE: the exact `message.*` event names are LIVE-VERIFY pending; if they differ
// in a given opencode version the spinner simply won't show (no false positive),
// while done/waiting still flow from session.idle/permission events.
function openCodePluginSource() {
  return [
    `// vibeterminal-notify (${OPENCODE_PLUGIN_VERSION}) - auto-generated by vibeTerminal.`,
    "// Safe no-op outside vibeTerminal: only POSTs when VIBE_TERMINAL_* env vars are set.",
    "export const VibeTerminalNotify = async () => {",
    "  let busy = false;",
    "  const childSessions = new Set();",
    "  const eventSessionId = (event) => {",
    "    const props = event.properties;",
    '    if (!props || typeof props !== "object") return undefined;',
    '    if (typeof props.sessionID === "string") return props.sessionID;',
    '    if (props.info && typeof props.info.sessionID === "string") return props.info.sessionID;',
    "    return undefined;",
    "  };",
    "  return {",
    "    event: async ({ event }) => {",
    "      const url = process.env.VIBE_TERMINAL_CALLBACK_URL;",
    "      const token = process.env.VIBE_TERMINAL_TELEMETRY_TOKEN;",
    "      const sessionId = process.env.VIBE_TERMINAL_SESSION_ID;",
    '      if (!url || !token || !sessionId || !event || typeof event.type !== "string") {',
    "        return;",
    "      }",
    "      const send = async (type, detail) => {",
    "        try {",
    "          await fetch(url, {",
    '            method: "POST",',
    "            headers: {",
    '              "content-type": "application/json",',
    '              "x-vibe-telemetry-token": token',
    "            },",
    "            // JSON.stringify drops an undefined detail.",
    '            body: JSON.stringify({ type, detail, sessionId, provider: "opencode", timestamp: Date.now() })',
    "          });",
    "        } catch (_error) {",
    "          // Telemetry is best-effort; ignore delivery failures.",
    "        }",
    "      };",
    "      // Track task-tool child sessions from the parentID their info carries.",
    '      if (event.type === "session.created" || event.type === "session.updated") {',
    "        const info = event.properties && event.properties.info;",
    '        if (info && typeof info.id === "string" && info.parentID) {',
    "          childSessions.add(info.id);",
    "        }",
    "        return;",
    "      }",
    '      if (event.type.startsWith("message.")) {',
    "        if (!busy) {",
    "          busy = true;",
    '          await send("agent.running");',
    "        }",
    "        return;",
    "      }",
    "      const map = {",
    '        "session.idle": "agent.completed",',
    '        "permission.asked": "agent.waiting",',
    '        "permission.updated": "agent.waiting",',
    '        "session.error": "agent.failed"',
    "      };",
    "      const type = map[event.type];",
    "      if (!type) {",
    "        return;",
    "      }",
    "      // A child session going idle/erroring is not the pane's turn ending",
    "      // (the root session is still driving) - it must not flash done/failed",
    "      // or drop the busy latch mid-delegation. Permission asks always pass.",
    "      if (",
    '        (event.type === "session.idle" || event.type === "session.error") &&',
    "        childSessions.has(eventSessionId(event))",
    "      ) {",
    "        return;",
    "      }",
    "      // Every mapped event ends the current working stretch: idle/error end",
    "      // the turn, and a permission prompt pauses it with NO event of its own",
    "      // for the approval that resumes it - dropping the latch here lets the",
    "      // next message.* burst re-assert agent.running after the user approves.",
    "      busy = false;",
    '      await send(type, type === "agent.waiting" ? "approval" : undefined);',
    "    }",
    "  };",
    "};",
    ""
  ].join("\n");
}

function installOpenCodePlugin(homeDir = os.homedir()) {
  try {
    const base = path.join(homeDir, ".config", "opencode");
    if (!fs.existsSync(base)) {
      // User has no opencode config yet; install lazily on a later launch.
      return;
    }

    const source = openCodePluginSource();
    // opencode has used both "plugin" and "plugins" for its local-plugin dir
    // across versions; write to both so discovery does not depend on the spelling.
    for (const dirName of ["plugin", "plugins"]) {
      const file = path.join(base, dirName, "vibeterminal-notify.js");
      try {
        if (fs.readFileSync(file, "utf8").includes(OPENCODE_PLUGIN_VERSION)) {
          continue;
        }
      } catch {
        // Not present or unreadable: fall through and (re)write it.
      }
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, source);
      } catch {
        // Best-effort; never let plugin install break telemetry startup.
      }
    }
  } catch {
    // Never let opencode plugin install break the telemetry manager.
  }
}

function mapTelemetryToAttention(event) {
  if (event.type === "agent.process.exited") {
    const hasSignal = Boolean(event.signal);
    const exitCode =
      event.exitCode === undefined || event.exitCode === null
        ? null
        : Number(event.exitCode);
    const completed = !hasSignal && exitCode === 0;
    return {
      state: completed ? "completed" : "failed",
      reason: completed ? "done" : "exit",
      source: "shim",
      message: event.error || (hasSignal ? `Exited with signal ${event.signal}.` : undefined),
      updatedAt: Date.now()
    };
  }

  if (event.type === "agent.waiting") {
    // The claude Notification hooks tag the wait: "approval" (permission
    // prompt) vs "question" (idle prompt). The renderer uses the distinction to
    // flip waiting->running on the user's answer keystroke for approvals.
    const reason = event.detail || event.reason;
    return {
      state: "waiting",
      reason: reason === "approval" ? "approval" : "question",
      source: "provider",
      message: event.message,
      updatedAt: Date.now()
    };
  }

  if (event.type === "agent.completed") {
    return {
      state: "completed",
      reason: "done",
      source: "provider",
      message: event.message,
      updatedAt: Date.now()
    };
  }

  if (event.type === "agent.failed") {
    return {
      state: "failed",
      reason: "error",
      source: "provider",
      message: event.message,
      updatedAt: Date.now()
    };
  }

  return null;
}

function createAgentTelemetryManager(options = {}) {
  const baseDir = options.baseDir || SHIM_BASE_DIR;
  const openFusionBaseDir =
    options.openFusionBaseDir || path.join(path.dirname(baseDir), "openfusion");
  const emit = options.emit || (() => {});
  const runId = options.runId || `${Date.now()}-${process.pid}-${crypto.randomUUID()}`;
  const token = options.token || crypto.randomBytes(32).toString("hex");
  const nodePath = options.nodePath || process.execPath;
  const runDir = path.join(baseDir, runId);
  const runnerPath = path.join(runDir, "shim-runner.cjs");
  const isWin = process.platform === "win32";
  const notifyHookPath = path.join(runDir, "notify-hook.cjs");
  const notifyPs1Path = path.join(runDir, "notify.ps1");
  const notifyShPath = path.join(runDir, "notify.sh");
  const claudeSettingsPath = path.join(runDir, "claude-settings.json");
  // The single "notify program" each agent invokes with the attention type as
  // its first argument: the PowerShell body on Windows, the sh wrapper on POSIX.
  const notifyProgramPath = isWin ? notifyPs1Path : notifyShPath;
  // Cursor's stop hook derives the attention type from the JSON it pipes on
  // stdin, so it gets its own notify program. The filename carries the marker so
  // mergeCursorHooks can recognise (and refresh) our entry inside the user's
  // project hooks.json across runs.
  const cursorNotifyPs1Path = path.join(runDir, `${CURSOR_HOOK_MARKER}.ps1`);
  const cursorNotifyHookPath = path.join(runDir, `${CURSOR_HOOK_MARKER}.cjs`);
  const cursorNotifyShPath = path.join(runDir, `${CURSOR_HOOK_MARKER}.sh`);
  const cursorNotifyProgramPath = isWin ? cursorNotifyPs1Path : cursorNotifyShPath;
  // Project hooks.json files we have touched this run, mapped to whether the
  // file pre-existed, so cleanup can strip our entry (or delete a file we
  // created) without disturbing the user's own hooks.
  const cursorHookFiles = new Map();
  const sessions = new Map();
  const fusionAdapterControls = new Map();
  const fusionAdapterModes = new Map();
  let server = null;
  let callbackUrl = null;

  const ready = new Promise((resolve, reject) => {
    try {
      fs.mkdirSync(baseDir, { recursive: true });
      cleanupStaleShimDirs({ baseDir, currentRunId: runId });
      cleanupStaleOpenFusionDirs(openFusionBaseDir);
      writeMarker(runDir, { runId, type: "run" });
      fs.writeFileSync(runnerPath, shimRunnerSource());

      // Per-turn notification assets: the notify program (PowerShell on Windows,
      // Node-via-sh on POSIX) plus the claude --settings hook file. codex points
      // its `notify` at the same program; opencode uses a guarded global plugin.
      if (isWin) {
        fs.writeFileSync(notifyPs1Path, windowsNotifyPs1Source());
        fs.writeFileSync(cursorNotifyPs1Path, windowsCursorNotifyPs1Source());
      } else {
        fs.writeFileSync(notifyHookPath, notifyHookSource());
        fs.writeFileSync(notifyShPath, posixNotifyShSource(nodePath, notifyHookPath));
        fs.chmodSync(notifyShPath, 0o755);
        fs.writeFileSync(cursorNotifyHookPath, cursorNotifyHookSource());
        fs.writeFileSync(
          cursorNotifyShPath,
          posixCursorNotifyShSource(nodePath, cursorNotifyHookPath)
        );
        fs.chmodSync(cursorNotifyShPath, 0o755);
      }
      fs.writeFileSync(
        claudeSettingsPath,
        buildClaudeSettingsJson(notifyProgramPath, isWin)
      );
      installOpenCodePlugin(options.openCodeHome);

      server = http.createServer((request, response) => {
        if (request.method !== "POST" || request.url !== "/agent-event") {
          response.writeHead(404);
          response.end();
          return;
        }

        if (request.headers["x-vibe-telemetry-token"] !== token) {
          response.writeHead(403);
          response.end();
          return;
        }

        let body = "";
        request.on("data", (chunk) => {
          body += chunk.toString("utf8");
          if (body.length > MAX_EVENT_BYTES) {
            request.destroy();
          }
        });

        request.on("end", () => {
          try {
            const event = JSON.parse(body);
            if (!event.sessionId || typeof event.type !== "string") {
              response.writeHead(400);
              response.end();
              return;
            }

            if (event.type === "fusion.adapterReady") {
              const normalizedSessionId = normalizeSessionId(event.sessionId);
              let controlUrl = null;
              try {
                const parsedUrl = new URL(String(event.controlUrl || ""));
                if (
                  parsedUrl.protocol === "http:" &&
                  parsedUrl.hostname === "127.0.0.1" &&
                  parsedUrl.port
                ) {
                  parsedUrl.pathname = parsedUrl.pathname.replace(/\/+$/, "");
                  parsedUrl.search = "";
                  parsedUrl.hash = "";
                  controlUrl = parsedUrl.toString().replace(/\/$/, "");
                }
              } catch {
                controlUrl = null;
              }
              if (normalizedSessionId && controlUrl) {
                fusionAdapterControls.set(normalizedSessionId, controlUrl);
              }
              if (normalizedSessionId && controlUrl) {
                void postFusionAdapterControl(normalizedSessionId, "/mode", {
                  mode: fusionAdapterModes.get(normalizedSessionId) || "auto"
                });
              }
            } else if (event.type === "fusion.activity") {
              // Read-only Codex activity for the Fusion pane's role-tagged log
              // (relayed by backend/fusion-adapter.cjs). Not an attention signal.
              emit({
                id: event.sessionId,
                type: "fusion-activity",
                role: event.role,
                kind: event.kind,
                text: event.text,
                ts: event.ts
              });
            } else if (event.type === "agent.backgroundActivity") {
              const activity = event.backgroundActivity && typeof event.backgroundActivity === "object"
                ? event.backgroundActivity
                : {
                    active: Boolean(event.active),
                    count: Number(event.count) || 0,
                    source: event.source,
                    items: Array.isArray(event.items) ? event.items : [],
                    updatedAt: Number(event.updatedAt) || Date.now()
                  };
              emit({
                id: event.sessionId,
                type: "agent-background-activity",
                provider: event.provider,
                backgroundActivity: activity
              });
            } else if (event.type === "agent.running") {
              // A turn started (claude UserPromptSubmit/tool use, opencode busy
              // event, cursor beforeSubmitPrompt). This drives the pane's
              // "working" state only; it is not an attention/unread signal, so
              // it rides a dedicated event. Only a genuine turn START may
              // override a finished (done/failed) pill; mid-turn tool activity
              // (detail "tool") must respect it, so a tool hook that races past
              // the turn's Stop cannot resurrect the spinner.
              emit({
                id: event.sessionId,
                type: "agent-running",
                provider: event.provider,
                turnStart: event.detail !== "tool"
              });
            } else {
              const attention = mapTelemetryToAttention(event);
              if (attention) {
                emit({
                  id: event.sessionId,
                  type: "agent-attention",
                  provider: event.provider,
                  attention
                });
              }
            }

            response.writeHead(204);
            response.end();
          } catch {
            response.writeHead(400);
            response.end();
          }
        });
      });

      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        callbackUrl = `http://127.0.0.1:${address.port}/agent-event`;
        resolve();
      });
    } catch (error) {
      reject(error);
    }
  });

  async function prepareSession(sessionId, options = {}) {
    await ready;
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId) {
      return null;
    }

    if (sessions.has(normalizedSessionId)) {
      return sessions.get(normalizedSessionId).instrumentation;
    }

    const sessionDir = path.join(runDir, sessionDirName(normalizedSessionId));
    const shimDir = path.join(sessionDir, "bin");
    fs.mkdirSync(shimDir, { recursive: true });
    writeMarker(sessionDir, {
      runId,
      sessionId: normalizedSessionId,
      type: "session"
    });
    for (const provider of PROVIDERS) {
      writeWrapper(shimDir, provider, runnerPath, nodePath);
    }

    const key = pathEnvKey(process.env);
    const originalPath = process.env[key] || "";
    const nextPath = [shimDir, originalPath].filter(Boolean).join(path.delimiter);
    const instrumentation = {
      shimDir,
      env: {
        [key]: nextPath,
        VIBE_TERMINAL_SESSION_ID: normalizedSessionId,
        VIBE_TERMINAL_CALLBACK_URL: callbackUrl,
        VIBE_TERMINAL_TELEMETRY_TOKEN: token,
        VIBE_TERMINAL_ORIGINAL_PATH: originalPath,
        VIBE_TERMINAL_SHIM_DIR: shimDir,
        VIBE_TERMINAL_CLAUDE_SETTINGS: claudeSettingsPath,
        VIBE_TERMINAL_NOTIFY_PROGRAM: notifyProgramPath
      }
    };

    sessions.set(normalizedSessionId, {
      dir: sessionDir,
      instrumentation
    });
    return instrumentation;
  }

  async function prepareOpenFusionFiles(sessionId, opts = {}) {
    await ready;
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId) {
      return null;
    }

    const instrumentation = await prepareSession(normalizedSessionId);
    if (!instrumentation) {
      return null;
    }

    // App-owned OpenCode home: threads, credentials, and global config for
    // every Open Fusion pane live here, never in the user's personal install.
    const opencodeHome = ensureOpenFusionOpencodeHome(openFusionBaseDir);

    const openFusionDir = path.join(
      openFusionBaseDir,
      "sessions",
      sessionDirName(normalizedSessionId)
    );
    const configDir = path.join(openFusionDir, "config");
    const themesDir = path.join(configDir, "themes");
    const commandsDir = path.join(configDir, "commands");
    // Outside configDir on purpose: the TUI loads this plugin via the tui.json
    // "plugin" entry, while anything under configDir/plugins is also picked up
    // by the server-side loader, which rejects tui-only modules.
    const pluginsDir = path.join(openFusionDir, "plugins");
    fs.mkdirSync(themesDir, { recursive: true });
    fs.mkdirSync(commandsDir, { recursive: true });
    fs.mkdirSync(pluginsDir, { recursive: true });

    const configPath = path.join(configDir, "opencode.json");
    const tuiConfigPath = path.join(openFusionDir, "tui.json");
    const themePath = path.join(themesDir, "vibeterminal-openfusion.json");
    const plannerPromptPath = path.join(configDir, "openfusion-planner.md");
    const executorPromptPath = path.join(configDir, "openfusion-executor.md");
    const investigatorPromptPath = path.join(configDir, "openfusion-investigator.md");
    const modelStatePath = path.join(openFusionDir, "models.json");
    const tuiPluginPath = path.join(pluginsDir, "vibeterminal-openfusion-tui.js");
    const savedModels = readOpenFusionModelState(modelStatePath);
    const effectiveOpts = {
      ...opts,
      plannerModel: savedModels.plannerModel || opts.plannerModel,
      executorModel: savedModels.executorModel || opts.executorModel
    };
    const { plannerModel, executorModel } = openFusionResolvedModels(effectiveOpts);

    fs.writeFileSync(plannerPromptPath, `${openFusionPlannerPrompt()}\n`);
    fs.writeFileSync(executorPromptPath, `${openFusionExecutorPrompt()}\n`);
    fs.writeFileSync(investigatorPromptPath, `${openFusionInvestigatorPrompt()}\n`);
    const fileConfig = openFusionConfigContents({ plannerModel, executorModel });
    const envConfig = openFusionConfigContents({
      plannerModel,
      executorModel,
      inlinePrompts: true
    });
    fs.writeFileSync(configPath, `${JSON.stringify(fileConfig, null, 2)}\n`);
    for (const [name, command] of Object.entries(openFusionCommandContents({
      plannerModel,
      executorModel
    }))) {
      fs.writeFileSync(path.join(commandsDir, `${name}.md`), commandMarkdown(command));
    }
    fs.writeFileSync(tuiPluginPath, openFusionTuiPluginSource());
    // Drop the pre-picker copy inside configDir: the server-side loader scans
    // that dir and rejects tui-only modules with a load error on every start.
    fs.rmSync(path.join(configDir, "plugins", "vibeterminal-openfusion-tui.js"), {
      force: true
    });
    fs.writeFileSync(
      modelStatePath,
      `${JSON.stringify(
        {
          plannerModel,
          executorModel,
          updatedAt: new Date().toISOString()
        },
        null,
        2
      )}\n`
    );
    fs.writeFileSync(themePath, `${JSON.stringify(openFusionTheme(), null, 2)}\n`);
    fs.writeFileSync(
      tuiConfigPath,
      `${JSON.stringify(
        {
          $schema: "https://opencode.ai/tui.json",
          theme: "vibeterminal-openfusion",
          // The TUI plugin host only loads plugins declared in the TUI config;
          // config-dir discovery feeds the server-side loader instead.
          plugin: [url.pathToFileURL(tuiPluginPath).href],
          mouse: true,
          diff_style: "auto",
          attention: {
            enabled: false
          }
        },
        null,
        2
      )}\n`
    );

    return {
      openFusionDir,
      configPath,
      configDir,
      commandsDir,
      pluginsDir,
      tuiConfigPath,
      themePath,
      modelStatePath,
      tuiPluginPath,
      plannerPromptPath,
      executorPromptPath,
      investigatorPromptPath,
      opencodeHome,
      env: {
        OPENCODE_CONFIG: configPath,
        OPENCODE_CONFIG_DIR: configDir,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(envConfig),
        OPENCODE_TUI_CONFIG: tuiConfigPath,
        OPENCODE_CLIENT: "vibeterminal-openfusion",
        OPENCODE_DISABLE_AUTOUPDATE: "true",
        // Full data ownership: opencode's entire data tree (threads in
        // opencode.db, auth.json, snapshots, logs) and its global-config
        // lookup resolve inside the app's own home. Known leak, documented:
        // executor shell commands inherit these XDG overrides (benign on
        // Windows, where nothing standard consumes them).
        XDG_DATA_HOME: opencodeHome.dataDir,
        XDG_CONFIG_HOME: opencodeHome.configDir,
        VIBE_TERMINAL_OPEN_FUSION: "1",
        VIBE_TERMINAL_OPEN_FUSION_DIR: openFusionDir,
        VIBE_TERMINAL_OPEN_FUSION_CONFIG: configPath,
        VIBE_TERMINAL_OPEN_FUSION_TUI_CONFIG: tuiConfigPath,
        VIBE_TERMINAL_OPEN_FUSION_MODEL_STATE: modelStatePath,
        VIBE_TERMINAL_OPEN_FUSION_PLANNER_MODEL: plannerModel,
        VIBE_TERMINAL_OPEN_FUSION_EXECUTOR_MODEL: executorModel
      }
    };
  }

  // Persist pane-scoped Open Fusion Brain/Executor picks (the same models.json
  // the TUI-plugin pickers wrote). prepareOpenFusionFiles re-reads it on the
  // next pane start, so executor changes are restart-applied by construction.
  async function updateOpenFusionModels(sessionId, opts = {}) {
    await ready;
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId) {
      return { status: "failed", error: "missing session id" };
    }
    try {
      const openFusionDir = path.join(
        openFusionBaseDir,
        "sessions",
        sessionDirName(normalizedSessionId)
      );
      const modelStatePath = path.join(openFusionDir, "models.json");
      const current = readOpenFusionModelState(modelStatePath);
      const next = {
        plannerModel:
          typeof opts.plannerModel === "string" && opts.plannerModel.trim()
            ? opts.plannerModel.trim()
            : current.plannerModel || null,
        executorModel:
          typeof opts.executorModel === "string" && opts.executorModel.trim()
            ? opts.executorModel.trim()
            : current.executorModel || null,
        updatedAt: new Date().toISOString()
      };
      fs.mkdirSync(openFusionDir, { recursive: true });
      fs.writeFileSync(modelStatePath, `${JSON.stringify(next, null, 2)}\n`);
      return { status: "ok", modelStatePath, models: next };
    } catch (error) {
      return { status: "failed", error: error?.message || String(error) };
    }
  }

  function fusionRunModePathForSession(normalizedSessionId) {
    return path.join(runDir, sessionDirName(normalizedSessionId), "fusion-run-mode.txt");
  }

  function writeFusionRunModeFile(normalizedSessionId, mode) {
    const runMode = normalizeFusionRunMode(mode);
    const modeFile = fusionRunModePathForSession(normalizedSessionId);
    fs.mkdirSync(path.dirname(modeFile), { recursive: true });
    fs.writeFileSync(modeFile, `${runMode}\n`);
    return modeFile;
  }

  function fusionSettingsPathForSession(normalizedSessionId) {
    return path.join(runDir, sessionDirName(normalizedSessionId), "fusion-settings.json");
  }

  function fusionSettingsFileContents(opts = {}) {
    return {
      codexModel: opts.codexModel || null,
      codexEffort: opts.codexEffort || null,
      updatedAt: new Date().toISOString()
    };
  }

  function writeFusionSettingsFile(normalizedSessionId, opts = {}) {
    const settingsFile = fusionSettingsPathForSession(normalizedSessionId);
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    const settings = fusionSettingsFileContents(opts);
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + "\n");
    return { settingsFile, settings };
  }

  async function updateFusionSettings(sessionId, opts = {}) {
    await ready;
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId) {
      return { status: "failed", error: "missing session id" };
    }
    try {
      const result = writeFusionSettingsFile(normalizedSessionId, opts);
      return { status: "ok", ...result };
    } catch (error) {
      return { status: "failed", error: error?.message || String(error) };
    }
  }

  // Generate the per-pane Fusion files (Codex MCP adapter config + architect
  // system prompt) for the HEADLESS chat path (backend/fusionChatHost.cjs spawns
  // `claude` with these as explicit argv). Independent of the PTY shim. Returns
  // { systemPromptFile, mcpConfig, settingsFile } absolute paths.
  async function prepareFusionFiles(sessionId, opts = {}) {
    await ready;
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId) {
      return null;
    }

    const sessionDir = path.join(runDir, sessionDirName(normalizedSessionId));
    fs.mkdirSync(sessionDir, { recursive: true });

    const runMode = normalizeFusionRunMode(opts.runMode);
    fusionAdapterModes.set(normalizedSessionId, runMode);
    const runModeFile = writeFusionRunModeFile(normalizedSessionId, runMode);
    const { settingsFile } = writeFusionSettingsFile(normalizedSessionId, opts);

    const systemPromptFile = path.join(sessionDir, "fusion-system-prompt.md");
    fs.writeFileSync(systemPromptFile, buildFusionSystemPrompt());

    const adapterPath = path.join(__dirname, "fusion-adapter.cjs");
    const mcpConfigObj = {
      mcpServers: {
        "fusion-codex": {
          command: nodePath,
          args: [adapterPath],
          env: {
            ELECTRON_RUN_AS_NODE: "1",
            VIBE_FUSION_CODEX_BIN: opts.codexBin || "codex",
            // Pin the user's Codex home so the EMBEDDED binary uses their existing
            // ChatGPT/Codex login (auth.json) with zero re-auth — even if the MCP
            // spawn chain doesn't inherit HOME/USERPROFILE.
            CODEX_HOME: process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
            VIBE_TERMINAL_FUSION_CWD: opts.cwd || "",
            VIBE_TERMINAL_SESSION_ID: normalizedSessionId,
            VIBE_TERMINAL_CALLBACK_URL: callbackUrl,
            VIBE_TERMINAL_TELEMETRY_TOKEN: token,
            VIBE_FUSION_EAGER_BOOT: "1",
            VIBE_FUSION_RUN_MODE: runMode,
            VIBE_FUSION_RUN_MODE_FILE: runModeFile,
            VIBE_FUSION_CODEX_SETTINGS: settingsFile
          }
        }
      }
    };
    const mcpConfig = path.join(sessionDir, "fusion-mcp.json");
    fs.writeFileSync(mcpConfig, `${JSON.stringify(mcpConfigObj, null, 2)}\n`);

    return { systemPromptFile, mcpConfig, settingsFile };
  }

  function releaseSession(sessionId) {
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId) {
      return;
    }

    fusionAdapterControls.delete(normalizedSessionId);
    fusionAdapterModes.delete(normalizedSessionId);
    const session = sessions.get(normalizedSessionId);
    sessions.delete(normalizedSessionId);
    if (session) {
      safeRemoveDir(session.dir, runDir);
    }
  }

  function postFusionAdapterControl(sessionId, pathName, payload = {}) {
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId) {
      return Promise.resolve({ status: "skipped", reason: "invalid_session" });
    }
    const controlUrl = fusionAdapterControls.get(normalizedSessionId);
    if (!controlUrl) {
      return Promise.resolve({ status: "skipped", reason: "adapter_not_ready" });
    }
    return new Promise((resolve) => {
      let url;
      try {
        url = new URL(`${controlUrl}${pathName}`);
        if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") {
          resolve({ status: "skipped", reason: "invalid_adapter_url" });
          return;
        }
      } catch (error) {
        resolve({ status: "skipped", reason: error.message });
        return;
      }

      const body = JSON.stringify({
        sessionId: normalizedSessionId,
        ...payload
      });
      const request = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: "POST",
          timeout: 1000,
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
            "x-vibe-telemetry-token": token
          }
        },
        (response) => {
          let responseBody = "";
          response.on("data", (chunk) => {
            responseBody += chunk.toString("utf8");
          });
          response.on("end", () => {
            try {
              const parsed = JSON.parse(responseBody || "{}");
              resolve(parsed && typeof parsed === "object" ? parsed : { status: "ok" });
            } catch {
              resolve({ status: response.statusCode && response.statusCode >= 400 ? "failed" : "ok" });
            }
          });
        }
      );
      request.on("error", (error) => resolve({ status: "failed", error: error.message }));
      request.on("timeout", () => {
        request.destroy();
        resolve({ status: "failed", error: "adapter control timed out" });
      });
      request.end(body);
    });
  }

  function steerFusionSession(sessionId, text) {
    return postFusionAdapterControl(sessionId, "/steer", { text });
  }

  function setFusionSessionMode(sessionId, mode) {
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId) {
      return Promise.resolve({ status: "skipped", reason: "invalid_session" });
    }
    const runMode = normalizeFusionRunMode(mode);
    const previousMode = fusionAdapterModes.get(normalizedSessionId);
    fusionAdapterModes.set(normalizedSessionId, runMode);
    try {
      writeFusionRunModeFile(normalizedSessionId, runMode);
    } catch (error) {
      if (previousMode) {
        fusionAdapterModes.set(normalizedSessionId, previousMode);
      } else {
        fusionAdapterModes.delete(normalizedSessionId);
      }
      return Promise.resolve({ status: "failed", error: error.message || "could not write Fusion mode" });
    }
    return postFusionAdapterControl(normalizedSessionId, "/mode", { mode: runMode }).then(
      (result) => {
        if (result && result.status === "failed" && previousMode) {
          // The mode file is what the adapter re-reads per tool call, so a
          // failed control POST must not leave it ahead of what the renderer
          // committed (it keeps the old mode on ok:false).
          try {
            fusionAdapterModes.set(normalizedSessionId, previousMode);
            writeFusionRunModeFile(normalizedSessionId, previousMode);
          } catch {
            // keep the failed result; the next successful set-mode rewrites it
          }
        }
        return result;
      }
    );
  }

  function interruptFusionSession(sessionId) {
    return postFusionAdapterControl(sessionId, "/interrupt");
  }

  function stopFusionSession(sessionId) {
    return postFusionAdapterControl(sessionId, "/stop");
  }

  // Cursor has no per-invocation hook flag, so its hooks are registered in the
  // project's `.cursor/hooks.json`: `beforeSubmitPrompt` -> running and `stop` ->
  // completed/failed. This runs at launch (the cwd is known then) to merge our
  // env-guarded entries in, refreshing the per-run notify path. Best-effort and
  // idempotent; never throws so it cannot break a terminal launch. The user's own
  // Cursor hooks are preserved.
  async function ensureCursorProjectHooks(cwd) {
    try {
      await ready;
      if (!cwd || typeof cwd !== "string") {
        return;
      }

      let stat = null;
      try {
        stat = fs.statSync(cwd);
      } catch {
        return;
      }
      if (!stat.isDirectory()) {
        return;
      }

      const dir = path.join(cwd, ".cursor");
      const file = path.join(dir, "hooks.json");

      let raw = null;
      try {
        raw = fs.readFileSync(file, "utf8");
      } catch {
        raw = null;
      }

      let existing = null;
      if (raw !== null) {
        try {
          existing = JSON.parse(raw);
        } catch {
          // The file exists but is not valid JSON. Do not clobber it — the user
          // may be mid-edit or using a format we do not understand.
          return;
        }
      }

      const merged = mergeCursorHooks(
        existing,
        cursorHookEntries(cursorNotifyProgramPath, isWin)
      );
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`);
      if (!cursorHookFiles.has(file)) {
        cursorHookFiles.set(file, { createdByUs: raw === null });
      }
    } catch {
      // Best-effort; never let cursor hook install break a terminal launch.
    }
  }

  function cleanupCursorHooks() {
    for (const [file, info] of cursorHookFiles) {
      try {
        const raw = fs.readFileSync(file, "utf8");
        const parsed = JSON.parse(raw);
        const { trimmed, hasOtherContent } = stripCursorHooks(parsed);
        if (info.createdByUs && !hasOtherContent) {
          // We created this file purely for our hook; remove it (and the
          // .cursor dir if it is now empty) rather than leave a dangling entry.
          fs.rmSync(file, { force: true });
          const dir = path.dirname(file);
          try {
            if (fs.readdirSync(dir).length === 0) {
              fs.rmdirSync(dir);
            }
          } catch {
            // Directory not empty or unreadable — leave it.
          }
        } else {
          fs.writeFileSync(file, `${JSON.stringify(trimmed, null, 2)}\n`);
        }
      } catch {
        // File gone, unreadable, or malformed — nothing safe to do.
      }
    }
    cursorHookFiles.clear();
  }

  function cleanup() {
    for (const sessionId of Array.from(sessions.keys())) {
      releaseSession(sessionId);
    }
    cleanupCursorHooks();
    if (server) {
      server.close();
      server = null;
    }
    safeRemoveDir(runDir, baseDir);
  }

  return {
    baseDir,
    openFusionBaseDir,
    callbackUrl: () => callbackUrl,
    cleanup,
    ensureCursorProjectHooks,
    // Sync on purpose: thread-discovery lookups need the app-owned OpenCode
    // home paths without awaiting the telemetry bootstrap.
    getOpenFusionOpencodeHome: () => ensureOpenFusionOpencodeHome(openFusionBaseDir),
    prepareSession,
    prepareOpenFusionFiles,
    prepareFusionFiles,
    updateFusionSettings,
    updateOpenFusionModels,
    ready,
    releaseSession,
    steerFusionSession,
    interruptFusionSession,
    setFusionSessionMode,
    stopFusionSession,
    runDir,
    runId,
    token
  };
}

module.exports = {
  buildClaudeSettingsJson,
  buildFusionSystemPrompt,
  ensureOpenFusionOpencodeHome,
  migrateOpenFusionThreadsFromGlobal,
  openFusionCommandContents,
  openFusionConfigContents,
  openFusionExecutorPrompt,
  openFusionInvestigatorPrompt,
  openFusionOpencodeHomePaths,
  openFusionPlannerPrompt,
  openFusionTuiPluginSource,
  openFusionTheme,
  cleanupStaleOpenFusionDirs,
  cleanupStaleShimDirs,
  createAgentTelemetryManager,
  cursorHookEntries,
  cursorNotifyHookSource,
  cursorTypeFromStatus,
  installOpenCodePlugin,
  mapTelemetryToAttention,
  mergeCursorHooks,
  notifyHookSource,
  openCodePluginSource,
  safeRemoveDir,
  stripCursorHooks
};
