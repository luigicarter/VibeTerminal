import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { OrchestratorSettings } from './OrchestratorSettings';
import { ModelProviderSettings } from './ModelProviderSettings';

export interface SettingsDialogProps {
  hint?: string | null;
  selectedPanel?: string;
  onPanelChange?(panel: string): void;
  onClose(): void;
}
export function SettingsDialog({hint,selectedPanel,onPanelChange,onClose}:SettingsDialogProps):JSX.Element {
  const [localPanel,setLocalPanel]=useState(hint?'providers':'orchestrator');
  const selected=selectedPanel??localPanel;
  const panel=selected==='open-codex'?'providers':selected;
  const setPanel=(next:string)=>{setLocalPanel(next);onPanelChange?.(next);};
  const [hintDismissed,setHintDismissed]=useState(false);
  const [density,setDensity]=useState(()=>localStorage.getItem('vibe-terminal:chrome-density:v1')||'comfortable');
  useEffect(()=>{onPanelChange?.(panel);},[panel,onPanelChange]);
  useEffect(()=>{const escape=(event:KeyboardEvent)=>{if(event.key==='Escape')onClose();};window.addEventListener('keydown',escape);return()=>window.removeEventListener('keydown',escape);},[onClose]);
  return <div className="confirmation-backdrop" onClick={onClose}>
    <section className="confirmation-dialog settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-dialog-title" onClick={event=>event.stopPropagation()}>
      <header className="settings-header"><h2 id="settings-dialog-title">Settings</h2><button type="button" className="settings-close" aria-label="Close settings" onClick={onClose}><X size={15}/></button></header>
      {hint&&!hintDismissed&&<p className="settings-hint"><span>{hint}</span><button type="button" className="settings-hint-dismiss" aria-label="Dismiss note" onClick={()=>setHintDismissed(true)}><X size={12}/></button></p>}
      <div className="settings-body">
        <nav className="settings-navigation" aria-label="Settings sections">{[{id:'orchestrator',label:'Orchestrator & voice'},{id:'providers',label:'Models & providers'},{id:'appearance',label:'Appearance'}].map(item=><button key={item.id} aria-current={panel===item.id?'page':undefined} onClick={()=>setPanel(item.id)}>{item.label}</button>)}</nav>
        <div hidden={panel!=='orchestrator'}><OrchestratorSettings/></div>
        {panel==='providers'&&<ModelProviderSettings/>}
        {panel==='appearance'&&<section className="settings-section"><h3>Workspace appearance</h3><p className="settings-description">Choose the density of navigation and controls. Terminal text keeps its own sizing.</p><div role="radiogroup" aria-label="Interface density" className="density-options">{['comfortable','compact'].map(value=><button role="radio" aria-checked={density===value} key={value} onClick={()=>{setDensity(value);localStorage.setItem('vibe-terminal:chrome-density:v1',value);document.documentElement.dataset.density=value;}}>{value==='comfortable'?'Comfortable':'Compact'}</button>)}</div></section>}
      </div>
    </section>
  </div>;
}
