import { useState } from "react";
import { FolderPlus, X } from "lucide-react";
import { relayApi } from "../orchestratorUi";
export function NewProjectDialog({onClose}:{onClose():void}) {
  const [name,setName]=useState("");const [busy,setBusy]=useState(false);const [error,setError]=useState("");
  async function create(){if(!name.trim()||busy)return;setBusy(true);setError("");try{const result=await relayApi()?.dispatch({kind:"create_project",name:name.trim()});if(result?.ok)onClose();else setError(result?.error||"Project could not be created.");}catch(e){setError(String(e));}finally{setBusy(false);}}
  return <div className="confirmation-backdrop" onClick={()=>{if(!busy)onClose();}}><section role="dialog" aria-modal="true" aria-labelledby="new-project-title" className="confirmation-dialog new-project-dialog" onClick={e=>e.stopPropagation()}><header><FolderPlus size={20}/><h2 id="new-project-title">New project</h2><button disabled={busy} aria-label="Close new project" onClick={onClose}><X size={15}/></button></header><p>Create a folder in your Documents directory and add it to this workspace.</p><form onSubmit={e=>{e.preventDefault();void create();}}><label>Project name<input autoFocus value={name} maxLength={120} onChange={e=>setName(e.target.value)} placeholder="My next project"/></label>{error&&<p role="alert" className="relay-error">{error}</p>}<button type="submit" disabled={!name.trim()||busy}>{busy?"Creating…":"Create project"}</button></form></section></div>;
}
