import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, FolderOpen, RefreshCw, X } from "lucide-react";
import type { BranchWorktreeState, CodeChangeSummary } from "../types";
import { branchPopupPosition, createGitDisplayObserver, GIT_REFRESH_MS, upstreamLabel, worktreeLabel, type GitDisplayUpdate } from "../gitDisplayState";
import "./gitBranchDisplay.css";

function LineTotals({ value }: { value: Pick<BranchWorktreeState, "insertions" | "deletions" | "lineTotalsAvailable" | "lineTotalsTruncated"> }) {
  if (value.lineTotalsAvailable === false) return <span className="branch-picker-warning">Line totals unavailable</span>;
  if (!value.insertions && !value.deletions && !value.lineTotalsTruncated) return null;
  return <span className="branch-line-totals"><span className="diff-insertions">+{value.insertions}</span><span className="diff-deletions">−{value.deletions}</span>{value.lineTotalsTruncated && <span>partial</span>}</span>;
}

function summaryDescription(summary?: CodeChangeSummary) {
  if (!summary) return "Scanning Git changes";
  if (summary.state === "not-git") return "This folder is not a Git repository";
  if (summary.state === "unavailable") return summary.message || "Git changes unavailable";
  return `${summary.branch}: ${worktreeLabel(summary)}. ${summary.message || ""}`;
}

// App keys this component by project identity/path. Only the visible project is
// polled, and an open overview supplies the toolbar and popup in one snapshot.
export function GitBranchDisplay({ cwd }: { cwd: string }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<GitDisplayUpdate>({ refreshing: true });
  const [folderError, setFolderError] = useState("");
  const [position, setPosition] = useState<ReturnType<typeof branchPopupPosition>>();
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const refresh = useRef<() => Promise<void>>(async () => {});
  const observerRef = useRef<ReturnType<typeof createGitDisplayObserver>>();
  const popupId = useId();
  const summary = state.summary;
  const overview = state.overview;

  useEffect(() => {
    const api = window.vibe?.workspace;
    const observer = createGitDisplayObserver({
      cwd, expanded: open,
      readSummary: path => api ? api.getCodeChanges(path) : Promise.reject(new Error("Git inspection is unavailable.")),
      readOverview: path => api ? api.getBranches(path) : Promise.reject(new Error("Git inspection is unavailable.")),
      publish: update => setState(current => ({ ...current, ...update }))
    });
    observerRef.current = observer;
    refresh.current = observer.refresh;
    void observer.refresh();
    const interval = window.setInterval(() => void observer.refresh(), GIT_REFRESH_MS);
    const onFocus = () => void observer.refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      observer.dispose();
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [cwd, open]);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      if (trigger.current) setPosition(branchPopupPosition(trigger.current.getBoundingClientRect(), innerWidth, innerHeight));
    };
    place();
    list.current?.focus();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  useLayoutEffect(() => {
    // Refresh may remove the worktree button that held keyboard focus.
    if (open && dialog.current && !dialog.current.contains(document.activeElement)) list.current?.focus();
  }, [open, overview]);

  function close() {
    observerRef.current?.dispose();
    setOpen(false);
    setState(current => ({ ...current, overview: undefined }));
    setFolderError("");
    trigger.current?.focus();
  }

  function onDialogKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
    if (event.key !== "Tab") return;
    const targets = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]') || []);
    const first = targets[0], last = targets[targets.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }

  function onListKey(event: KeyboardEvent<HTMLUListElement>) {
    if (event.target !== event.currentTarget) return;
    const target = event.currentTarget;
    const positions: Record<string, number> = { ArrowDown: target.scrollTop + 48, ArrowUp: target.scrollTop - 48, PageDown: target.scrollTop + target.clientHeight, PageUp: target.scrollTop - target.clientHeight, Home: 0, End: target.scrollHeight };
    if (event.key in positions) { event.preventDefault(); target.scrollTop = positions[event.key]; }
  }

  async function openFolder(path: string) {
    setFolderError("");
    try {
      const result = await window.vibe?.workspace.openInExplorer(path);
      if (!result?.ok) setFolderError(result?.error || "Could not open the worktree folder.");
    } catch (error) { setFolderError(String(error)); }
  }

  return <div className={`code-line-summary code-change-${summary?.state || "loading"}`}>
    <button ref={trigger} type="button" className="diff-branch diff-branch-button" title={summary?.branch || "Inspect local Git branches"}
      aria-label={`Local branches${summary?.branch ? `: ${summary.branch}` : ""}`} aria-expanded={open} aria-haspopup="dialog" aria-controls={open ? popupId : undefined}
      onClick={() => open ? close() : setOpen(true)}>
      <span>{summary?.branch || "Git"}</span><ChevronDown size={11} aria-hidden="true" />
    </button>
    <span className="git-summary-state" title={summaryDescription(summary)}>
      {summary?.state === "dirty" ? <><span className={summary.conflicts ? "branch-picker-warning" : "diff-muted"}>{worktreeLabel(summary)}</span><LineTotals value={summary} /></>
        : <span className="diff-muted">{!summary ? "Scanning changes" : summary.state === "not-git" ? "No Git repo" : summary.state === "unavailable" ? "Git unavailable" : "Working tree clean"}</span>}
      {summary?.upstreamState === "gone" ? <span className="branch-picker-warning">Upstream missing</span> : <>
        {Boolean(summary?.ahead) && <span>{summary?.ahead} ahead</span>}{Boolean(summary?.behind) && <span>{summary?.behind} behind</span>}
      </>}
    </span>
    {open && createPortal(<>
      <div className="branch-picker-backdrop" onPointerDown={event => { event.preventDefault(); close(); }} />
      <div ref={dialog} id={popupId} className="branch-picker" role="dialog" aria-modal="true" aria-labelledby={`${popupId}-title`}
        style={position && { ...position, left: `clamp(8px, ${position.left}px, calc(100vw - ${position.width}px - 8px))`, maxHeight: `min(${position.maxHeight}px, calc(100dvh - ${position.top}px - 8px))` }} onKeyDown={onDialogKey}>
        <header className="branch-picker-header"><strong id={`${popupId}-title`}>Local branches</strong><div>
          <button type="button" onClick={() => { if (!state.refreshing) void refresh.current(); }} aria-disabled={state.refreshing} aria-label="Refresh branches"><RefreshCw size={14} /></button>
          <button type="button" onClick={close} aria-label="Close branches"><X size={16} /></button>
        </div></header>
        <p className="branch-picker-freshness" role="status">{state.refreshing ? "Refreshing Git snapshot…" : overview?.state === "ok" && overview.updatedAt ? `Updated ${new Date(overview.updatedAt).toLocaleTimeString()}` : "Git snapshot unavailable"}</p>
        <ul ref={list} className="branch-picker-list" tabIndex={0} aria-label="Local branches and worktrees" onKeyDown={onListKey}>
          {!overview ? <li className="branch-picker-empty">Loading branches…</li> : overview.state !== "ok" ? <li className="branch-picker-warning" role="alert">{overview.message || (overview.state === "not-git" ? "This folder is not a Git repository." : "Could not inspect Git branches.")}</li>
            : overview.branches.length === 0 ? <li className="branch-picker-empty">No local branches found.</li> : overview.branches.map(branch => <li key={branch.id} className={`branch-picker-row${branch.current ? " is-current" : ""}`}>
              <div className="branch-picker-name"><span>{branch.name}</span>{branch.current && <span className="branch-current"><Check size={12} aria-hidden="true" />Current</span>}</div>
              <div className={branch.upstreamState === "gone" ? "branch-picker-warning" : "branch-upstream"}>{upstreamLabel(branch)}</div>
              {branch.worktrees.length === 0 ? <div className="branch-worktree-state">Not checked out</div> : branch.worktrees.map(worktree => <div className="branch-worktree" key={worktree.path}>
                <div className={`branch-worktree-state${worktree.conflicts || worktree.state === "unavailable" || worktree.state === "not-git" ? " branch-picker-warning" : ""}`}><span>{worktreeLabel(worktree)}</span>{worktree.state === "dirty" && <LineTotals value={worktree} />}</div>
                {worktree.message && <div className="branch-picker-warning">{worktree.message}</div>}
                <button type="button" className="branch-worktree-path" title={`Open folder: ${worktree.path}`} onClick={() => void openFolder(worktree.path)}><FolderOpen size={13} aria-hidden="true" /><span>{worktree.path}</span></button>
              </div>)}
            </li>)}
        </ul>
        {folderError && <p className="branch-picker-warning" role="alert">{folderError}</p>}
        <p className="branch-picker-note">Local branches and detached worktrees. Upstream counts use the last fetched refs; Refresh does not fetch from the remote.</p>
      </div>
    </>, document.body)}
  </div>;
}
