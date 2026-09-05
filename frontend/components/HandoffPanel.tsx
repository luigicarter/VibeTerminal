import { useEffect, useRef, useState } from "react";
import { freezeHandoff, handoffTargetIsCurrent, type HandoffDraft, type HandoffEndpoint } from "../workspaceSetups";

export interface HandoffPanelProps {
  sessions: (HandoffEndpoint & { name: string })[];
  onStage(draft: HandoffDraft): Promise<{ok: boolean; error?: string; status?: string}>;
}
export function exactRecentOutput(result: unknown, source: HandoffEndpoint): string {
  const value = result as { ok?: boolean; error?: string; observation?: { ok?: boolean; error?: string; id?: string; generation?: string; text?: string } };
  if (!value?.ok || value.observation?.ok === false) throw new Error(value?.error || value?.observation?.error || "Recent output is unavailable.");
  const observation = value.observation;
  if (observation?.id !== source.id || observation.generation !== source.generation) throw new Error("The source session changed. Read its output again.");
  if (typeof observation.text !== "string") throw new Error("This session has no readable output.");
  return observation.text;
}
export function HandoffPanel({sessions,onStage}: HandoffPanelProps) {
  const [sourceId,setSource] = useState(""); const [targetId,setTarget] = useState("");
  const [selectedText,setSelectedText] = useState(""); const [files,setFiles] = useState(""); const [instruction,setInstruction] = useState("");
  const [draft,setDraft] = useState<HandoffDraft | null>(null); const [preview,setPreview] = useState("");
  const [message,setMessage] = useState(""); const [busy,setBusy] = useState(false);
  const [reading,setReading] = useState(false);
  const [contextSource,setContextSource] = useState<HandoffEndpoint | null>(null);
  const readToken = useRef(0);
  const latest = useRef({sessions,sourceId}); latest.current = {sessions,sourceId};
  useEffect(() => () => { readToken.current++; }, []);
  async function useRecentOutput() {
    const source = sessions.find(s => s.id === sourceId);
    if (!source) return;
    const token = ++readToken.current;
    setReading(true);setMessage("");setDraft(null);
    try {
      const api = window.vibe?.orchestrator;
      if (!api) throw new Error("Recent output is unavailable in this window.");
      const result = await api.dispatch({kind:"read_session",targetId:source.id,generation:source.generation});
      if (token !== readToken.current) return;
      if (latest.current.sourceId !== source.id || !latest.current.sessions.some(s => s.id === source.id && s.generation === source.generation)) throw new Error("The source session changed. Read its output again.");
      setSelectedText(exactRecentOutput(result,source));setContextSource({...source});setDraft(null);
      setMessage("Recent output copied exactly. Edit the selected context before preparing your preview.");
    } catch(error) { if(token === readToken.current) setMessage(error instanceof Error ? error.message : String(error)); }
    finally { if(token === readToken.current) setReading(false); }
  }
  function prepare() {
    try {
      const source = sessions.find(s => s.id === sourceId), target = sessions.find(s => s.id === targetId);
      if (!source || !target) throw new Error("Select a source and destination.");
      if (contextSource && (contextSource.id !== source.id || contextSource.generation !== source.generation)) throw new Error("The source session restarted. Read its output again.");
      const next = freezeHandoff({source,target,selectedText,paths:files.split(/\r?\n/).filter(line => line.length > 0),instruction});
      setDraft(next); setPreview(next.text); setMessage("Context frozen. Review the exact outgoing draft below.");
    } catch(error) { setMessage(error instanceof Error ? error.message : String(error)); }
  }
  async function stage() {
    if (!draft) return;
    if (!handoffTargetIsCurrent(draft,sessions)) { setMessage("A selected session restarted or closed. Select it again and prepare a new preview."); return; }
    setBusy(true);
    try {
      const frozen = freezeHandoff({...draft,text:preview});
      const result = await onStage(frozen);
      if (!result.ok) throw new Error(result.error || "Draft could not be staged.");
      setMessage(`Outgoing receipt: draft staged for ${draft.target.name || draft.target.id}. Review and send it in that pane.`); setDraft(null);
    } catch(error) { setMessage(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); }
  }
  return <section className="handoff-panel" aria-label="Context handoff"><h3>Hand off selected context</h3><p>Choose both sessions, paste the exact context and add your instruction. The outgoing draft stays editable.</p>
    <label>Source session<select value={sourceId} onChange={e => {readToken.current++;setReading(false);setSource(e.target.value);setContextSource(null);setSelectedText("");setDraft(null);}}><option value="">Choose source</option>{sessions.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
    <button disabled={busy || reading || !sourceId} onClick={() => void useRecentOutput()}>{reading ? "Reading output…" : "Use recent output"}</button>
    <label>Destination session<select value={targetId} onChange={e => {setTarget(e.target.value);setDraft(null);}}><option value="">Choose destination</option>{sessions.filter(s => s.id !== sourceId).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
    <label>Exact selected context<textarea value={selectedText} onChange={e => {readToken.current++;setReading(false);setSelectedText(e.target.value);setDraft(null);}} /></label>
    <label>File references, one per line<textarea value={files} onChange={e => {setFiles(e.target.value);setDraft(null);}} /></label>
    <label>Your instruction<textarea value={instruction} onChange={e => {setInstruction(e.target.value);setDraft(null);}} /></label>
    <button disabled={busy || reading || !sourceId || !targetId} onClick={prepare}>Prepare preview</button>
    {draft && <div><p>Frozen source: {draft.source.name} · Destination: {draft.target.name}</p><label>Exact outgoing preview<textarea rows={9} value={preview} onChange={e => setPreview(e.target.value)} /></label><button disabled={busy || !preview.trim()} onClick={() => void stage()}>Stage draft in destination</button></div>}
    <p role="status">{message}</p></section>;
}
export default HandoffPanel;
