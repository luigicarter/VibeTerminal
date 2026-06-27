import type {
  AgentKind,
  AgentLaunchMode,
  AgentSession,
  AgentThreadProvider,
  AgentThreadRef
} from "./types";

const THREADED_AGENT_KINDS: AgentThreadProvider[] = [
  "codex",
  "claude",
  "opencode"
];

export function isThreadedAgentKind(
  kind: AgentKind
): kind is AgentThreadProvider {
  return THREADED_AGENT_KINDS.includes(kind as AgentThreadProvider);
}

export function createUuid() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }

  const bytes = new Uint8Array(16);
  globalThis.crypto?.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10, 16).join("")
  ].join("-");
}

export function createThreadRef(
  kind: AgentKind,
  title: string,
  now = Date.now()
): AgentThreadRef | undefined {
  if (!isThreadedAgentKind(kind)) {
    return undefined;
  }

  return {
    provider: kind,
    id: kind === "claude" ? createUuid() : undefined,
    title,
    createdAt: now,
    updatedAt: now
  };
}

export function defaultLaunchMode(
  kind: AgentKind,
  launchToken: number
): AgentLaunchMode {
  return isThreadedAgentKind(kind) && launchToken > 0 ? "resume" : "new";
}

function commandArg(value: string) {
  if (/^[A-Za-z0-9_./:@-]+$/.test(value)) {
    return value;
  }

  return `"${value.replace(/["\\]/g, "\\$&")}"`;
}

function resumeArg(session: AgentSession) {
  return session.threadRef?.id || "";
}

export function buildLaunchCommand(session: AgentSession) {
  const mode = session.nextLaunchMode ?? "new";

  if (session.kind === "codex") {
    if (mode === "resume") {
      const ref = resumeArg(session);
      if (ref) {
        return `codex resume ${commandArg(ref)}`;
      }
    }

    return session.command.trim() || "codex";
  }

  if (session.kind === "claude") {
    if (mode === "resume") {
      const ref = resumeArg(session);
      if (ref) {
        return `claude --resume ${commandArg(ref)}`;
      }
    }

    const title = session.threadRef?.title || session.name;
    const namePart = title ? ` --name ${commandArg(title)}` : "";
    const idPart = session.threadRef?.id
      ? ` --session-id ${commandArg(session.threadRef.id)}`
      : "";
    return `claude${idPart}${namePart}`;
  }

  if (session.kind === "opencode") {
    if (mode === "resume") {
      const ref = resumeArg(session);
      if (ref) {
        return `opencode --session ${commandArg(ref)}`;
      }
    }

    return session.command.trim() || "opencode";
  }

  return session.command.trim();
}
