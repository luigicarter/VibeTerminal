export interface WorkRecord {
  id: string;
  terminalId: string;
  generation: string;
  turnId: string;
  cwd: string;
  projectName: string;
  provider: string;
  terminalName: string;
  title: string;
  status: "completed" | "failed" | "interrupted";
  startedAt: number;
  completedAt: number;
  observedAt: number;
  summary: string;
  summarySource: "status" | "terminal-screen" | "chat-events";
  coverage: string;
}

export const workProjectKey = (cwd: string) => cwd.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
export function workProjects(records: readonly WorkRecord[]) {
  const projects = new Map<string, { key: string; name: string; cwd: string }>();
  for (const record of records) {
    const key = workProjectKey(record.cwd);
    if (!projects.has(key)) projects.set(key, { key, name: record.projectName || record.cwd, cwd: record.cwd });
  }
  return [...projects.values()].sort((a, b) => a.name.localeCompare(b.name) || a.cwd.localeCompare(b.cwd));
}
export function filterWorkHistory(records: readonly WorkRecord[], project: string, query = "") {
  const search = query.trim().toLowerCase();
  return records.filter(record => (!project || workProjectKey(record.cwd) === workProjectKey(project)) && (!search ||
    [record.title, record.terminalName, record.projectName, record.cwd, record.provider, record.summary, record.status].some(value => value.toLowerCase().includes(search))))
    .sort((a, b) => b.completedAt - a.completedAt || a.id.localeCompare(b.id));
}
