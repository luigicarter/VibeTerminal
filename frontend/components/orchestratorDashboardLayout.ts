import type { RelaySession } from "../orchestratorUi";
import { runtimeStatusLabel, type TerminalRuntimeSnapshot } from "../terminalRuntime";

export type DashboardStatus = "working" | "done" | "needs-you" | "idle" | "error" | "unknown" | "starting" | "pending" | "response";
export interface DashboardTarget { id: string; generation: string; operations?: string[] }
export const DASHBOARD_DRIFT_PX = 3;
type UsedSession = { id: string; lastUsedAt?: number };
const usedAt = (session: UsedSession) => Number.isFinite(session.lastUsedAt) && session.lastUsedAt! > 0 ? session.lastUsedAt! : 0;

/** Freeze this order for one visit; changing activity never moves existing cells. */
export function dashboardSessionOrder(previous: readonly string[] | null, sessions: readonly UsedSession[]): string[] {
  if (!previous?.length) return [...sessions].sort((a, b) => usedAt(b) - usedAt(a)).map(session => session.id);
  const known = new Set(previous);
  const added = sessions.filter(session => !known.has(session.id)).map(session => session.id);
  return added.length ? [...previous, ...added] : previous as string[];
}

export function dashboardRecency(session: UsedSession, now: number, active: boolean) {
  const timestamp = usedAt(session);
  const recent = timestamp > 0 && timestamp <= now && now - timestamp <= 24 * 60 * 60 * 1000;
  return { recent, opacity: active || recent ? 1 : timestamp ? 0.90 : 0.96 };
}

export function dashboardDrift(id: string) {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619) >>> 0;
  return { duration: 8 + hash % 4001 / 1000, delay: -(hash % 10000) / 1000, distance: DASHBOARD_DRIFT_PX };
}
export const DASHBOARD_STATUS_LABELS: Record<DashboardStatus, string> = {
  working: "Working", done: "Done", "needs-you": "Needs you", idle: "Idle", error: "Error", unknown: "Unknown",
  starting: "Starting", pending: "Awaiting activity", response: "Response available"
};

/** Runtime observations own status; renderer metadata must describe the exact revision. */
export function dashboardSessionMetadata(session: RelaySession, metadata?: RelaySession): RelaySession {
  const sameRevision = metadata?.generation === session.generation && metadata?.revision === session.revision && session.revision !== undefined;
  const runtime = session as RelaySession & Partial<TerminalRuntimeSnapshot>;
  const nativeLabel = runtime.turnState && runtime.provider && Array.isArray(runtime.children)
    ? runtimeStatusLabel(runtime as TerminalRuntimeSnapshot) : undefined;
  return { ...session, projectName: metadata?.projectName || session.projectName,
    statusLabel: nativeLabel || session.statusLabel || (sameRevision ? metadata?.statusLabel : undefined) };
}

// A missing observation is not evidence of either work or idleness.
export function dashboardStatus(session: RelaySession): DashboardStatus {
  const value = (session.statusLabel || session.status).trim().toLowerCase();
  if (["working", "running"].includes(value)) return "working";
  if (["done", "completed"].includes(value)) return "done";
  if (["waiting", "needs input", "needs you"].includes(value)) return "needs-you";
  if (["idle", "terminal open", "interrupted"].includes(value)) return "idle";
  if (["failed", "error", "agent failed"].includes(value)) return "error";
  if (value === "starting") return "starting";
  if (["awaiting activity", "interrupt requested"].includes(value)) return "pending";
  if (["response", "response available"].includes(value)) return "response";
  return "unknown";
}

export function dashboardSessionVisible(session: RelaySession & { processState?: string; agentProcessState?: string }): boolean {
  if (!session.generation || session.generation.startsWith("paused:")) return false;
  if (session.started === false || ["exited", "failed"].includes(session.processState || "")) return false;
  if (session.kind !== "terminal" && ["exited", "failed"].includes(session.agentProcessState || "")) return false;
  const hidden = ["paused", "not started", "not-started"];
  return !hidden.includes(session.status.toLowerCase()) && !hidden.includes((session.statusLabel || "").toLowerCase());
}

export function dashboardTargeted(session: RelaySession, targets: readonly DashboardTarget[]): boolean {
  return Boolean(session.generation && targets.some(target => target.id === session.id && target.generation === session.generation));
}

export function dashboardSessionTitle(session: RelaySession): string {
  return session.conversationTitle?.trim() || session.name.trim() || session.threadRef?.title?.trim() || session.projectName?.trim() || session.cwd.split(/[\\/]/).filter(Boolean).pop() || "Untitled session";
}

export function dashboardProvider(session: RelaySession): string {
  if (session.openFusion) return "Open Fusion";
  if (session.fusion) return "Fusion";
  const labels: Record<string, string> = { terminal: "Shell", codex: "Codex", claude: "Claude", cursor: "Cursor", gemini: "Gemini", opencode: "OpenCode", kimi: "Kimi", "kimi-custom": "Kimi Custom", qwen: "Qwen", fusion: "Fusion", openfusion: "Open Fusion", "claude-custom": "Open Claude Code" };
  return labels[session.kind] || session.kind || "Agent";
}

/** Reserve every cell for the largest circle and its halo, independent of status. */
export function dashboardLayout(viewportWidth: number, count: number) {
  const available = Math.max(0, Number.isFinite(viewportWidth) ? viewportWidth : 0);
  const diameter = Math.min(280, Math.max(220, available - 56));
  // A 12px visual halo plus the worst diagonal drift (sqrt(3²+3²) < 6px).
  const motionMargin = 6;
  const halo = 12 + motionMargin;
  const gap = 24;
  const slot = diameter + halo * 2;
  // Hexagonal rows plus bounded offsets make a cloud without a physics loop.
  // Extra pitch reserves the full jitter even when every target expands.
  const jitter = 8;
  const pitch = slot + gap + 24;
  const columns = Math.max(1, Math.min(Math.max(1, count), Math.floor((available + gap + 8) / pitch)));
  const rowStep = columns > 1 ? pitch * Math.sqrt(3) / 2 : pitch;
  const positions: { x: number; y: number }[] = [];
  let row = 0;
  while (positions.length < count) {
    const capacity = columns > 1 && row % 2 ? columns - 1 : columns;
    // Fill from the middle so a partially filled row stays balanced. Appending
    // sessions does not move existing centers within this column count.
    const slots = Array.from({ length: capacity }, (_, i) => i).sort((a, b) => Math.abs(a - (capacity - 1) / 2) - Math.abs(b - (capacity - 1) / 2));
    for (const column of slots) {
      if (positions.length >= count) break;
      const index = positions.length;
      const dx = Math.sin(index * 2.4) * jitter;
      const dy = Math.cos(index * 1.7) * jitter;
      positions.push({ x: jitter + column * pitch + (columns - capacity) * pitch / 2 + dx,
        y: jitter + row * rowStep + dy });
    }
    row++;
  }
  return { diameter, halo, motionMargin, gap, slot, columns, rows: row, positions,
    width: (columns - 1) * pitch + slot + jitter * 2, height: row ? (row - 1) * rowStep + slot + jitter * 2 : 0 };
}

export function dashboardScale(active: boolean, hasTargets: boolean): number {
  return active ? 1 : hasTargets ? 0.65 : 0.82;
}
