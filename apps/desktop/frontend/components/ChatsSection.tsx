import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Plus, Search, Terminal, X } from 'lucide-react';
import type { AgentKind, AgentProfile, AgentSession, ProjectWorkspace } from '../types';
import type { ChatRow, ChatTranscript } from '../chatTypes';
import { chatBootstrap } from '../chatPersistence';
import './chatsSection.css';
export function ChatsSection({ project, projects, sessions, multi, profiles, onNew, onFocus, onOpen }: {
  project: ProjectWorkspace | null; projects: ProjectWorkspace[]; sessions: AgentSession[]; multi: boolean; profiles: AgentProfile[];
  onNew(kind: AgentKind): Promise<void>; onFocus(id: string): void; onOpen(chat: ChatRow): Promise<void>;
}) {
  const [rows, setRows] = useState<ChatRow[]>([]), [query, setQuery] = useState(''), [collapsed, setCollapsed] = useState(() => localStorage.getItem('lina:chats:collapsed') === 'true');
  const [archived, setArchived] = useState(false), [note, setNote] = useState(''), [opening, setOpening] = useState(''), [newMenu, setNewMenu] = useState(false);
  const [editing, setEditing] = useState<ChatRow | null>(null), [title, setTitle] = useState('');
  const [transcript, setTranscript] = useState<ChatTranscript | null>(null), [reading, setReading] = useState(false);
  const historyDialog = useRef<HTMLDialogElement>(null), historyEpoch = useRef(0);
  const epoch = useRef(0), mounted = useRef(true);
  const api = window.vibe?.chats;
  async function load() { const id = ++epoch.current; try { const result = await api?.list(); if (mounted.current && id === epoch.current && result) { setRows(result.chats); if (result.error) setNote(result.error); } } catch (error) { if (mounted.current) setNote(String(error)); } }
  useEffect(() => { mounted.current = true; void load(); const unsubscribe = api?.onChanged(event => { if (event.error) setNote(event.error); void load(); }); return () => { mounted.current = false; epoch.current++; unsubscribe?.(); }; }, [api]);
  useEffect(() => { localStorage.setItem('lina:chats:collapsed', String(collapsed)); }, [collapsed]);
  useEffect(() => { setNewMenu(false); }, [project?.id, multi]);
  // One flat list of the chats started here; terminals and scanned history stay out of it.
  const visible = useMemo(() => rows.filter(row => {
    if (Boolean(row.archived) !== archived) return false;
    const pane = sessions.find(s => s.id === row.paneId);
    const cwd = row.conversation?.cwd || row.cwd;
    return `${row.title} ${row.conversation?.title || ''} ${row.conversation?.id || ''} ${cwd || ''} ${pane?.name || ''}`.toLowerCase().includes(query.toLowerCase());
  }), [rows, sessions, archived, query]);
  const [limit, setLimit] = useState(50);
  useEffect(() => setLimit(50), [query, archived]);
  async function open(row: ChatRow) {
    if (opening) return;
    const pane = sessions.find(s => s.id === row.paneId);
    if (pane?.started && !row.conversation) { onFocus(pane.id); return; }
    setOpening(row.chatId); setNote('');
    try { await onOpen(row); } catch (error) { setNote(String(error instanceof Error ? error.message : error)); } finally { if (mounted.current) setOpening(''); }
  }
  async function archive(row: ChatRow) { try { await api?.update({ chatId: row.chatId, revision: row.revision, archived: !row.archived }); await load(); } catch (error) { setNote(String(error)); } }
  async function viewHistory(row: ChatRow) {
    const current = ++historyEpoch.current; setReading(true); setNote('');
    try { const result = await api?.read(row.chatId); if (mounted.current && current === historyEpoch.current && result) setTranscript(result); }
    catch (error) { if (mounted.current && current === historyEpoch.current) setNote(String(error)); }
    finally { if (mounted.current && current === historyEpoch.current) setReading(false); }
  }
  useEffect(() => { if (transcript) historyDialog.current?.showModal(); }, [transcript]);
  return <section className={'chats-section' + (collapsed ? ' collapsed' : '')} aria-label="Chats">
    <div className="sidebar-section-title">Chats <span className="sidebar-section-count">{visible.length}</span>
      <button className="chats-icon" aria-label="New chat" aria-expanded={newMenu} onClick={() => { if (collapsed) { setCollapsed(false); setNewMenu(true); } else setNewMenu(value => !value); }}><Plus size={16}/></button>
      <button className="chats-icon" aria-label={collapsed ? 'Expand chats' : 'Collapse chats'} aria-expanded={!collapsed} onClick={() => setCollapsed(value => !value)}>{collapsed ? <ChevronRight size={15}/> : <ChevronDown size={15}/>}</button>
    </div>
    {!collapsed && <>
    <div className="chats-filters"><button className={archived ? 'active' : ''} onClick={() => setArchived(value => !value)} aria-pressed={archived}>Archived</button></div>
    <label className="chats-search"><Search size={13}/><input aria-label="Search chats" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search chats"/></label>
    {newMenu && <div className="chats-new-menu" aria-label="Choose chat terminal">{profiles.filter(profile => profile.kind !== 'terminal').map(profile => <button key={profile.kind} onClick={() => { setNewMenu(false); void onNew(profile.kind).catch(error => setNote(String(error))); }}><Terminal size={13}/>{profile.label}</button>)}</div>}
    {chatBootstrap()?.recoveryNeeded && <p className="chats-recovery">Lina closed unexpectedly. Open a saved chat to resume its terminal. Previous prompts will not be sent again.</p>}
    {note && <p className="chats-notice" role="status">{note}<button aria-label="Dismiss chat notice" onClick={() => setNote('')}><X size={12}/></button></p>}
    {reading && <p className="chats-notice" role="status">Reading saved terminal conversation…</p>}
    <div className="chats-list">
      {!visible.length && <p className="chats-empty">{query ? 'No matching chats.' : archived ? 'No archived chats.' : 'No chats yet. Use + to start one.'}</p>}
      {visible.slice(0, limit).map(row => {
        const pane = sessions.find(s => s.id === row.paneId), provider = row.conversation?.fusion ? 'Fusion' : row.conversation?.openFusion ? 'Open Fusion' : row.conversation?.provider || row.kind;
        const status = opening === row.chatId ? 'Opening…' : pane?.started ? pane.status === 'running' ? 'Working' : pane.status === 'waiting' ? 'Needs input' : 'Open' : row.pending ? 'Needs recovery' : row.provisional ? 'Not saved yet' : 'Saved';
        const label = projects.find(p => p.id === row.projectId)?.name || (row.conversation?.cwd || row.cwd || '').split(/[\\/]/).filter(Boolean).pop() || 'Multi';
        return <div className="chat-row" key={row.chatId} data-chat-id={row.chatId}>
          <button className="chat-open" onClick={() => void open(row)} title={row.conversation?.cwd || row.cwd} disabled={Boolean(opening)}><Terminal size={15}/><span><span className="chat-title">{row.titleOverride ? row.title : row.conversation?.title || row.title}</span><span className="chat-meta">{provider} · {status} · {label}</span></span></button>
          <details className="chat-actions"><summary aria-label={`Actions for ${row.title}`}>···</summary><div><button disabled={reading} onClick={() => void viewHistory(row)}>View history</button><button onClick={() => { setEditing(row); setTitle(row.title); }}>Rename</button><button onClick={() => void archive(row)}>{row.archived ? 'Unarchive' : 'Archive'}</button></div></details>
        </div>;
      })}
      {visible.length > limit && <button className="chats-more" onClick={() => setLimit(value => value + 50)}>Show more chats</button>}
    </div>
    {editing && <form className="chat-rename" onSubmit={event => { event.preventDefault(); void api?.update({ chatId: editing.chatId, revision: rows.find(row => row.chatId === editing.chatId)?.revision ?? editing.revision, title }).then(() => { setEditing(null); void load(); }).catch(error => setNote(String(error))); }}><input aria-label="Chat title" autoFocus maxLength={200} value={title} onChange={event => setTitle(event.target.value)}/><button type="submit">Save</button><button type="button" onClick={() => setEditing(null)}>Cancel</button></form>}
    </>}
    {transcript && <dialog ref={historyDialog} className="chat-terminal-history" aria-labelledby="chat-history-title" onCancel={() => setTranscript(null)}><header><h2 id="chat-history-title">{transcript.title}</h2><button aria-label="Close saved chat history" onClick={() => setTranscript(null)}><X size={17}/></button></header><p>{transcript.recoveryCopy ? `Recovery copy · ${new Date(transcript.capturedAt).toLocaleString()}` : 'Saved conversation'}{transcript.limited ? ' · Recent portion; full history remains in the native provider.' : ''}</p>{transcript.note && <p>{transcript.note}</p>}<pre tabIndex={0}>{transcript.messages.map(message => `${message.role === 'user' ? '› You' : '● Agent'}\n${message.text}`).join('\n\n')}</pre></dialog>}
  </section>;
}
