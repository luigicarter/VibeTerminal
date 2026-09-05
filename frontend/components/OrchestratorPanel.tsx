import { ConversationHistory } from "./ConversationHistory";
import { ChangesPanel } from "./ChangesPanel";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { DOCK_COLLAPSED_KEY, DOCK_HEIGHT_KEY, clampDockHeight, defaultDockHeight, dockBounds, draggedDockHeight, keyboardDockHeight, parseDockHeight } from "./workspaceDockResize";
import "./workspaceDock.css";
import { Activity, ArrowUp, Bot, ChevronDown, Files, GitBranch, Layers3, Settings2, Square } from "lucide-react";
import { useSessionDraft, readSessionDraft, writeSessionDraft } from "../sessionDrafts";
import { relayApi, type RelayState, type RelaySession } from "../orchestratorUi";
import type { CodeChangeSummary } from "../types";
export function OrchestratorPanel({ state, sessions, selectedId, onFocus, onSettings, changes, folders, setups, handoff }: {
    state: RelayState | null;
    sessions: RelaySession[];
    selectedId: string | null;
    onFocus(id: string): void;
    onSettings(): void;
    changes?: CodeChangeSummary;
    folders: {
        id: string;
        name: string;
        path: string;
    }[];
    setups?: ReactNode;
    handoff?: ReactNode;
}) {
    const [tab, setTab] = useState("Orchestrator");
    const [expanded, setExpanded] = useState(() => {
        try { return localStorage.getItem(DOCK_COLLAPSED_KEY) !== "true"; }
        catch { return true; }
    });
    const dockRef = useRef<HTMLElement>(null);
    const gripRef = useRef<HTMLDivElement>(null);
    const threadRef = useRef<HTMLDivElement>(null);
    const followThread = useRef(true);
    const [preferredHeight, setPreferredHeight] = useState(() => {
        try { return parseDockHeight(localStorage.getItem(DOCK_HEIGHT_KEY)) || defaultDockHeight(window.innerHeight); }
        catch { return defaultDockHeight(window.innerHeight); }
    });
    const [bounds, setBounds] = useState(() => dockBounds(window.innerHeight - 100));
    const height = clampDockHeight(preferredHeight, bounds);
    useLayoutEffect(() => {
        if (followThread.current && threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight;
    }, [state?.messages, state?.requests, height, expanded, tab]);
    const drag = useRef<{ pointerId: number; startY: number; startHeight: number; restoreHeight: number; wasExpanded: boolean; moved: boolean } | null>(null);
    const [resizing, setResizing] = useState(false);
    useEffect(() => {
        try { localStorage.setItem(DOCK_HEIGHT_KEY, String(preferredHeight)); } catch { /* Preferences are optional. */ }
    }, [preferredHeight]);
    useEffect(() => {
        try { localStorage.setItem(DOCK_COLLAPSED_KEY, String(!expanded)); } catch { /* Preferences are optional. */ }
    }, [expanded]);
    useLayoutEffect(() => {
        const dock = dockRef.current;
        if (!dock) return;
        const measure = () => {
            const board = dock.previousElementSibling;
            const available = dock.getBoundingClientRect().bottom - (board?.getBoundingClientRect().top ?? 100);
            const chrome = (dock.querySelector(".dock-tabs")?.getBoundingClientRect().height ?? 39) + 13;
            const next = dockBounds(available, chrome);
            setBounds(previous => previous.min === next.min && previous.max === next.max ? previous : next);
        };
        measure();
        const observer = new ResizeObserver(measure);
        if (dock.parentElement) observer.observe(dock.parentElement);
        const tabsElement = dock.querySelector(".dock-tabs");
        if (tabsElement) observer.observe(tabsElement);
        window.addEventListener("resize", measure);
        return () => { observer.disconnect(); window.removeEventListener("resize", measure); };
    }, []);
    useEffect(() => () => {
        const active = drag.current;
        drag.current = null;
        if (active && gripRef.current?.hasPointerCapture(active.pointerId)) gripRef.current.releasePointerCapture(active.pointerId);
    }, []);
    function finishResize(pointerId: number) {
        if (drag.current?.pointerId !== pointerId) return;
        drag.current = null;
        setResizing(false);
        if (gripRef.current?.hasPointerCapture(pointerId)) gripRef.current.releasePointerCapture(pointerId);
    }
    const [text, setText] = useState("");
    const [target, setTarget] = useState("");
    const [error, setError] = useState("");
    const [fileQuery, setFileQuery] = useState("");
    const [fileResults, setFileResults] = useState<{
        path: string;
        name: string;
        directory: boolean;
    }[]>([]);
    const [fileNote, setFileNote] = useState("");
    const draftTarget = target || selectedId || "";
    const [draft, setDraft] = useSessionDraft(draftTarget);
    async function sendDraft() {
        const session = state?.sessions.find(item => item.id === draftTarget);
        if (!session?.generation) {
            setError("Select a current session before sending.");
            return;
        }
        const revision = readSessionDraft(draftTarget).revision;
        try {
            const result = await relayApi()?.dispatch({ kind: "send_prompt", target: { id: session.id, generation: session.generation }, text: draft, expectedDraftRevision: revision });
            if (result?.ok && !["staged", "manual_required"].includes(result.status || "")) {
                if (readSessionDraft(draftTarget).revision === revision)
                    writeSessionDraft(draftTarget, "");
            }
            else if (!result?.ok)
                setError(result?.error || "Delivery failed.");
        }
        catch (error) {
            setError(String(error));
        }
    }
    const tabs = [{ name: "Orchestrator", icon: Bot }, { name: "History", icon: Files }, { name: "Activity", icon: Activity }, { name: "Changes", icon: GitBranch }, { name: "Files", icon: Files }, { name: "Setups", icon: Layers3 }];
    async function send() { const api = relayApi(); if (!api || !text.trim())
        return; followThread.current = true; setError(""); try {
        const result = await api.send({ text, origin: "text", ...(target ? { targetId: target } : {}) });
        if (result.ok)
            setText("");
        else
            setError(result.error ?? "Command was not accepted.");
    }
    catch (e) {
        setError(String(e));
    } }
    return <section ref={dockRef} className={`orchestrator-dock ${expanded ? "expanded" : "collapsed"} ${resizing ? "resizing" : ""}`} style={{ "--workspace-dock-height": `${height}px` } as CSSProperties} aria-label="Workspace dock">
    <div ref={gripRef} className="dock-resize-handle" role="separator" tabIndex={0} aria-label="Resize workspace dock" aria-orientation="horizontal" aria-valuemin={expanded ? bounds.min : 0} aria-valuemax={bounds.max} aria-valuenow={expanded ? height : 0} aria-valuetext={expanded ? `${height} pixels high` : "Collapsed"} title="Drag to resize · Arrow keys to adjust · Double-click to reset"
      onPointerDown={event => {
          if (event.button !== 0 || !event.isPrimary) return;
          event.preventDefault();
          event.currentTarget.focus();
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { pointerId: event.pointerId, startY: event.clientY, startHeight: expanded ? height : 0, restoreHeight: preferredHeight, wasExpanded: expanded, moved: false };
          setResizing(true);
      }}
      onPointerMove={event => {
          const active = drag.current;
          if (!active || active.pointerId !== event.pointerId) return;
          if (!active.moved && Math.abs(event.clientY - active.startY) < 3) return;
          if (!active.wasExpanded && event.clientY >= active.startY) return;
          active.moved = true;
          const next = draggedDockHeight(active.startHeight, active.startY, event.clientY, bounds);
          setExpanded(next > 0);
          setPreferredHeight(next > 0 ? next : active.restoreHeight);
      }}
      onPointerUp={event => finishResize(event.pointerId)} onPointerCancel={event => finishResize(event.pointerId)} onLostPointerCapture={event => finishResize(event.pointerId)}
      onDoubleClick={() => { setPreferredHeight(defaultDockHeight(window.innerHeight)); setExpanded(true); }}
      onKeyDown={event => {
          if (event.key === "Enter") { event.preventDefault(); setExpanded(value => !value); return; }
          const next = keyboardDockHeight(event.key, expanded ? height : 0, bounds, event.shiftKey);
          if (next === null) return;
          event.preventDefault();
          setExpanded(next > 0);
          if (next > 0) setPreferredHeight(next);
      }}><span aria-hidden="true" /></div>
    <header className="dock-tabs"><div role="tablist" aria-label="Workspace tools">{tabs.map(({ name, icon: Icon }) => <button key={name} role="tab" aria-selected={tab === name} className={tab === name ? "active" : ""} onClick={() => { setTab(name); setExpanded(true); }}><Icon size={14}/>{name}{name === "Activity" && !!state?.requests?.length && <b>{state.requests.length}</b>}</button>)}</div><span className="dock-phase"><i className={state?.enabled ? "enabled" : ""}/>{state?.enabled ? state.phase : "Off"}</span><button className="dock-collapse" aria-label={expanded ? "Collapse dock" : "Expand dock"} onClick={() => setExpanded(!expanded)}><ChevronDown size={15} style={{ transform: expanded ? undefined : "rotate(180deg)" }}/></button></header>
    <div className="dock-content" role="tabpanel" hidden={!expanded}>
      {tab === "Orchestrator" && <div className="relay-view"><div className="relay-thread" ref={threadRef} onScroll={event => { const node = event.currentTarget; followThread.current = node.scrollHeight - node.scrollTop - node.clientHeight < 32; }}>{state?.requests?.filter(request=>!["resolved","cancelled"].includes(request.state)).map(request=><div className="relay-request" key={`${request.id}-${request.revision}`}><span>{sessions.find(session=>session.id===request.sessionId)?.name || "Session"} needs your {request.kind === "permission" ? "permission" : "answer"}</span>{request.questions?.map((question,index)=><p key={index}>{question.question}{question.options?.length ? <small>{question.options.map(option=>option.label).join(" · ")}</small> : null}</p>)}{request.detail && <p>{request.detail}</p>}<button onClick={()=>onFocus(request.sessionId)}>Review in session</button></div>)}{state?.messages?.length ? state.messages.map(message => <div className={`relay-message ${message.role}`} key={message.id}><span>{message.role === "user" ? "You" : "Orchestrator"}</span><p>{message.text}</p></div>) : <div className="relay-welcome"><Bot size={23}/><div><strong>{!state?.ready ? "Set up your orchestrator" : state.enabled ? "Ready for your command" : "Orchestrator is off"}</strong><p>{!state?.ready ? "Connect OpenRouter and choose a model for text and voice commands." : "Ask for a session update, find a saved conversation, or send an instruction."}</p></div>{!state?.ready && <button onClick={onSettings}><Settings2 size={14}/> Connect OpenRouter</button>}</div>}{(error || state?.error) && <p role="alert" className="relay-error">{error || state?.error}</p>}</div>
        {draft && draftTarget && <details className="relay-staged-draft"><summary>Staged draft · {sessions.find(session => session.id === draftTarget)?.name}</summary><textarea aria-label="Staged session draft" value={draft} onChange={event => setDraft(event.target.value)}/><button type="button" onClick={() => void sendDraft()}>Send to session</button><button type="button" onClick={() => onFocus(draftTarget)}>Open session</button></details>}
        <form className="relay-composer" onSubmit={event => { event.preventDefault(); void send(); }}><select aria-label="Command target" value={target} onChange={event => setTarget(event.target.value)}><option value="">Entire workspace</option>{sessions.map(session => <option value={session.id} key={session.id}>{session.name}</option>)}</select><textarea aria-label="Orchestrator instruction" placeholder={state?.ready ? "Tell Orchestrator what to do…" : "Connect a model in Settings to get started"} value={text} onChange={event => setText(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send();
            } }} rows={1}/>{state?.busy ? <button type="button" title="Cancel command" onClick={() => void relayApi()?.cancel()}><Square size={15}/></button> : <button type="submit" disabled={!text.trim() || !state?.ready || !state.enabled} title="Send instruction"><ArrowUp size={17}/></button>}</form>{!state?.enabled && state?.ready && <button className="relay-enable" onClick={() => void relayApi()?.setEnabled(true)}>Enable Orchestrator for this session</button>}</div>}
      {tab === "Activity" && <div className="dock-activity">{sessions.map(session => <button key={session.id} className={`activity-session ${selectedId === session.id ? "active" : ""}`} onClick={() => onFocus(session.id)}><i className={`session-dot status-${session.status}`}/><span><strong>{session.name}</strong><small>{session.projectName || session.cwd}</small></span><span>{session.statusLabel || session.status.replaceAll("-", " ")}</span>{session.lastTool && <small>{session.lastTool}</small>}</button>)}{state?.receipts?.slice(-10).reverse().map(receipt => <p className="activity-receipt" key={receipt.id}><span>{receipt.status}</span> {receipt.text}</p>)}{!sessions.length && <p className="dock-note">Launch a session to see its live activity here.</p>}</div>}
      {tab === "History" && <ConversationHistory folders={folders} />}
      {tab === "Changes" && <ChangesPanel cwd={changes?.cwd} />}
      {tab === "Files" && <div className="dock-files"><form className="file-search" onSubmit={event => { event.preventDefault(); setFileNote("Searching…"); void relayApi()?.dispatch({ kind: "search_files", query: fileQuery }).then(result => { setFileResults(Array.isArray(result.files) ? result.files as typeof fileResults : []); setFileNote(result.ok ? result.truncated ? "Showing the first matches. Refine your search for more." : "Search complete." : result.error || "Search failed."); }).catch(error => setFileNote(String(error))); }}><input aria-label="Find workspace files" value={fileQuery} onChange={event => setFileQuery(event.target.value)} placeholder="Find files in your workspace…"/><button type="submit">Search files</button></form>{fileNote && <p className="dock-note" role="status">{fileNote}</p>}{fileResults.map(file => <button key={file.path} onClick={() => void relayApi()?.dispatch({ kind: file.directory ? "open_folder" : "open_file", path: file.path }).then(result => { if (!result.ok)
            setFileNote(result.error || "Could not open file."); })}><Files size={14}/><span><strong>{file.name}</strong><small>{file.path}</small></span><span>Open ↗</span></button>)}{folders.map(folder => <button key={folder.id} onClick={() => void window.vibe?.workspace.openInExplorer(folder.path)}><Files size={17}/><span><strong>{folder.name}</strong><small>{folder.path}</small></span><span>Open folder ↗</span></button>)}{!folders.length && <p className="dock-note">Open a project to browse its files.</p>}{handoff}</div>}
      {tab === "Setups" && (setups || <p className="dock-note">Saved workspace setups are loading.</p>)}
    </div>
  </section>;
}
