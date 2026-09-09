export interface CloseTarget { id: string; launchToken: number; generation?: string | number }
export interface CloseProcessResult {
  ok: boolean; operationId: string; process: string;
  launchSettled: boolean; error?: string;
}
interface CloseOptions {
  operationId: string;
  target: CloseTarget;
  current: () => CloseTarget | undefined;
  cancelLaunch: () => void;
  stop: () => Promise<CloseProcessResult>;
  // Must resolve only once the removal is committed, not when setState queues it.
  remove: () => void | Promise<void>;
}
export async function closeSessionOperation(options: CloseOptions) {
  const { operationId } = options;
  const target = { ...options.target };
  const pendingGeneration = target.generation === `paused:${target.id}:${target.launchToken}`;
  const evidence = { operationId, target, pane: "unknown", process: "unknown", launchSettled: false, verifiedAt: 0 };
  const finish = (error?: string) => {
    const ok = ["removed", "already-absent"].includes(evidence.pane) && ["stopped", "already-absent"].includes(evidence.process) && evidence.launchSettled;
    return { ok, status: ok ? "closed" : evidence.pane === "superseded" || evidence.process === "superseded" ? "superseded" : "close-partial", close: { ...evidence, verifiedAt: Date.now() }, ...(error && { error }) };
  };
  const current = options.current();
  if (current && (current.launchToken !== target.launchToken || target.generation !== undefined && !pendingGeneration && current.generation !== target.generation)) {
    evidence.pane = "superseded"; evidence.process = "superseded";
    return finish("The pane restarted; its replacement was preserved.");
  }
  options.cancelLaunch();
  let stopped: CloseProcessResult;
  try { stopped = await options.stop(); }
  catch (error) { stopped = { ok: false, operationId, process: "unknown", launchSettled: false, error: String(error) }; }
  if (stopped.operationId !== operationId) return finish("The stop acknowledgment belongs to another operation.");
  evidence.process = !stopped.ok && ["stopped", "already-absent"].includes(stopped.process) ? "unknown" : stopped.process;
  evidence.launchSettled = stopped.launchSettled;
  const latest = options.current();
  if (latest && (latest.launchToken !== target.launchToken || target.generation !== undefined && !pendingGeneration && latest.generation !== undefined && latest.generation !== `paused:${latest.id}:${latest.launchToken}` && latest.generation !== target.generation) || stopped.process === "superseded") {
    evidence.pane = "superseded";
    return finish(stopped.error || "The pane restarted; its replacement was preserved.");
  }
  if (!latest) evidence.pane = "already-absent";
  else {
    try { await options.remove(); }
    catch (error) { return finish(String(error)); }
    const remaining = options.current();
    evidence.pane = !remaining ? "removed" : remaining.launchToken !== target.launchToken ? "superseded" : "unknown";
  }
  return finish(stopped.error);
}
