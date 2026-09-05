import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { runtimeElapsed, runtimeSessionStatus, runtimeStatusLabel, type TerminalRuntimeSnapshot } from "../terminalRuntime";

export default function TerminalActivity({ runtime, started }: { runtime?: TerminalRuntimeSnapshot; started: boolean }) {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(Date.now());
  const root = useRef<HTMLDivElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; right: number }>();
  useLayoutEffect(() => {
    if (!open) { setPosition(undefined); return; }
    const place = () => {
      if (!root.current || !popover.current) return;
      const anchor = root.current.getBoundingClientRect();
      const panel = popover.current.getBoundingClientRect();
      const gap = 8;
      const right = Math.max(gap, Math.min(window.innerWidth - anchor.right, window.innerWidth - panel.width - gap));
      const below = anchor.bottom + gap;
      const top = Math.max(gap, Math.min(below + panel.height <= window.innerHeight - gap ? below : anchor.top - panel.height - gap, window.innerHeight - panel.height - gap));
      setPosition({ top, right });
    };
    place();
    const observer = new ResizeObserver(place);
    if (root.current) observer.observe(root.current);
    if (popover.current) observer.observe(popover.current);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { observer.disconnect(); window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node) && !popover.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    };
    document.addEventListener("pointerdown", close, true);
    document.addEventListener("keydown", escape, true);
    return () => { window.clearInterval(timer); document.removeEventListener("pointerdown", close, true); document.removeEventListener("keydown", escape, true); };
  }, [open]);
  // A coarse delegation flag is activity, never evidence of a child count.
  const children = [...new Map((runtime?.children ?? []).filter(child => child.id).map(child => [child.id, child])).values()];
  const elapsed = runtime && runtimeElapsed(runtime, now);
  return <div ref={root} className="terminal-activity" onPointerDown={(event) => event.stopPropagation()}>
    <button type="button" className={`status-pill status-${runtime ? runtimeSessionStatus(runtime) : "idle"}`} aria-expanded={open} aria-label="Terminal activity" onClick={() => setOpen(!open)}>
      {runtimeStatusLabel(runtime, started)}{children.length > 0 && ` | ${children.length} ${children.length === 1 ? "child" : "children"}`}
    </button>
    {open && createPortal(<div ref={popover} className="terminal-activity-popover" role="region" aria-label="Terminal activity details"
      style={{ position: "fixed", top: position?.top ?? 0, right: position?.right ?? 8, zIndex: 1000, maxHeight: "min(300px, calc(100vh - 16px))", maxWidth: "calc(100vw - 16px)", visibility: position ? "visible" : "hidden" }}>
      <strong>{runtimeStatusLabel(runtime, started)}</strong>
      {elapsed && <span>Turn elapsed: {elapsed}</span>}
      {runtime?.pendingInput && <span>Waiting for provider confirmation.</span>}
      {runtime?.activeTools.map(tool => <span key={tool.id}>Tool: {tool.name}</span>)}
      {runtime?.lastTool && !runtime.activeTools.length && <span>Last tool: {runtime.lastTool.name}</span>}
      {children.length > 0 && <>
        <span>{children.length} active {children.length === 1 ? "child" : "children"}</span>
        <ul>{children.map(child => <li key={child.id}>{child.label || child.id}</li>)}</ul>
      </>}
      {!children.length && runtime?.childActivity && <span>Child activity</span>}
      <span>{!runtime || runtime.telemetryHealth === "pending" ? "Connecting observation…" : (runtime.observation === "unavailable" || runtime.telemetryHealth === "unavailable") ? "Activity observation unavailable" : runtime.observation === "provisional" ? "Limited activity observation" : "Activity observation available"}</span>
      {runtime && <span>Last update: {new Date(runtime.updatedAt).toLocaleTimeString()}</span>}
      {runtime && (runtime.pendingInput || runtime.observation === "unavailable" || runtime.telemetryHealth === "unavailable") && <span>Last observed turn: {runtime.turnState}</span>}
      {runtime?.binding.message && <span>{runtime.binding.message}</span>}
    </div>, document.body)}
  </div>;
}
