import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { relayApi } from "../orchestratorUi";
import { mergeConversationFragments, type ConversationFragment } from "../conversationPages";
import { conversationPage, rebuildConversation, CONVERSATION_PAGE_CHARS } from "../conversationLive";
import type { SavedConversation } from "../orchestratorHistory";

export function ConversationHistory({ folders }: { folders: { path: string; name: string }[] }) {
  const [provider, setProvider] = useState("");
  const [cwd, setCwd] = useState("");
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<SavedConversation[]>([]);
  const [note, setNote] = useState("");
  const [selected, setSelected] = useState<SavedConversation>();
  const [fragments, setFragments] = useState<ConversationFragment[]>([]);
  const [readNote, setReadNote] = useState("");
  const [loadingPage, setLoadingPage] = useState(false);
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [olderAvailable, setOlderAvailable] = useState(false);
  const [pageLoaded, setPageLoaded] = useState(false);
  const [jumped, setJumped] = useState(false);
  const [updated, setUpdated] = useState(false);
  const [refreshNote, setRefreshNote] = useState('');
  const [transcriptQuery, setTranscriptQuery] = useState("");
  const [matches, setMatches] = useState<{ role: string; snippet: string; readCursor: string; messageId: string }[]>([]);
  const [searchNote, setSearchNote] = useState("");
  const [searchCursor, setSearchCursor] = useState<string | null>(null);
  const [searchingText, setSearchingText] = useState(false);
  const transcriptSearch = useRef(0);
  const searchedQuery = useRef("");
  const resumeRequest = useRef(0);
  const transcript = useRef<HTMLDivElement>(null);
  const scrollRestore = useRef<{ top: number; height: number } | null>(null);
  const scrollToMatch = useRef(false);
  const snapshot = useRef({ reference: '', sourceVersion: '', fragments: [] as ConversationFragment[], loaded: false });
  const bufferedOlder = useRef<ConversationFragment[]>([]);
  const [bufferAvailable, setBufferAvailable] = useState(false);
  const liveEpoch = useRef(0);
  const liveBusy = useRef(false);
  const manualRead = useRef(false);
  const followLatest = useRef(true);
  const readQueue = useRef<Promise<unknown>>(Promise.resolve());
  function fetchPage(reference: string, cursor: string | undefined, current: () => boolean) {
    const result = readQueue.current.catch(() => {}).then(async () => {
      if (!current()) throw new Error('History read superseded.');
      return conversationPage(await relayApi()?.dispatch({ kind: 'read_conversation', reference, ...(cursor ? { cursor } : {}), maxChars: CONVERSATION_PAGE_CHARS }));
    });
    readQueue.current = result;
    return result;
  }
  function invalidateSearch() {
    transcriptSearch.current++;
    setSearchingText(false); setMatches([]); setSearchCursor(null); setSearchNote('');
  }
  useLayoutEffect(() => {
    const element = transcript.current;
    if (element && scrollRestore.current) {
      element.scrollTop = scrollRestore.current.top + element.scrollHeight - scrollRestore.current.height;
      scrollRestore.current = null;
    }
    if (element && scrollToMatch.current) {
      element.scrollTop = element.scrollHeight;
      scrollToMatch.current = false;
    }
  }, [fragments]);
  function clearReader() {
    liveEpoch.current++; manualRead.current = false; followLatest.current = true;
    snapshot.current = { reference: '', sourceVersion: '', fragments: [], loaded: false };
    bufferedOlder.current = []; setBufferAvailable(false);
    setUpdated(false); setRefreshNote('');
    reading.current++; transcriptSearch.current++; resumeRequest.current++;
    setLoadingPage(false); setSearchingText(false); setOpening(false);
    setFragments([]); setReadNote(""); setOlderCursor(null); setOlderAvailable(false); setPageLoaded(false); setJumped(false);
    setTranscriptQuery(""); setMatches([]); setSearchNote(""); setSearchCursor(null);
    scrollRestore.current = null;
    scrollToMatch.current = false;
  }
  const [busy, setBusy] = useState(false);
  const [opening, setOpening] = useState(false);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const searchFilters = useRef<Record<string, string>>({});
  const request = useRef(0);
  const reading = useRef(0);
  async function search(offset = 0) {
    const api = relayApi();
    if (!api) { setNote("Conversation history is unavailable in this window."); return; }
    const revision = ++request.current;
    if (!offset) {
      searchFilters.current = { ...(provider ? { provider } : {}), ...(cwd ? { cwd } : {}), ...(query.trim() ? { query: query.trim() } : {}) };
      setNextOffset(null); setSelected(undefined); clearReader();
    }
    setBusy(true); setNote("");
    try {
      const result = await api.dispatch({ kind: "list_conversations", ...searchFilters.current, offset, limit: 50 });
      if (revision !== request.current) return;
      const page = result.ok && Array.isArray(result.conversations) ? result.conversations as SavedConversation[] : [];
      setItems(previous => offset ? [...new Map([...previous, ...page].map(item => [item.reference, item])).values()] : page);
      if (result.ok) setNextOffset(typeof result.nextOffset === "number" && result.nextOffset > offset ? result.nextOffset : null);
      setNote(result.ok ? result.truncated ? "Results are limited. Load more when available, or narrow your search." : "Saved chats come from local provider history. Availability varies by provider." : result.error || "Could not list saved conversations.");
      if (typeof result.omittedScopes === "number" && result.omittedScopes > 0) setNote(previous => `${previous} ${result.omittedScopes} provider folders were omitted; choose a provider or project to narrow the search.`);
      if (Array.isArray(result.warnings) && result.warnings.length) {
        const warnings = result.warnings.map(value => typeof value === "string" ? value : value && typeof value.message === "string" ? `${value.provider || "Provider"}: ${value.message}` : "Some provider history was unavailable.").join(" ");
        setNote(previous => `${previous} ${warnings}`);
      }
    } catch (error) { if (revision === request.current) setNote(String(error)); }
    finally { if (revision === request.current) setBusy(false); }
  }
  useEffect(() => { void search(); return () => { request.current++; reading.current++; transcriptSearch.current++; resumeRequest.current++; }; }, []);
  useEffect(() => {
    let alive = true;
    let failureCount = 0, backoffTicks = 0, failureReference = '';
    const visibilityChanged = () => { liveEpoch.current++; };
    document.addEventListener('visibilitychange', visibilityChanged);
    const timer = setInterval(() => { void poll(); }, 1000);
    async function poll() {
      const before = snapshot.current;
      if (!alive || document.hidden || liveBusy.current || manualRead.current || !before.reference || !before.loaded) return;
      if (failureReference !== before.reference) { failureCount = 0; backoffTicks = 0; failureReference = before.reference; }
      if (backoffTicks > 0) { backoffTicks--; return; }
      const epoch = liveEpoch.current;
      const current = () => alive && !document.hidden && epoch === liveEpoch.current && snapshot.current.reference === before.reference;
      liveBusy.current = true;
      try {
        const tail = await fetchPage(before.reference, undefined, current);
        if (!current()) return;
        if (tail.sourceVersion === before.sourceVersion || !followLatest.current) {
          failureCount = 0; setRefreshNote('');
          if (tail.sourceVersion !== before.sourceVersion) setUpdated(true);
          return;
        }
        const next = await rebuildConversation(tail, before.fragments, cursor => fetchPage(before.reference, cursor, current), current);
        if (!current()) return;
        if (!next) { setUpdated(true); throw new Error('The conversation is changing while history is being refreshed.'); }
        if (!followLatest.current) { setUpdated(true); return; }
        snapshot.current = { reference: before.reference, sourceVersion: next.sourceVersion, fragments: next.fragments, loaded: true };
        bufferedOlder.current = next.bufferedOlder; setBufferAvailable(next.bufferedOlder.length > 0);
        failureCount = 0; setRefreshNote('');
        invalidateSearch(); setReadNote(''); setUpdated(false);
        scrollToMatch.current = true;
        setFragments(next.fragments); setOlderCursor(next.olderCursor); setOlderAvailable(next.hasMore || next.bufferedOlder.length > 0);
      } catch {
        // Provider history can be in the middle of a write. Keep the displayed
        // snapshot; persistent failures get one stable status and slower retries.
        if (current() && ++failureCount >= 3) { backoffTicks = 4; setRefreshNote('Live updates are temporarily unavailable. Retrying automatically; use Latest to retry now.'); }
      } finally { liveBusy.current = false; }
    }
    return () => { alive = false; liveEpoch.current++; clearInterval(timer); document.removeEventListener('visibilitychange', visibilityChanged); };
  }, []);
  async function read(item: SavedConversation, cursor?: string, prepend = false, isJump = false) {
    if (selected?.reference !== item.reference) clearReader();
    liveEpoch.current++; manualRead.current = true;
    followLatest.current = !prepend && !isJump;
    const revision = ++reading.current;
    const previous = snapshot.current;
    snapshot.current = { ...previous, reference: item.reference };
    setSelected(item); setLoadingPage(true); setReadNote("");
    try {
      if (prepend && bufferedOlder.current.length) {
        if (transcript.current) scrollRestore.current = { top: transcript.current.scrollTop, height: transcript.current.scrollHeight };
        const next = mergeConversationFragments(bufferedOlder.current, previous.fragments);
        bufferedOlder.current = []; setBufferAvailable(false);
        snapshot.current = { ...previous, fragments: next }; setFragments(next); setOlderAvailable(Boolean(olderCursor));
        return;
      }
      const page = await fetchPage(item.reference, cursor, () => revision === reading.current);
      if (revision !== reading.current) return;
      if ((prepend || cursor) && previous.loaded && page.sourceVersion !== previous.sourceVersion) { setUpdated(true); throw new Error('This conversation changed while loading saved messages.'); }
      if (prepend && transcript.current) scrollRestore.current = { top: transcript.current.scrollTop, height: transcript.current.scrollHeight };
      if (!prepend) {
        bufferedOlder.current = []; setBufferAvailable(false);
        scrollRestore.current = null; scrollToMatch.current = true; setJumped(isJump); setUpdated(false);
        if (!isJump || page.sourceVersion !== previous.sourceVersion) invalidateSearch();
      }
      const next = prepend ? mergeConversationFragments(page.fragments, previous.fragments) : page.fragments;
      snapshot.current = { reference: item.reference, sourceVersion: page.sourceVersion, fragments: next, loaded: true };
      setRefreshNote('');
      setFragments(next); setOlderAvailable(page.hasMore); setOlderCursor(page.olderCursor);
      setPageLoaded(true);
    } catch (error) {
      if (revision === reading.current) {
        setReadNote(`${String(error)} Use Latest to restart from the current saved transcript.`);
        setOlderCursor(null);
      }
    } finally { if (revision === reading.current) { manualRead.current = false; setLoadingPage(false); } }
  }
  async function searchText(cursor?: string) {
    if (!selected) return;
    liveEpoch.current++; followLatest.current = false;
    const sourceVersion = snapshot.current.sourceVersion;
    const revision = ++transcriptSearch.current;
    if (!cursor) { searchedQuery.current = transcriptQuery.trim(); setMatches([]); setSearchCursor(null); }
    if (!searchedQuery.current) { setSearchNote("Enter text to search this conversation."); setSearchingText(false); return; }
    setSearchingText(true); setSearchNote("");
    try {
      const result = await relayApi()?.dispatch({ kind: "search_conversation", reference: selected.reference, query: searchedQuery.current, ...(cursor ? { cursor } : {}), limit: 10 });
      if (revision !== transcriptSearch.current) return;
      if (!result?.ok) throw new Error(result?.error || "Could not search this conversation.");
      if (sourceVersion !== snapshot.current.sourceVersion || result.sourceVersion !== sourceVersion) { setUpdated(true); throw new Error('This conversation changed. Use Latest before searching the updated messages.'); }
      const page = Array.isArray(result.matches) ? result.matches as typeof matches : [];
      const combined = cursor ? [...new Map([...matches, ...page].map(match => [match.messageId, match])).values()] : page;
      setMatches(combined);
      setSearchCursor(typeof result.nextCursor === "string" ? result.nextCursor : null);
      const coverage = result.coverage as { complete?: boolean; scannedBytes?: number; totalBytes?: number } | undefined;
      setSearchNote(`${combined.length} matching ${combined.length === 1 ? "message" : "messages"} found. ${coverage?.complete ? "Search reached the end of retained history." : "More history remains to search."}`);
    } catch (error) {
      if (revision === transcriptSearch.current) { setSearchNote(`${String(error)} Submit Search text again to restart.`); setSearchCursor(null); }
    } finally { if (revision === transcriptSearch.current) setSearchingText(false); }
  }
  async function open() {
    if (!selected || opening) return;
    const revision = ++resumeRequest.current;
    setOpening(true);
    try {
      const result = await relayApi()?.dispatch({ kind: "resume_conversation", reference: selected.reference });
      if (revision !== resumeRequest.current) return;
      setNote(result?.ok ? result.status === "revealed" ? "Revealed the existing conversation pane." : "Resume requested. Check the conversation pane for launch progress." : result?.error || "Could not open this conversation.");
    } catch (error) { if (revision === resumeRequest.current) setNote(String(error)); }
    finally { if (revision === resumeRequest.current) setOpening(false); }
  }
  return <div className="conversation-history" style={{ padding: 12, overflow: "auto", width: "100%" }}>
    <form className="conversation-history-search" onSubmit={event => { event.preventDefault(); void search(); }} style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
      <select aria-label="History provider" value={provider} onChange={event => setProvider(event.target.value)}><option value="">All providers</option>{["claude", "claude-custom", "fusion", "codex", "opencode", "openfusion", "cursor", "gemini", "kimi", "kimi-custom", "qwen", "grok"].map(value => <option key={value} value={value}>{value === "grok" ? "Grok Build" : value}</option>)}</select>
      <select aria-label="History project" value={cwd} onChange={event => setCwd(event.target.value)}><option value="">All workspace folders</option>{folders.map(folder => <option key={folder.path} value={folder.path}>{folder.name}</option>)}</select>
      <input aria-label="Search saved conversations" placeholder="Search saved conversations…" value={query} onChange={event => setQuery(event.target.value)} style={{ flex: 1, minWidth: 160 }}/><button disabled={busy}>{busy ? "Searching…" : "Search"}</button>
    </form>
    {note && <p className="dock-note" role="status">{note}</p>}
    <div style={{ display: "flex", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
      <div className="conversation-history-list" style={{ flex: "1 1 260px", maxHeight: 280, overflow: "auto" }}>{items.map(item => <button className="conversation-history-item" key={item.reference} type="button" aria-pressed={selected?.reference === item.reference} onClick={() => void read(item)} style={{ display: "block", width: "100%", textAlign: "left", padding: 8, marginBottom: 4 }}><strong>{item.title || item.id}</strong><small style={{ display: "block" }}>{item.fusion ? "Fusion" : item.openFusion ? "Open Fusion" : item.provider}{item.claudeHome === "custom" ? " · custom provider" : ""} · {item.cwd}</small></button>)}{nextOffset !== null && <button className="conversation-history-more" type="button" disabled={busy} onClick={() => void search(nextOffset)}>{busy ? "Loading…" : "Load more"}</button>}{!busy && !items.length && <p className="dock-note">No saved conversations to display.</p>}</div>
      {selected && <div className="conversation-history-preview" style={{ flex: "2 1 320px", minWidth: 0 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <strong style={{ flex: 1 }}>{selected.title || selected.id}</strong>
          <button type="button" onClick={() => void read(selected)}>Latest</button>
          {updated && <button type="button" disabled={loadingPage} onClick={() => void read(selected)}>Conversation updated</button>}
          <button type="button" disabled={opening} onClick={() => void open()}>{opening ? "Opening…" : "Open conversation"}</button>
        </div>
        <form onSubmit={event => { event.preventDefault(); void searchText(); }} style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
          <input aria-label="Search text in selected conversation" placeholder="Find text in this conversation…" maxLength={500} value={transcriptQuery} onChange={event => {
            setTranscriptQuery(event.target.value); transcriptSearch.current++; setSearchingText(false); setSearchCursor(null); setMatches([]); setSearchNote("");
          }} style={{ flex: 1, minWidth: 160 }}/>
          <button disabled={searchingText || !transcriptQuery.trim()}>{searchingText ? "Searching…" : "Search text"}</button>
        </form>
        {searchNote && <p className="dock-note" role="status">{searchNote}</p>}
        {!!matches.length && <ul aria-label="Conversation text matches" style={{ paddingLeft: 20, maxHeight: 150, overflow: "auto" }}>
          {matches.map((match, index) => <li key={`${match.messageId}:${index}`} style={{ overflowWrap: "anywhere" }}><strong>{match.role}: </strong>{match.snippet} <button type="button" onClick={() => void read(selected, match.readCursor, false, true)}>Jump to match</button></li>)}
        </ul>}
        {searchCursor && <button type="button" disabled={searchingText} onClick={() => void searchText(searchCursor)}>Continue search</button>}
        <p className="dock-note" role="status">{loadingPage ? "Loading saved messages…" : pageLoaded ? `${olderAvailable ? "Older content available" : jumped ? "Beginning of retained history reached" : "Retained history complete"}${jumped ? " · Viewing a search location; use Latest for newer content." : " · Saved user and assistant messages."}` : ""}</p>
        {readNote && <p className="dock-note" role="alert">{readNote}</p>}
        {refreshNote && <p className="dock-note" role="status">{refreshNote}</p>}
        {(olderCursor || bufferAvailable) && <button type="button" disabled={loadingPage} onClick={() => void read(selected, olderCursor || undefined, true)}>{loadingPage ? "Loading…" : "Load earlier"}</button>}
        <div ref={transcript} aria-label="Saved conversation messages" tabIndex={0} onScroll={event => {
          const element = event.currentTarget;
          if (element.scrollHeight - element.scrollTop - element.clientHeight > 32 && followLatest.current) { followLatest.current = false; liveEpoch.current++; }
        }} style={{ maxHeight: 300, overflow: "auto", overflowAnchor: "none", whiteSpace: "pre-wrap", overflowWrap: "anywhere", marginTop: 8 }}>
          {fragments.map(fragment => <div key={`${fragment.messageId}:${fragment.start}`} style={{ marginBottom: 12 }}><strong>{fragment.role}{fragment.start > 0 ? " (continued)" : ""}</strong><div>{fragment.text}</div></div>)}
          {pageLoaded && !fragments.length && <p className="dock-note">{olderAvailable ? "No readable messages in this chunk. Load earlier to continue." : "No readable transcript is available."}</p>}
        </div>
      </div>}

    </div>
  </div>;
}
