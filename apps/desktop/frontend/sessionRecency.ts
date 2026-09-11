// User interaction only: callers record explicit focus/input, never agent output.
export const RECENCY_STORAGE_KEY = "vibe-terminal.session-recency.v1";

const MAX_BYTES = 64 * 1024;
const MAX_SESSIONS = 200;
const CLOCK_SKEW_MS = 5_000;

function validId(id: string): boolean {
  return /^[a-zA-Z0-9_.:-]{1,128}$/.test(id) &&
    !["__proto__", "prototype", "constructor"].includes(id);
}

function validTime(value: unknown, now: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= now + CLOCK_SKEW_MS;
}

function recentEntries(value: unknown, now: number): Record<string, number> {
  const result: Record<string, number> = Object.create(null);
  if (!value || typeof value !== "object" || Array.isArray(value)) return result;
  const entries = Object.entries(value)
    .filter((entry): entry is [string, number] => validId(entry[0]) && validTime(entry[1], now))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_SESSIONS);
  for (const [id, at] of entries) result[id] = at;
  return result;
}

export function loadSessionRecency(
  storage: Pick<Storage, "getItem">,
  now = Date.now()
): Record<string, number> {
  try {
    if (!Number.isFinite(now) || now <= 0) return Object.create(null);
    const raw = storage.getItem(RECENCY_STORAGE_KEY);
    if (!raw || raw.length > MAX_BYTES || new TextEncoder().encode(raw).byteLength > MAX_BYTES) {
      return Object.create(null);
    }
    return recentEntries(JSON.parse(raw), now);
  } catch {
    return Object.create(null);
  }
}

export function recordSessionRecency(
  previous: Record<string, number>,
  id: string,
  now: number
): Record<string, number> {
  if (!validId(id) || !Number.isFinite(now) || now <= 0) return previous;
  const next = recentEntries(previous, now);
  next[id] = Math.max(next[id] || 0, now);
  return recentEntries(next, now);
}
