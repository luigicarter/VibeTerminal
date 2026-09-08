import { buildLaunchCommand } from "./sessionLaunch";
import type { AgentSession, TerminalLaunchPayload } from "./types";

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
}

// Process intent belongs to the workspace, not the currently mounted xterm.
// One launch token is one attempt, including failures: retry requires Restart.
// Resume confirmation and in-flight cancellation remain generation-scoped in
// the backend. The microtask fence also cancels intent removed before dispatch.
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
          const result = await options.create({
            id: session.id,
            cwd: session.cwd,
            provider: session.kind,
            threadRef: session.threadRef,
            command: buildLaunchCommand(session, { platform: options.platform }),
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
