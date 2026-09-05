import type { AgentKind, AgentSession, AgentThreadProvider } from "./types";
import type { TerminalRuntimeSnapshot } from "./terminalRuntime";

export const HISTORY_CONFIG_FIELDS = [
  "providerProfileId", "providerModelOverride", "fusionPlannerFamily", "fusionPlannerModel",
  "fusionPlannerEffort", "fusionPlannerFast", "fusionExecutorFamily", "fusionExecutorModel",
  "fusionExecutorEffort", "fusionExecutorFast", "fusionRunMode", "openFusionPlannerModel",
  "openFusionExecutorModel", "openFusionRunMode"
] as const;
export type SavedConversation = Partial<Pick<AgentSession, typeof HISTORY_CONFIG_FIELDS[number]>> & {
  reference: string; provider: AgentThreadProvider | "fusion" | "openfusion" | "claude-custom"; id: string; cwd: string; title?: string;
  plannerProvider?: "claude" | "codex";
  claudeHome?: "custom"; fusion?: boolean; openFusion?: boolean; createdAt?: number; updatedAt?: number;
};
function conversationFolder(cwd: string) {
  const slashPath = cwd.replace(/\\/g, "/");
  const prefix = slashPath.startsWith("//") ? "//" : slashPath.startsWith("/") ? "/" : "";
  const windows = /^(?:[a-z]:|\/\/)/i.test(slashPath);
  const floor = prefix === "//" ? 2 : windows ? 1 : 0;
  const parts: string[] = [];
  for (const part of slashPath.split("/")) {
    if (!part || part === ".") continue;
    if (part === ".." && parts.length > floor && parts.at(-1) !== "..") parts.pop();
    else if (part !== ".." || !prefix && !windows) parts.push(part);
  }
  const normalized = prefix + parts.join("/");
  return windows ? normalized.toLowerCase() : normalized;
}
export function conversationKey(value: Pick<SavedConversation, "provider" | "id" | "cwd" | "claudeHome" | "openFusion">) {
  return JSON.stringify([value.provider === "kimi-custom" ? "kimi" : value.provider, value.provider === "claude" ? value.claudeHome || "global" : value.provider === "opencode" && value.openFusion ? "openfusion" : "global", conversationFolder(value.cwd || ""), value.id]);
}
export function normalizeSavedConversation(value: SavedConversation): SavedConversation & { provider: AgentThreadProvider } {
  return { ...value,
    provider: value.provider === "fusion" ? value.plannerProvider || value.fusionPlannerFamily || "claude" : value.provider === "openfusion" ? "opencode" : value.provider === "claude-custom" ? "claude" : value.provider,
    fusion: value.provider === "fusion" || value.fusion,
    openFusion: value.provider === "openfusion" || value.openFusion,
    claudeHome: value.provider === "claude-custom" ? "custom" : value.claudeHome
  };
}
export function matchingConversation(sessions: AgentSession[], conversation: SavedConversation) {
  const key = conversationKey(normalizeSavedConversation(conversation));
  const matches = (session: AgentSession) => [session.threadRef, ...(!session.started ? [session.resumeRef] : [])].some(ref => ref?.id && conversationKey({
    provider: ref.provider, id: ref.id, cwd: session.cwd,
    claudeHome: session.providerProfileId ? "custom" : undefined, openFusion: session.openFusion
  }) === key);
  return sessions.find(session => session.started && matches(session)) || sessions.find(matches);
}
export function conversationNeedsResume(session: AgentSession, runtime?: TerminalRuntimeSnapshot) {
  if (!session.started) return true;
  if (session.fusion || session.openFusion || runtime?.launchToken !== session.launchToken) return false;
  return runtime.processState === "exited" || runtime.processState === "failed" || runtime.agentProcessState === "exited" || runtime.agentProcessState === "failed";
}
export function conversationLaunch(input: SavedConversation): { kind: AgentKind; patch: Partial<AgentSession> } {
  const conversation = normalizeSavedConversation(input);
  if (!conversation.id || !conversation.cwd || !["claude", "codex", "opencode", "cursor", "gemini", "kimi", "kimi-custom", "qwen"].includes(conversation.provider)) throw new Error("Saved conversation identity is incomplete.");
  if (conversation.claudeHome === "custom" && !conversation.providerProfileId) throw new Error("This saved chat's custom provider is unknown. Open it from a pane configured for the original provider.");
  if (conversation.fusion && !["claude", "codex"].includes(conversation.provider)) throw new Error("Unsupported Fusion planner identity.");
  if (conversation.openFusion && conversation.provider !== "opencode") throw new Error("Unsupported Open Fusion identity.");
  const config = Object.fromEntries(HISTORY_CONFIG_FIELDS.map(field => [field, conversation[field]]));
  const now = Date.now();
  return {
    kind: conversation.fusion ? "fusion" : conversation.openFusion ? "openfusion" : conversation.claudeHome === "custom" ? "claude-custom" : conversation.provider,
    patch: { ...config, fusion: conversation.fusion || undefined, openFusion: conversation.openFusion || undefined,
      ...(conversation.fusion ? { fusionPlannerFamily: conversation.provider as "claude" | "codex" } : {}),
      name: conversation.title || `${conversation.provider} saved chat`,
      nextLaunchMode: "resume", started: true, launchToken: 1, resumeRef: undefined,
      threadLookupStatus: "found", threadRef: { provider: conversation.provider, id: conversation.id, title: conversation.title,
        createdAt: conversation.createdAt || now, updatedAt: conversation.updatedAt || now }
    }
  };
}
