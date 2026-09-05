import { ArrowUpRight, Circle, Layers3, Settings2, TerminalSquare } from "lucide-react";
import type { AgentSession } from "../types";
export function SessionNavigation({ sessions, selectedId, onFocus, onSettings }: {
    sessions: (AgentSession & {
        statusLabel?: string;
    })[];
    selectedId: string | null;
    onFocus(id: string): void;
    onSettings(): void;
}) {
    return <div className="session-navigation"><div className="sidebar-section-title">Sessions <span className="sidebar-section-count">{sessions.length}</span></div>
    <div className="session-navigation-list">{sessions.map(session => <button key={session.id} className={`session-nav-item ${selectedId === session.id ? "active" : ""}`} onClick={() => onFocus(session.id)} title={session.cwd}><TerminalSquare size={14}/><span><strong>{session.name}</strong><small>{session.statusLabel || session.status.replaceAll("-", " ")}</small></span><Circle size={7} className={`session-dot status-${session.status}`}/></button>)}{!sessions.length && <p className="nav-note">Your sessions will appear here.</p>}</div>
    <button className="workspace-settings-button" onClick={onSettings}><Settings2 size={15}/> Workspace settings <ArrowUpRight size={13}/></button></div>;
}
export function BoardHeading({ count, title }: {
    count: number;
    title: string;
}) { return <div className="board-heading"><span><Layers3 size={13}/> {title}</span><span>{count} {count === 1 ? "session" : "sessions"}{count > 0 && <><i /> Drag to arrange · Shift to swap</>}</span></div>; }
