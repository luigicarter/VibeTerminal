import type { OpenFusionModel } from "./types";

export const DEFAULT_OPEN_FUSION_PLANNER_MODEL: OpenFusionModel =
  "anthropic/claude-sonnet-4-5";
export const DEFAULT_OPEN_FUSION_EXECUTOR_MODEL: OpenFusionModel =
  "opencode/gpt-5.1-codex";

const OPEN_FUSION_MODEL_ID_PATTERN = /^[A-Za-z0-9._:/@+-]+$/;
const MAX_OPEN_FUSION_MODEL_ID_LENGTH = 96;

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
