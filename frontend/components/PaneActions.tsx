import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { MoreHorizontal, Maximize2, Minimize2, X } from "lucide-react";

export interface PaneAction { title: string; icon?: ReactNode; run(): void; danger?: boolean }

/** Secondary actions live outside the clipped terminal tile. */
export function PaneActions({ actions, maximized, onMaximize, onClose, detail }: {
  actions: PaneAction[]; maximized: boolean; onMaximize(): void; onClose(): void; detail?: string;
}) {
  const [position, setPosition] = useState<{left:number;top:number} | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!position) return;
    menu.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const dismiss = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setPosition(null);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setPosition(null); trigger.current?.focus(); }
      if (["ArrowDown","ArrowUp","Home","End"].includes(event.key) && menu.current?.contains(document.activeElement)) {
        event.preventDefault(); event.stopPropagation();
        const items=Array.from(menu.current.querySelectorAll<HTMLButtonElement>("button"));
        const current=items.indexOf(document.activeElement as HTMLButtonElement);
        const next=event.key === "Home" ? 0 : event.key === "End" ? items.length-1 : (current+(event.key === "ArrowDown" ? 1 : -1)+items.length)%items.length;
        items[next]?.focus();
      }
    };
    window.addEventListener("pointerdown",dismiss,true); window.addEventListener("keydown",key,true);
    return () => {window.removeEventListener("pointerdown",dismiss,true);window.removeEventListener("keydown",key,true);};
  },[position]);
  return <div className="pane-actions task-pane-actions">
    <button title={maximized ? "Restore pane" : "Maximize pane"} aria-label={maximized ? "Restore pane" : "Maximize pane"} onClick={onMaximize}>{maximized ? <Minimize2 size={13}/> : <Maximize2 size={13}/>}</button>
    <button ref={trigger} title="Pane actions" aria-label="Pane actions" aria-haspopup="menu" aria-expanded={Boolean(position)} onClick={()=>{if(position){setPosition(null);return;}const rect=trigger.current!.getBoundingClientRect();setPosition({left:Math.max(8,Math.min(window.innerWidth-242,rect.right-230)),top:Math.max(8,Math.min(window.innerHeight-360,rect.bottom+5))});}}><MoreHorizontal size={16}/></button>
    <button className="danger" title="Close pane" aria-label="Close pane" onClick={onClose}><X size={14}/></button>
    {position && createPortal(<div ref={menu} className="pane-action-menu" role="menu" aria-label="Pane actions" style={position} onPointerDown={event=>event.stopPropagation()}>
      {actions.map(action=><button key={action.title} role="menuitem" title={action.title} className={action.danger ? "danger" : ""} onClick={()=>{setPosition(null);action.run();}}>{action.icon}<span>{action.title}</span></button>)}
      {detail && <p className="pane-action-detail">{detail}</p>}
    </div>,document.body)}
  </div>;
}
