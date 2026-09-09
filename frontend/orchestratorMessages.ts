import type { RelayMessage } from "./orchestratorUi";

export type DisplayRelayMessage = RelayMessage & { relatedRequestIds?: string[] };
const terminalPrefix = "(?:[^\\r\\n]{1,120}: )?";
const legacyCompletion = new RegExp(`^${terminalPrefix}(?:the agent turn completed\\. The requested outcome is not independently verified\\.|the terminal is ready for input\\. This does not establish that any task was completed\\.)(?: All requested terminal turns have ended\\.)?$`, "i");
const legacyMissing = new RegExp(`^${terminalPrefix}The agent turn ended, but no reliable result details are available yet\\.$`, "i");

// This is a display projection only. Raw messages retain every request's
// evidence and ownership for history, context, and follow-up questions.
export function projectOrchestratorMessages(messages: readonly RelayMessage[]): DisplayRelayMessage[] {
  const display: DisplayRelayMessage[] = [];
  const results = new Map<string, DisplayRelayMessage>();
  for (const message of messages) {
    const automatic = message.role === "system" && ["task", "task-detail"].includes(message.origin || "");
    const positive = message.status === "completed" || message.status === "ready";
    if (automatic && message.origin === "task-detail" && (message.reportKind === "result-unavailable" || !message.reportKind && legacyMissing.test(message.text))) continue;
    if (automatic && message.status !== "failed") {
      if (message.origin === "task" && message.reportKind === "lifecycle" && positive) continue;
      if (!message.reportKind && (message.origin === "task" ? legacyCompletion : legacyMissing).test(message.text)) continue;
    }
    const hasGeneration = typeof message.generation === "string" ? message.generation.length > 0 :
      typeof message.generation === "number" && Number.isFinite(message.generation);
    const sharedResult = automatic && message.origin === "task-detail" && message.reportKind === "result" && positive &&
      message.targetId && hasGeneration && message.turnId;
    if (sharedResult) {
      const key = JSON.stringify([message.targetId, message.generation, message.turnId, message.reportKind]);
      const previous = results.get(key);
      if (previous) {
        if (message.requestId && !previous.relatedRequestIds!.includes(message.requestId)) previous.relatedRequestIds!.push(message.requestId);
        if (message.at >= previous.at) {
          previous.text = message.text;
          previous.at = message.at;
        }
        continue;
      }
      const projected = { ...message, relatedRequestIds: message.requestId ? [message.requestId] : [] };
      results.set(key, projected); display.push(projected);
    } else display.push(message);
  }
  return display;
}
