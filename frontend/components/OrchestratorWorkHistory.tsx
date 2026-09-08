import { useMemo, useState } from "react";
import { filterWorkHistory, workProjects, type WorkRecord } from "./orchestratorWorkHistoryModel";
import "./orchestratorWorkHistory.css";

const providerNames: Record<string, string> = { codex: "Codex", claude: "Claude", gemini: "Gemini", opencode: "OpenCode", fusion: "Fusion", openfusion: "Open Fusion", cursor: "Cursor", kimi: "Kimi", qwen: "Qwen", grok: "Grok Build" };
const statusNames = { completed: "Turn completed", failed: "Failed", interrupted: "Interrupted" };

export function OrchestratorWorkHistory({ records, sessions, onOpenSession }: {
  records: WorkRecord[];
  sessions: { id: string; generation?: string }[];
  onOpenSession(id: string): void;
}) {
  const [project, setProject] = useState("");
  const [query, setQuery] = useState("");
  const projects = useMemo(() => workProjects(records), [records]);
  const selectedProject = projects.some(item => item.key === project) ? project : "";
  const rows = useMemo(() => filterWorkHistory(records, selectedProject, query), [records, selectedProject, query]);
  return <section className="orchestrator-work" aria-label="Work history">
    <div className="orchestrator-work-controls">
      <label>Project<select value={selectedProject} onChange={event => setProject(event.target.value)}>
        <option value="">All projects</option>
        {projects.map(item => <option key={item.key} value={item.key}>{item.name} — {item.cwd}</option>)}
      </select></label>
      <label>Search<input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Find work, terminal, or result" /></label>
      <span aria-live="polite">{rows.length} {rows.length === 1 ? "record" : "records"}</span>
    </div>
    <p className="orchestrator-work-note">Ask Vibe “What’s been done?” or choose a project here. Records stay after a terminal closes.</p>
    <div className="orchestrator-work-scroll">
      <table>
        <thead><tr><th scope="col">Work / terminal</th><th scope="col">Project</th><th scope="col">Status</th><th scope="col">Finished</th><th scope="col">Result evidence</th></tr></thead>
        <tbody>{rows.map(record => {
          const live = sessions.some(session => session.id === record.terminalId && session.generation === record.generation);
          return <tr key={record.id} data-work-status={record.status}>
            <td>{live ? <button className="orchestrator-work-open" onClick={() => onOpenSession(record.terminalId)} title={`Open ${record.terminalName}`}>{record.title}</button> : <strong>{record.title}</strong>}
              <small>{record.terminalName} · {providerNames[record.provider] || record.provider}{!live ? " · Closed" : ""}</small></td>
            <td title={record.cwd}>{record.projectName}<small>{record.cwd}</small></td>
            <td><span className="orchestrator-work-status">{statusNames[record.status]}</span></td>
            <td><time dateTime={new Date(record.completedAt).toISOString()}>{new Date(record.completedAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</time></td>
            <td>{record.summarySource === "status" ? <span className="orchestrator-work-no-result">No result excerpt captured.</span> :
              <details><summary>{record.summarySource === "terminal-screen" ? "Terminal excerpt" : "Agent response"}</summary><p className="orchestrator-work-excerpt">{record.summary}</p><small>{record.coverage}</small></details>}</td>
          </tr>;
        })}</tbody>
      </table>
      {!rows.length && <div className="orchestrator-work-empty">{records.length ? "No work matches this project or search." : "Completed, failed, and interrupted agent turns will appear here as they are observed."}</div>}
    </div>
    <p className="orchestrator-work-note">A completed turn means the agent finished responding; changes are not independently verified. Idle sessions and plain shells do not count. Up to 2,000 records from the last 90 days.</p>
  </section>;
}
