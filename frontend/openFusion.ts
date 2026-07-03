import type { OpenFusionModel } from "./types";

// Open Fusion ships with NO default models: assuming a vendor pair on pane
// open fails against the app-owned (initially empty) credential store and
// second-guesses the user. "" means "not chosen yet" — the pane gates the
// first turn on connecting a provider and picking Brain/Executor models.
export const DEFAULT_OPEN_FUSION_PLANNER_MODEL: OpenFusionModel = "";
export const DEFAULT_OPEN_FUSION_EXECUTOR_MODEL: OpenFusionModel = "";

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

// ---- custom OpenAI-compatible providers ----
// The user names the provider and its models; the provider id is derived from
// the display name so nobody has to invent a slug. Same-model-many-providers
// is the point: two custom providers can expose the same underlying model id
// and stay distinct picks (ids are namespaced `provider/model`).

const CUSTOM_PROVIDER_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,95}$/;
const MAX_CUSTOM_PROVIDER_NAME_LENGTH = 64;

export function validateCustomProviderName(value: string): string | null {
  const name = (value ?? "").trim();
  if (!name) return "Give the provider a name (e.g. 'My OpenRouter').";
  if (name.length > MAX_CUSTOM_PROVIDER_NAME_LENGTH) {
    return `Keep the name to ${MAX_CUSTOM_PROVIDER_NAME_LENGTH} characters or fewer.`;
  }
  return null;
}

export function validateCustomProviderBaseUrl(value: string): string | null {
  const raw = (value ?? "").trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "Enter a full base URL (e.g. https://api.example.com/v1).";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return "The base URL must start with https:// or http://.";
  }
  if (url.href.length > 200) {
    return "Keep the base URL to 200 characters or fewer.";
  }
  return null;
}

export function validateCustomProviderModelId(value: string): string | null {
  const id = (value ?? "").trim();
  if (!id) return "Enter the model id the endpoint expects (e.g. llama-3.3-70b).";
  if (!CUSTOM_PROVIDER_MODEL_ID_PATTERN.test(id)) {
    return "Model ids use letters, numbers, '.', '_', ':', '/', '@', '+', or '-'.";
  }
  return null;
}

// Optional context window for a custom model. Without it opencode stores 0 =
// unknown: requests still work (the endpoint enforces its real window), but
// auto-compaction is disabled and the token display shows no percentage.
// Accepts plain token counts plus k/m shorthand ("128k", "1m", "0.5m").
export const MIN_CUSTOM_MODEL_CONTEXT = 1_024;
export const MAX_CUSTOM_MODEL_CONTEXT = 100_000_000;

export function parseCustomProviderContextLimit(
  value: string
): { ok: true; limit?: number } | { ok: false; message: string } {
  const raw = (value ?? "").trim().replace(/[\s,_]/g, "");
  if (!raw) return { ok: true };
  const match = /^(\d+(?:\.\d+)?)([km])?$/i.exec(raw);
  if (!match) {
    return {
      ok: false,
      message: "Enter a token count like 128000, 128k, or 1m — or leave it empty to skip."
    };
  }
  const scale = match[2]?.toLowerCase() === "m" ? 1_000_000 : match[2] ? 1_000 : 1;
  const limit = Math.round(Number(match[1]) * scale);
  if (!Number.isFinite(limit) || limit < MIN_CUSTOM_MODEL_CONTEXT || limit > MAX_CUSTOM_MODEL_CONTEXT) {
    return {
      ok: false,
      message: `Context window must be between ${MIN_CUSTOM_MODEL_CONTEXT.toLocaleString()} and ${MAX_CUSTOM_MODEL_CONTEXT.toLocaleString()} tokens.`
    };
  }
  return { ok: true, limit };
}

// Derive the provider id from the display name. `reusableIds` are existing
// custom (config-sourced) providers — a matching slug means the user is
// redefining their own provider, so the id is reused. `takenIds` are all other
// known provider ids (catalog + connected): colliding with those would merge
// the definition into a catalog provider, so the slug gets a -custom suffix.
export function customProviderIdForName(
  name: string,
  takenIds: Iterable<string>,
  reusableIds: Iterable<string> = []
): string {
  const slug =
    (name ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[^a-z0-9]+|[^a-z0-9._-]+$/g, "")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "custom";
  const reusable = new Set([...reusableIds].map((id) => id.toLowerCase()));
  if (reusable.has(slug)) return slug;
  const taken = new Set([...takenIds].map((id) => id.toLowerCase()));
  if (!taken.has(slug)) return slug;
  let candidate = `${slug}-custom`;
  let counter = 2;
  while (taken.has(candidate) && !reusable.has(candidate)) {
    candidate = `${slug}-custom${counter}`;
    counter += 1;
  }
  return candidate;
}
