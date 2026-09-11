export interface ProjectRemovalTarget { id: string; launchToken: number; generation?: string | number; kind?: string }
export interface ProjectRemovalSnapshot { id: string; path: string; targets: ProjectRemovalTarget[] }
interface CurrentProject { id: string; path: string; sessions: { id: string; launchToken: number }[] }
export interface ProjectRemovalResult { ok: boolean; status: string; projectId: string; path: string; filesDeleted: false; receipts: { id: string; ok: boolean; error?: string }[]; error?: string; text?: string }
const pathKey = (value: string) => { const normalized = value.replace(/\\/g, "/").replace(/\/+$/, ""); return /^[a-z]:\//i.test(normalized) || normalized.startsWith("//") ? normalized.toLowerCase() : normalized; };
const samePath = (a: string, b: string) => pathKey(a) === pathKey(b);

// Workspace ownership only. There is deliberately no filesystem/delete adapter.
export async function removeProjectOperation({ snapshot, current, close, remove }: {
  snapshot: ProjectRemovalSnapshot;
  current(): CurrentProject | undefined;
  close(target: ProjectRemovalTarget): Promise<{ ok: boolean; error?: string }>;
  remove(): void;
}): Promise<ProjectRemovalResult> {
  const receipts: { id: string; ok: boolean; error?: string }[] = [];
  const failure = (error: string): ProjectRemovalResult => ({ ok: false, status: "project-retained", projectId: snapshot.id, path: snapshot.path, filesDeleted: false, receipts, error });
  const matches = () => {
    const project = current();
    return project && project.id === snapshot.id && samePath(project.path, snapshot.path) &&
      project.sessions.every(session => snapshot.targets.some(target => target.id === session.id && target.launchToken === session.launchToken));
  };
  if (!matches()) return failure("The project or its terminals changed before removal.");
  for (const target of snapshot.targets) {
    if (!matches()) return failure("The project changed during removal; its remaining terminals were preserved.");
    let result;
    try { result = await close(target); }
    catch (error) { result = { ok: false, error: error instanceof Error ? error.message : 'The terminal stop could not be verified.' }; }
    receipts.push({ id: target.id, ...result });
    if (!result.ok) return failure(result.error || "A project terminal could not be verified as stopped.");
  }
  if (!matches() || current()!.sessions.length) return failure("The project still has terminals; it remains in Lina Terminal.");
  remove();
  if (current()) return failure("Project removal has not been committed.");
  return { ok: true, status: "project-removed", projectId: snapshot.id, path: snapshot.path, filesDeleted: false, receipts,
    text: "Removed the project from Lina Terminal. No files or folders were deleted." };
}

type RemovalOptions = Parameters<typeof removeProjectOperation>[0];
type ControllerOptions = Omit<RemovalOptions, "close"> & { close(target: ProjectRemovalTarget, operationId: string, observeOnly: boolean): Promise<{ ok: boolean; error?: string }> };
// Retains unfinished process ownership even after a failed close removed a pane.
// A retry observes the original operation; it cannot issue its stop twice.
export function createProjectRemovalController() {
  type TargetRecord = { target: ProjectRemovalTarget; operationId: string; close: ControllerOptions["close"]; attempted: boolean; result?: { ok: boolean; error?: string } };
  const projects = new Map<string, { targets: Map<string, TargetRecord>; running?: Promise<ProjectRemovalResult> }>();
  return { run(options: ControllerOptions): Promise<ProjectRemovalResult> {
    const key = JSON.stringify([options.snapshot.id, pathKey(options.snapshot.path)]);
    let project = projects.get(key);
    if (project?.running) return project.running;
    if (!project) { project = { targets: new Map() }; projects.set(key, project); }
    for (const target of options.snapshot.targets) {
      const targetKey = JSON.stringify([target.id, target.launchToken, target.generation]);
      if (!project.targets.has(targetKey)) project.targets.set(targetKey, { target: { ...target }, operationId: crypto.randomUUID(), close: options.close, attempted: false });
    }
    const owner = project;
    const work = removeProjectOperation({ ...options, snapshot: { ...options.snapshot, targets: [...owner.targets.values()].map(record => record.target) },
      close: async target => {
        const record = owner.targets.get(JSON.stringify([target.id, target.launchToken, target.generation]))!;
        if (record.result?.ok) return record.result;
        const observeOnly = record.attempted; record.attempted = true;
        record.result = await record.close(record.target, record.operationId, observeOnly);
        return record.result;
      },
    }).then(result => { if (result.ok) projects.delete(key); return result; }).finally(() => { owner.running = undefined; });
    owner.running = work;
    return work;
  } };
}
