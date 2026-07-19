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
  "opencode",
  "cursor",
  "kimi",
  "kimi-custom"
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

// A fresh ref carries no title: threadRef.title holds only the provider's own
// (generated or user-chosen) session title, harvested from local metadata once
// the conversation exists — never the pane's placeholder label.
export function createThreadRef(
  kind: AgentKind,
  now = Date.now()
): AgentThreadRef | undefined {
  if (!isThreadedAgentKind(kind)) {
    return undefined;
  }

  return {
    provider: kind,
    id: kind === "claude" ? createUuid() : undefined,
    createdAt: now,
    updatedAt: now
  };
}

export function defaultLaunchMode(
  kind: AgentKind,
  launchToken: number,
  hasThreadId: boolean
): AgentLaunchMode {
  return isThreadedAgentKind(kind) && launchToken > 0 && hasThreadId
    ? "resume"
    : "new";
}

function commandArg(value: string, platform?: string) {
  if (/^[A-Za-z0-9_./:@-]+$/.test(value)) {
    return value;
  }

  // The command is typed into an interactive shell, so single-quote wrapping is
  // the safest encoding: single quotes are literal in both PowerShell and POSIX
  // shells (no variable or backtick expansion). Only the embedded-quote escape
  // differs. PowerShell treats the ASCII apostrophe AND the typographic single
  // quotes (U+2018/U+2019/U+201A/U+201B — common from autocorrect or paste) as
  // string delimiters, so each must be doubled or it would prematurely terminate
  // the argument and break (or inject into) the launch line. POSIX shells only
  // treat the ASCII apostrophe specially, closing/escaping/reopening it.
  const escaped =
    platform === "win32"
      ? value.replace(/['‘’‚‛]/g, (quote) => `${quote}${quote}`)
      : value.replace(/'/g, "'\\''");
  return `'${escaped}'`;
}

function resumeArg(session: AgentSession) {
  return session.threadRef?.id || "";
}

export interface LaunchCommandOptions {
  // Override the session's nextLaunchMode (used by the self-healing launcher to
  // fall back to a fresh launch when a resume id is not actually resumable).
  mode?: AgentLaunchMode;
  // Target shell platform for argument quoting (defaults to POSIX quoting).
  platform?: string;
}

export function buildLaunchCommand(
  session: AgentSession,
  options: LaunchCommandOptions = {}
) {
  const mode = options.mode ?? session.nextLaunchMode ?? "new";
  const { platform } = options;

  if (session.kind === "codex") {
    if (mode === "resume") {
      const ref = resumeArg(session);
      if (ref) {
        return `codex resume ${commandArg(ref, platform)}`;
      }
    }

    return session.command.trim() || "codex";
  }

  if (session.kind === "claude") {
    if (mode === "resume") {
      const ref = resumeArg(session);
      if (ref) {
        return `claude --resume ${commandArg(ref, platform)}`;
      }
    }

    // Never pass --name: it stamps the pane's placeholder label ("Claude 2")
    // onto the session, which overrides the title Claude generates from the
    // first prompt in its own /resume picker. The pane harvests that generated
    // title back from the transcript instead (TerminalPane title refresh).
    const idPart = session.threadRef?.id
      ? ` --session-id ${commandArg(session.threadRef.id, platform)}`
      : "";
    return `claude${idPart}`;
  }

  if (session.kind === "opencode") {
    const openFusionAgentArg = session.openFusion ? " --agent planner" : "";
    if (mode === "resume") {
      const ref = resumeArg(session);
      if (ref) {
        return `opencode --session ${commandArg(ref, platform)}${openFusionAgentArg}`;
      }
    }

    const command = session.command.trim() || "opencode";
    return `${command}${openFusionAgentArg}`;
  }

  if (session.kind === "cursor") {
    if (mode === "resume") {
      const ref = resumeArg(session);
      if (ref) {
        return `cursor-agent --resume ${commandArg(ref, platform)}`;
      }
    }

    return session.command.trim() || "cursor-agent";
  }

  if (session.kind === "kimi") {
    if (mode === "resume") {
      const ref = resumeArg(session);
      if (ref) {
        return `kimi --session ${commandArg(ref, platform)}`;
      }
    }

    return session.command.trim() || "kimi";
  }

  if (session.kind === "kimi-custom") {
    if (mode === "resume") {
      const ref = resumeArg(session);
      if (ref) {
        return `kimi-custom --session ${commandArg(ref, platform)}`;
      }
    }

    return session.command.trim() || "kimi-custom";
  }

  return session.command.trim();
}
