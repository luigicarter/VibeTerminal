import type { OpenFusionModel, OpenFusionSettings } from "./types";

export const DEFAULT_OPEN_FUSION_PLANNER_MODEL: OpenFusionModel =
  "anthropic/claude-sonnet-4-5";
export const DEFAULT_OPEN_FUSION_EXECUTOR_MODEL: OpenFusionModel =
  "opencode/gpt-5.1-codex";

const OPEN_FUSION_MODEL_ID_PATTERN = /^[A-Za-z0-9._:/@+-]+$/;
const MAX_OPEN_FUSION_MODEL_ID_LENGTH = 96;

type OpenFusionRole = "planner" | "executor";

export type OpenFusionSlashCommandResult =
  | {
      ok: true;
      settings: OpenFusionSettings;
      changed: boolean;
      message: string;
    }
  | {
      ok: false;
      error: string;
    };

export function validateOpenFusionModel(value: unknown) {
  const model = typeof value === "string" ? value.trim() : "";
  if (!model) {
    return "Model id is required.";
  }

  if (model.length > MAX_OPEN_FUSION_MODEL_ID_LENGTH) {
    return `Model id must be ${MAX_OPEN_FUSION_MODEL_ID_LENGTH} characters or fewer.`;
  }

  if (!OPEN_FUSION_MODEL_ID_PATTERN.test(model)) {
    return "Use a provider/model id with letters, numbers, '.', '_', ':', '/', '@', '+', or '-'.";
  }

  const lower = model.toLowerCase();
  if (lower === "auto" || lower === "default") {
    return "Pick an explicit model id.";
  }

  return null;
}

export function normalizeOpenFusionModel(
  value: unknown,
  fallback: OpenFusionModel
): OpenFusionModel {
  return validateOpenFusionModel(value) === null
    ? String(value).trim()
    : fallback;
}

function roleFromAlias(value: string): OpenFusionRole | null {
  const normalized = value.trim().toLowerCase();
  if (["brain", "planner", "primary", "plan"].includes(normalized)) {
    return "planner";
  }

  if (["body", "executor", "secondary", "exec", "coder", "code"].includes(normalized)) {
    return "executor";
  }

  return null;
}

function commandTokens(input: string) {
  return input.trim().split(/\s+/).filter(Boolean);
}

function applyModel(
  settings: OpenFusionSettings,
  role: OpenFusionRole,
  value: string
): OpenFusionSlashCommandResult | null {
  const error = validateOpenFusionModel(value);
  if (error) {
    return { ok: false, error };
  }

  const nextSettings =
    role === "planner"
      ? { ...settings, plannerModel: value.trim() }
      : { ...settings, executorModel: value.trim() };
  const changed =
    nextSettings.plannerModel !== settings.plannerModel ||
    nextSettings.executorModel !== settings.executorModel;
  const label = role === "planner" ? "Brain" : "Body";

  return {
    ok: true,
    settings: nextSettings,
    changed,
    message: changed ? `${label} model updated.` : `${label} model already selected.`
  };
}

function parseKeyValueModels(
  settings: OpenFusionSettings,
  tokens: string[]
): OpenFusionSlashCommandResult | null {
  if (tokens.length === 0 || !tokens.every((token) => token.includes("="))) {
    return null;
  }

  let nextSettings = { ...settings };
  for (const token of tokens) {
    const [rawKey, ...rawValueParts] = token.split("=");
    const role = roleFromAlias(rawKey || "");
    const value = rawValueParts.join("=").trim();
    if (!role) {
      return { ok: false, error: `Unknown Open Fusion role: ${rawKey}` };
    }

    const error = validateOpenFusionModel(value);
    if (error) {
      return { ok: false, error };
    }

    nextSettings =
      role === "planner"
        ? { ...nextSettings, plannerModel: value }
        : { ...nextSettings, executorModel: value };
  }

  const changed =
    nextSettings.plannerModel !== settings.plannerModel ||
    nextSettings.executorModel !== settings.executorModel;

  return {
    ok: true,
    settings: nextSettings,
    changed,
    message: changed ? "Open Fusion models updated." : "Open Fusion models already selected."
  };
}

export function parseOpenFusionSlashCommand(
  input: string,
  current: OpenFusionSettings,
  defaults: OpenFusionSettings = {
    plannerModel: DEFAULT_OPEN_FUSION_PLANNER_MODEL,
    executorModel: DEFAULT_OPEN_FUSION_EXECUTOR_MODEL
  }
): OpenFusionSlashCommandResult {
  const trimmed = input.trim();
  if (!trimmed) {
    return { ok: false, error: "Enter an Open Fusion slash command." };
  }

  if (!trimmed.startsWith("/")) {
    return { ok: false, error: "Open Fusion commands must start with '/'." };
  }

  const tokens = commandTokens(trimmed.slice(1));
  const root = (tokens.shift() || "").toLowerCase();
  const scoped = root === "openfusion" || root === "of";
  const command = scoped ? (tokens.shift() || "").toLowerCase() : root;

  if (!command || command === "help" || command === "?") {
    return {
      ok: false,
      error: "Use /brain <model>, /body <model>, /models <brain> <body>, /models brain=<model> body=<model>, /swap, or /reset."
    };
  }

  if (command === "reset" || command === "defaults") {
    const changed =
      current.plannerModel !== defaults.plannerModel ||
      current.executorModel !== defaults.executorModel;
    return {
      ok: true,
      settings: defaults,
      changed,
      message: changed ? "Open Fusion models reset." : "Open Fusion models already use defaults."
    };
  }

  if (command === "swap") {
    const settings = {
      plannerModel: current.executorModel,
      executorModel: current.plannerModel
    };
    const changed =
      settings.plannerModel !== current.plannerModel ||
      settings.executorModel !== current.executorModel;
    return {
      ok: true,
      settings,
      changed,
      message: changed ? "Brain and body models swapped." : "Brain and body already match."
    };
  }

  if (command === "models") {
    const keyValueResult = parseKeyValueModels(current, tokens);
    if (keyValueResult) {
      return keyValueResult;
    }

    if (tokens.length !== 2) {
      return {
        ok: false,
        error: "Use /models <brain-model> <body-model> or /models brain=<model> body=<model>."
      };
    }

    const plannerError = validateOpenFusionModel(tokens[0]);
    if (plannerError) {
      return { ok: false, error: plannerError };
    }

    const executorError = validateOpenFusionModel(tokens[1]);
    if (executorError) {
      return { ok: false, error: executorError };
    }

    const settings = {
      plannerModel: tokens[0],
      executorModel: tokens[1]
    };
    const changed =
      settings.plannerModel !== current.plannerModel ||
      settings.executorModel !== current.executorModel;
    return {
      ok: true,
      settings,
      changed,
      message: changed ? "Open Fusion models updated." : "Open Fusion models already selected."
    };
  }

  if (command === "model") {
    const role = roleFromAlias(tokens.shift() || "");
    if (!role) {
      return { ok: false, error: "Use /model brain <model> or /model body <model>." };
    }

    if (tokens.length !== 1) {
      return { ok: false, error: "Provide exactly one model id." };
    }

    const result = applyModel(current, role, tokens[0]);
    if (result) {
      return result;
    }
  }

  const role = roleFromAlias(command);
  if (role) {
    if (tokens.length !== 1) {
      return { ok: false, error: "Provide exactly one model id." };
    }

    const result = applyModel(current, role, tokens[0]);
    if (result) {
      return result;
    }
  }

  return { ok: false, error: `Unknown Open Fusion command: /${root}` };
}
