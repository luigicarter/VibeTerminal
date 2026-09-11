"use strict";

// A renderer acknowledgment proves that a pane exists, not that its process
// exists. Wait for the requested launch, without retrying or changing targets.
function waitForSessionLaunch({ result, getSession, refresh = async () => {}, signal, timeoutMs = 20000, pollMs = 100 }) {
  const { target: _provisionalTarget, cwd: _provisionalCwd, name: _provisionalName, ...created } = result;
  return new Promise(resolve => {
    let settled = false, polling;
    const finish = value => {
      if (settled) return;
      settled = true; clearTimeout(deadline); clearTimeout(polling);
      signal?.removeEventListener("abort", abort);
      resolve({ ...created, sessionCreated: true, ...value });
    };
    const abort = () => finish({ ok: false, status: "cancelled", error: "The pane was created; waiting for its startup was cancelled. Creation was not retried." });
    const deadline = setTimeout(() => finish({ ok: false, status: "launch-timeout", error: "The pane was created, but terminal startup was not confirmed. Inspect it before retrying; no second terminal was created." }), timeoutMs);
    if (signal?.aborted) return abort();
    signal?.addEventListener("abort", abort, { once: true });
    let generation, seenSession = false;
    async function check() {
      if (settled) return;
      try {
        await refresh();
        if (settled) return;
        const session = getSession(result.id);
        if (!session && seenSession) return finish({ ok: false, status: "closed", error: "The terminal was closed before startup completed." });
        seenSession ||= Boolean(session);
        if (session?.started === false) return finish({ ok: false, status: "closed", error: "The terminal was stopped before startup completed." });
        if (session?.launchToken > result.launchToken ||
            (generation && session?.generation && !String(session.generation).startsWith("paused:") && session.generation !== generation)) {
          return finish({ ok: false, status: "superseded", error: "The terminal was restarted before startup was confirmed. No input was sent." });
        }
        if (session?.launchToken === result.launchToken && session.generation && !String(session.generation).startsWith("paused:")) {
          generation ||= session.generation;
          if (["failed", "exited"].includes(session.processState)) {
            return finish({ ok: false, status: "launch-failed", generation, error: session.binding?.message || "The terminal stopped before startup completed." });
          }
          if (session.processState === "running" && session.launchState !== "pending") {
            return finish({ ok: true, status: "created", processState: "running",
              ...(typeof session.cwd === "string" && session.cwd.trim() ? { cwd: session.cwd } : {}),
              ...(typeof session.name === "string" && session.name.trim() ? { name: session.name } : {}),
              target: { id: session.id, generation, launchToken: result.launchToken } });
          }
        }
      } catch (error) {
        return finish({ ok: false, status: "launch-unconfirmed", error: `The pane was created, but startup could not be confirmed: ${String(error?.message || error)}` });
      }
      if (!settled) polling = setTimeout(check, pollMs);
    }
    void check();
  });
}

module.exports = { waitForSessionLaunch };
