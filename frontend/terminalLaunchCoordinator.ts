import { buildLaunchCommand, isThreadedAgentKind } from "./sessionLaunch";
import type { AgentSession, AgentThreadLookupPayload, AgentThreadLookupResult, TerminalLaunchPayload } from "./types";

type LaunchResult = boolean | {
  ok?: boolean;
  cancelled?: boolean;
  error?: string;
};

interface LaunchEntry {
  session: AgentSession;
  cancelled: boolean;
}

interface LaunchCoordinatorOptions {
  platform?: string;
  create: (payload: TerminalLaunchPayload) => Promise<LaunchResult>;
  isCurrent: (session: AgentSession) => boolean;
  onError: (session: AgentSession, message: string) => void;
  confirmThread?: (payload: AgentThreadLookupPayload) => Promise<AgentThreadLookupResult>;
  onFreshLaunchFallback?: (session: AgentSession, freshSession: AgentSession) => void;
}

// Process intent belongs to the workspace, not the currently mounted xterm.
// One launch token is one attempt, including failures: retry requires Restart.
// Confirm saved conversations before admission, with cancellation fences around
// the asynchronous lookup. The backend owns generation-scoped process creation.
export function createTerminalLaunchCoordinator(options: LaunchCoordinatorOptions) {
  const launches = new Map<string, LaunchEntry>();
  let active = true;
  const current = (entry: LaunchEntry) => active && !entry.cancelled &&
    launches.get(entry.session.id) === entry && options.isCurrent(entry.session);

  return {
    reconcile(sessions: readonly AgentSession[]) {
      active = true;
      const eligible = new Map(sessions.filter(session =>
        session.started && !session.fusion && !session.openFusion
      ).map(session => [session.id, session]));
      for (const [id, entry] of launches) {
        if (eligible.get(id)?.launchToken !== entry.session.launchToken) {
          entry.cancelled = true;
          launches.delete(id);
        }
      }
      for (const session of eligible.values()) {
        if (launches.has(session.id)) continue;
        const entry: LaunchEntry = { session, cancelled: false };
        launches.set(session.id, entry);
        void Promise.resolve().then(async () => {
          if (!current(entry)) return;
          let launchSession = session;
          if (options.confirmThread && isThreadedAgentKind(session.kind) &&
              session.nextLaunchMode === "resume" && session.threadRef?.id) {
            let confirmation: AgentThreadLookupResult | undefined;
            try {
              confirmation = await options.confirmThread({
                provider: session.kind, cwd: session.cwd, confirmId: session.threadRef.id,
                claudeHome: session.providerProfileId ? "custom" : undefined
              });
            } catch {
              // An unavailable lookup cannot establish that saved history is
              // gone. Attempt the exact resume rather than discard its identity.
            }
            if (!current(entry)) return;
            if (confirmation?.status === "missing") {
              launchSession = {
                ...session, nextLaunchMode: "new",
                threadRef: session.kind === "claude" ? session.threadRef : undefined,
                threadLookupStartedAt: undefined,
                threadLookupStatus: "pending",
                threadLookupMessage: "Saved conversation is no longer available. Started a new chat."
              };
              options.onFreshLaunchFallback?.(session, launchSession);
            }
          }
          if (!current(entry)) return;
          const result = await options.create({
            id: session.id,
            cwd: session.cwd,
            provider: session.kind,
            threadRef: launchSession.threadRef,
            command: buildLaunchCommand(launchSession, { platform: options.platform }),
            launchToken: session.launchToken,
            providerProfileId: session.providerProfileId,
            providerModelOverride: session.providerModelOverride
          });
          if (!current(entry) || (typeof result === "object" && result.cancelled)) return;
          if (result === false || (typeof result === "object" && result.ok === false)) {
            options.onError(session, typeof result === "object" && result.error || "Terminal could not be started. Use Restart to retry.");
          }
        }).catch(error => {
          if (current(entry)) options.onError(session, error instanceof Error ? error.message : String(error));
        });
      }
    },
    cancel(id: string, launchToken: number) {
      const entry = launches.get(id);
      if (entry?.session.launchToken === launchToken) entry.cancelled = true;
    },
    // React's development effect replay may immediately reactivate this same
    // coordinator; keep admitted tokens so it cannot create a second process.
    suspend() { active = false; }
  };
}
