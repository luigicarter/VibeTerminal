import type { SessionStatus } from "./types";

export interface TerminalRuntimeSnapshot {
  id: string;
  generation: string;
  launchToken: number;
  revision: number;
  provider: string;
  cwd: string;
  processState: "starting" | "running" | "exited" | "failed";
  launchState?: "pending" | "ready";
  cols?: number;
  rows?: number;
  agentProcessState: "unknown" | "running" | "exited" | "failed";
  turnState: "unknown" | "idle" | "running" | "waiting" | "completed" | "failed" | "interrupted" | "response";
  observation: "observed" | "provisional" | "unavailable";
  activityObserved?: boolean;
  backgroundObservation?: { source: "kimi-task-metadata"; availability: "available" | "unavailable"; observedAt: number };
  telemetryHealth: "pending" | "available" | "unavailable";
  conversation?: { provider: string; id?: string; title?: string; titleSource?: "named" | "generated" | "preview"; createdAt: number; updatedAt: number };
  terminalTitle?: string;
  turnId?: string;
  pendingInput?: "submit" | "interrupt";
  pendingInputAt?: number;
  pendingTurnActivity?: { turnId: string; state: "running" | "waiting"; observedAt: number;
    attention?: { id: string; state: "waiting"; reason?: string; updatedAt: number } };
  turnStartedAt?: number;
  turnEndedAt?: number;
  updatedAt: number;
  lastTool?: { id: string; name: string; startedAt: number; endedAt?: number };
  activeTools: Array<{ id: string; name: string; startedAt: number }>;
  children: Array<{ id: string; label?: string; startedAt: number; observation?: "observed" | "provisional"; attention?: { id: string; state: "waiting"; reason?: string; updatedAt: number } }>;
  childActivity: boolean;
  coarseChildObservation?: "observed" | "provisional";
  attention?: { id: string; state: "waiting" | "completed" | "failed"; reason?: string; updatedAt: number };
  binding: { status: "pending" | "found" | "ambiguous" | "unavailable"; message?: string };
  capabilities?: object;
}

// Shared projection keeps pane, sidebar, and project summaries consistent.
function childActivityUnverified(runtime: TerminalRuntimeSnapshot, child: TerminalRuntimeSnapshot['children'][number]): boolean {
  return child.observation === "provisional" ||
    (runtime.backgroundObservation?.availability === "unavailable" && child.id.startsWith("background:"));
}

export function runtimeActiveChildCount(runtime: TerminalRuntimeSnapshot): number | undefined {
  const count = runtime.children.filter(child => !childActivityUnverified(runtime, child)).length;
  return count || (runtime.coarseChildObservation === "observed" ||
    (!runtime.children.length && runtime.childActivity && runtime.coarseChildObservation !== "provisional") ? 1 : undefined);
}

export function runtimeChildAttention(runtime: TerminalRuntimeSnapshot) {
  return runtime.children.find(child => !childActivityUnverified(runtime, child) && child.attention?.state === "waiting")?.attention;
}

export function runtimePendingTurnActivity(runtime: TerminalRuntimeSnapshot) {
  const activity = runtime.pendingTurnActivity;
  return runtime.pendingInput && activity && activity.turnId === runtime.turnId &&
    activity.observedAt > (runtime.pendingInputAt ?? Infinity) ? activity : undefined;
}

function retainedChildrenOnly(runtime: TerminalRuntimeSnapshot): boolean {
  const retained = runtime.children.some(child => childActivityUnverified(runtime, child)) || runtime.coarseChildObservation === "provisional";
  return retained && runtime.coarseChildObservation !== "observed" && runtime.children.every(child => childActivityUnverified(runtime, child));
}

function retainedActivityUnverified(runtime: TerminalRuntimeSnapshot): boolean {
  const rootActive = runtime.telemetryHealth !== "unavailable" && runtime.observation !== "unavailable" &&
    (runtime.turnState === "running" || runtime.turnState === "waiting");
  return retainedChildrenOnly(runtime) && !rootActive && runtime.activeTools.length === 0;
}

export function runtimeSessionStatus(runtime: TerminalRuntimeSnapshot): SessionStatus {
  if (runtime.processState === "failed") return "failed";
  if (runtime.processState === "exited") return "idle";
  if (runtime.processState === "starting" || runtime.launchState === "pending") return "starting";
  if (runtime.provider !== "terminal") {
    if (runtime.agentProcessState === "failed") return "failed";
    if (runtime.agentProcessState === "exited") return "idle";
  }
  const liveChildren = !retainedChildrenOnly(runtime) && (runtime.children.length > 0 || runtime.childActivity);
  const childObserved = liveChildren && (runtime.activityObserved === true ||
    (runtime.observation === "observed" && runtime.telemetryHealth !== "unavailable"));
  if (childObserved && runtimeChildAttention(runtime)) return "waiting";
  if (runtime.pendingInput) return runtimePendingTurnActivity(runtime)?.state || (childObserved ? "running" : "idle");
  if (retainedActivityUnverified(runtime)) return "idle";
  if (runtime.telemetryHealth === "unavailable" || runtime.observation === "unavailable") return runtime.activityObserved ? (liveChildren || runtime.activeTools.length > 0 ? "running" : "idle") : "idle";
  if (runtime.turnState === "waiting") return "waiting";
  if (runtime.activityObserved && runtime.activeTools.length > 0) return "running";
  if (liveChildren) return "running";
  if (runtime.turnState === "running") return "running";
  if (runtime.turnState === "failed") return "failed";
  if (runtime.turnState === "completed" && runtime.observation === "observed") return "done";
  return "idle";
}

export function runtimeStatusLabel(runtime?: TerminalRuntimeSnapshot, started = true): string {
  if (!runtime) return started ? "observing" : "paused";
  if (runtime.processState === "failed") return "failed";
  if (runtime.processState === "exited") return "exited";
  if (runtime.processState === "starting" || runtime.launchState === "pending") return "starting";
  if (runtime.provider !== "terminal") {
    if (runtime.agentProcessState === "failed") return "agent failed";
    if (runtime.agentProcessState === "exited") return "agent exited";
  }
  if (runtimeSessionStatus(runtime) === "waiting" && (runtime.pendingInput || runtime.children.some(child => child.attention?.state === "waiting"))) return "needs input";
  if (runtime.pendingInput && runtimeSessionStatus(runtime) === "running") return "working";
  if (runtime.pendingInput === "submit") return "awaiting activity";
  if (runtime.pendingInput === "interrupt") return "interrupt requested";
  if (runtime.provider === "terminal") return "terminal open";
  if (retainedActivityUnverified(runtime)) return "activity unverified";
  if (runtime.telemetryHealth === "unavailable" || runtime.observation === "unavailable") return runtimeSessionStatus(runtime) === "running" ? "working" : "unobserved";
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
  if ((runtime.pendingInput && !runtimePendingTurnActivity(runtime)) || runtime.turnStartedAt === undefined) return undefined;
  const processAlive = runtime.processState === "running" &&
    (runtime.provider === "terminal" || (runtime.agentProcessState !== "exited" && runtime.agentProcessState !== "failed"));
  const turnAlive = processAlive && (runtime.turnState === "running" || runtime.turnState === "waiting");
  const end = turnAlive ? now : runtime.turnEndedAt;
  if (end === undefined) return undefined;
  const seconds = Math.max(0, Math.floor((end - runtime.turnStartedAt) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
