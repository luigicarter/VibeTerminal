import type { SessionStatus } from "./types";

export interface TerminalRuntimeSnapshot {
  id: string;
  generation: string;
  launchToken: number;
  revision: number;
  provider: string;
  cwd: string;
  processState: "starting" | "running" | "exited" | "failed";
  agentProcessState: "unknown" | "running" | "exited" | "failed";
  turnState: "unknown" | "idle" | "running" | "waiting" | "completed" | "failed" | "interrupted" | "response";
  observation: "observed" | "provisional" | "unavailable";
  telemetryHealth: "pending" | "available" | "unavailable";
  conversation?: { provider: string; id?: string; title?: string; titleSource?: "named" | "generated" | "preview"; createdAt: number; updatedAt: number };
  terminalTitle?: string;
  turnId?: string;
  pendingInput?: "submit" | "interrupt";
  pendingInputAt?: number;
  turnStartedAt?: number;
  turnEndedAt?: number;
  updatedAt: number;
  lastTool?: { id: string; name: string; startedAt: number; endedAt?: number };
  activeTools: Array<{ id: string; name: string; startedAt: number }>;
  children: Array<{ id: string; label?: string; startedAt: number }>;
  childActivity: boolean;
  attention?: { id: string; state: "waiting" | "completed" | "failed"; reason?: string; updatedAt: number };
  binding: { status: "pending" | "found" | "ambiguous" | "unavailable"; message?: string };
  capabilities?: object;
}

// Shared projection keeps pane, sidebar, and project summaries consistent.
export function runtimeSessionStatus(runtime: TerminalRuntimeSnapshot): SessionStatus {
  if (runtime.processState === "failed") return "failed";
  if (runtime.processState === "exited") return "idle";
  if (runtime.processState === "starting") return "starting";
  if (runtime.provider !== "terminal") {
    if (runtime.agentProcessState === "failed") return "failed";
    if (runtime.agentProcessState === "exited") return "idle";
  }
  if (runtime.pendingInput) return "idle";
  if (runtime.telemetryHealth === "unavailable" || runtime.observation === "unavailable") return "idle";
  if (runtime.turnState === "waiting") return "waiting";
  if (runtime.children.length > 0 || runtime.childActivity) return "running";
  if (runtime.turnState === "running") return "running";
  if (runtime.turnState === "failed") return "failed";
  if (runtime.turnState === "completed" && runtime.observation === "observed") return "done";
  return "idle";
}

export function runtimeStatusLabel(runtime?: TerminalRuntimeSnapshot, started = true): string {
  if (!runtime) return started ? "observing" : "paused";
  if (runtime.processState === "failed") return "failed";
  if (runtime.processState === "exited") return "exited";
  if (runtime.processState === "starting") return "starting";
  if (runtime.provider !== "terminal") {
    if (runtime.agentProcessState === "failed") return "agent failed";
    if (runtime.agentProcessState === "exited") return "agent exited";
  }
  if (runtime.pendingInput === "submit") return "awaiting activity";
  if (runtime.pendingInput === "interrupt") return "interrupt requested";
  if (runtime.provider === "terminal") return "terminal open";
  if (runtime.telemetryHealth === "unavailable" || runtime.observation === "unavailable") return "unobserved";
  const status = runtimeSessionStatus(runtime);
  if (status === "running") return "working";
  if (status === "waiting") return "needs input";
  if (status === "failed") return "failed";
  if (status === "done") return "done";
  switch (runtime.turnState) {
    case "interrupted": return "interrupted";
    case "response": return "response available";
    case "completed": return "response available";
    case "idle": return "idle";
    default: return "observing";
  }
}

export function runtimeDisplayTitle(runtime: TerminalRuntimeSnapshot | undefined, fallback: string): string {
  return runtime?.conversation?.title?.trim() || runtime?.terminalTitle?.trim() || fallback;
}

export function runtimeTitleTooltip(runtime: TerminalRuntimeSnapshot | undefined, fallback: string): string {
  const title = runtimeDisplayTitle(runtime, fallback);
  const terminal = runtime?.terminalTitle?.trim();
  return terminal && terminal !== title ? `${title}\nTerminal: ${terminal}` : title;
}

export function runtimeElapsed(runtime: TerminalRuntimeSnapshot, now: number): string | undefined {
  if (runtime.pendingInput || runtime.turnStartedAt === undefined) return undefined;
  const processAlive = runtime.processState === "running" &&
    (runtime.provider === "terminal" || (runtime.agentProcessState !== "exited" && runtime.agentProcessState !== "failed"));
  const turnAlive = processAlive && (runtime.turnState === "running" || runtime.turnState === "waiting");
  const end = turnAlive ? now : runtime.turnEndedAt;
  if (end === undefined) return undefined;
  const seconds = Math.max(0, Math.floor((end - runtime.turnStartedAt) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
