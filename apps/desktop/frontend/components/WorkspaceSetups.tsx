import { useEffect, useState } from "react";
import type { AgentSession } from "../types";
import { createWorkspaceSetup, type WorkspaceSetup } from "../workspaceSetups";
import { readSessionDraft } from "../sessionDrafts";

export function requireSetupSuccess(result: unknown): void {
  if (result && typeof result === "object" && "ok" in result && result.ok === false) {
    const error = "error" in result && typeof result.error === "string" ? result.error : "The setup operation failed.";
    throw new Error(error);
  }
}

export interface WorkspaceSetupsProps {
  sessions: AgentSession[]; projectPath?: string;
  api: { list(options?: { projectPath?: string }): Promise<WorkspaceSetup[]>; save(recipe: WorkspaceSetup): Promise<unknown>; remove(id: string): Promise<unknown> };
  onLoad(recipe: WorkspaceSetup): void | Promise<void>;
}
export function WorkspaceSetups({ sessions, projectPath, api, onLoad }: WorkspaceSetupsProps) {
  const [recipes, setRecipes] = useState<WorkspaceSetup[]>([]);
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"global" | "project">("global");
  const [prompts, setPrompts] = useState<Record<string, string>>({});
  const [includeDrafts, setIncludeDrafts] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { let active = true; api.list({ projectPath }).then(rows => { if(active) setRecipes(rows); }).catch(error => { if(active) setMessage(String(error)); }); return () => { active = false; }; }, [api, projectPath]);
  const run = async (action: () => Promise<void>) => { setBusy(true); setMessage(""); try { await action(); } catch(error) { setMessage(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); } };
  return <section className="workspace-setups" aria-label="Saved launch setups">
    <h3>Launch setups</h3><p>Save pane settings, folder bindings and layout. Loading creates fresh sessions.</p>
    <label>Setup name<input value={name} onChange={event => setName(event.target.value)} placeholder="Review workspace" /></label>
    <label>Available in<select value={scope} onChange={event => setScope(event.target.value as typeof scope)}><option value="global">All projects</option><option value="project" disabled={!projectPath}>This project</option></select></label>
    <label><input type="checkbox" checked={includeDrafts} onChange={event => setIncludeDrafts(event.target.checked)} />Include current drafts as starting prompts</label>
    <p>Starting drafts are staged when you load the setup. Review and send them from each pane.</p>
    <details><summary>Optional starting drafts</summary>{sessions.map(session => <label key={session.id}>{session.name}<textarea aria-label={`Starting draft for ${session.name}`} value={prompts[session.id] ?? (includeDrafts ? readSessionDraft(session.id).text : "")} onChange={event => setPrompts(current => ({...current,[session.id]:event.target.value}))} /></label>)}</details>
    <button disabled={busy || !name.trim() || !sessions.length} onClick={() => void run(async () => { const startingDrafts = Object.fromEntries(sessions.map(session => [session.id,prompts[session.id] ?? (includeDrafts ? readSessionDraft(session.id).text : "")])); requireSetupSuccess(await api.save(createWorkspaceSetup({name,scope,projectPath,sessions,prompts:startingDrafts}))); setRecipes(await api.list({projectPath})); setName(""); setMessage("Setup saved."); })}>Save current layout</button>
    <ul>{recipes.map(recipe => <li key={recipe.id}><strong>{recipe.name}</strong><span> {recipe.panes.length} panes · {recipe.scope === "project" ? "This project" : "All projects"}</span><button disabled={busy} onClick={() => void run(async () => { await onLoad(recipe); setMessage("Setup loaded with fresh sessions."); })}>Load {recipe.name}</button><button disabled={busy} aria-label={`Delete setup ${recipe.name}`} onClick={() => void run(async () => { requireSetupSuccess(await api.remove(recipe.id)); setRecipes(await api.list({projectPath})); setMessage("Setup deleted."); })}>Delete</button></li>)}</ul>
    {!recipes.length && <p>No saved setups in this project.</p>}<p role="status">{message}</p>
  </section>;
}
export default WorkspaceSetups;
