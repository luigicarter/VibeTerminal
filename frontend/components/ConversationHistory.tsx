import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { relayApi } from "../orchestratorUi";
import { mergeConversationFragments, type ConversationFragment } from "../conversationPages";
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
  async function read(item: SavedConversation, cursor?: string, prepend = false, isJump = false) {
    if (selected?.reference !== item.reference) clearReader();
    const revision = ++reading.current;
    setSelected(item); setLoadingPage(true); setReadNote("");
    if (!prepend) {
      setFragments([]); setOlderCursor(null); setOlderAvailable(false); setPageLoaded(false); setJumped(isJump);
      scrollRestore.current = null;
      scrollToMatch.current = false;
      if (transcript.current) transcript.current.scrollTop = 0;
    }
    try {
      const result = await relayApi()?.dispatch({ kind: "read_conversation", reference: item.reference, ...(cursor ? { cursor } : {}), maxChars: 16000 });
      if (revision !== reading.current) return;
      if (!result?.ok) throw new Error(result?.error || "Could not read this saved conversation.");
      const messages = Array.isArray(result.messages) ? result.messages as { role: string; text: string }[] : [];
      const ranges = Array.isArray(result.messageRanges) ? result.messageRanges as { messageId: string; start: number; end: number }[] : [];
      if (messages.length !== ranges.length) throw new Error("This history response has no usable message ranges. Reload Latest to try again.");
      const page = messages.map((message, index) => ({ ...message, ...ranges[index] }));
      if (prepend && transcript.current) scrollRestore.current = { top: transcript.current.scrollTop, height: transcript.current.scrollHeight };
      scrollToMatch.current = isJump;
      setFragments(previous => prepend ? mergeConversationFragments(page, previous) : page);
      setOlderAvailable(result.hasMore === true);
      setOlderCursor(typeof result.nextCursor === "string" ? result.nextCursor : null);
      setPageLoaded(true);
    } catch (error) {
      if (revision === reading.current) {
        setReadNote(`${String(error)} Use Latest to restart from the current saved transcript.`);
        setOlderCursor(null);
      }
    } finally { if (revision === reading.current) setLoadingPage(false); }
  }
  async function searchText(cursor?: string) {
    if (!selected) return;
    const revision = ++transcriptSearch.current;
    if (!cursor) { searchedQuery.current = transcriptQuery.trim(); setMatches([]); setSearchCursor(null); }
    if (!searchedQuery.current) { setSearchNote("Enter text to search this conversation."); setSearchingText(false); return; }
    setSearchingText(true); setSearchNote("");
    try {
      const result = await relayApi()?.dispatch({ kind: "search_conversation", reference: selected.reference, query: searchedQuery.current, ...(cursor ? { cursor } : {}), limit: 10 });
      if (revision !== transcriptSearch.current) return;
      if (!result?.ok) throw new Error(result?.error || "Could not search this conversation.");
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
      <select aria-label="History provider" value={provider} onChange={event => setProvider(event.target.value)}><option value="">All providers</option>{["claude", "claude-custom", "fusion", "codex", "opencode", "openfusion", "cursor", "gemini", "kimi", "kimi-custom", "qwen"].map(value => <option key={value}>{value}</option>)}</select>
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
        {olderCursor && <button type="button" disabled={loadingPage} onClick={() => void read(selected, olderCursor, true)}>{loadingPage ? "Loading…" : "Load earlier"}</button>}
        <div ref={transcript} aria-label="Saved conversation messages" tabIndex={0} style={{ maxHeight: 300, overflow: "auto", overflowAnchor: "none", whiteSpace: "pre-wrap", overflowWrap: "anywhere", marginTop: 8 }}>
          {fragments.map(fragment => <div key={`${fragment.messageId}:${fragment.start}`} style={{ marginBottom: 12 }}><strong>{fragment.role}{fragment.start > 0 ? " (continued)" : ""}</strong><div>{fragment.text}</div></div>)}
          {pageLoaded && !fragments.length && <p className="dock-note">{olderAvailable ? "No readable messages in this chunk. Load earlier to continue." : "No readable transcript is available."}</p>}
        </div>
      </div>}

    </div>
  </div>;
}
