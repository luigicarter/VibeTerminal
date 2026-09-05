import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Sparkles } from "lucide-react";
import type { RelaySession } from "../orchestratorUi";
import { DASHBOARD_STATUS_LABELS, dashboardDrift, dashboardLayout, dashboardProvider, dashboardRecency, dashboardScale, dashboardSessionOrder, dashboardSessionTitle, dashboardSessionVisible, dashboardStatus, dashboardTargeted, type DashboardStatus, type DashboardTarget } from "./orchestratorDashboardLayout";
import "./orchestratorDashboard.css";

export interface OrchestratorDashboardProps {
  sessions: RelaySession[];
  activeTargets: DashboardTarget[];
  busy: boolean;
  enabled: boolean;
  visible: boolean;
  onOpenSession(id: string): void;
}

export function OrchestratorDashboard({ sessions, activeTargets, busy, enabled, visible, onOpenSession }: OrchestratorDashboardProps) {
  const viewport = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [order, setOrder] = useState<string[] | null>(null);
  const [documentVisible, setDocumentVisible] = useState(() => !document.hidden);
  const eligible = useMemo(() => sessions.filter(dashboardSessionVisible), [sessions]);
  useLayoutEffect(() => {
    if (!visible) { setOrder(null); return; }
    setOrder(previous => dashboardSessionOrder(previous, eligible));
  }, [visible, eligible]);
  const renderedAt = Date.now();
  useEffect(() => {
    if (!visible) return;
    const update = () => setDocumentVisible(!document.hidden);
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, [visible]);
  const live = useMemo(() => {
    const ranks = new Map(dashboardSessionOrder(order, eligible).map((id, index) => [id, index]));
    return [...eligible].sort((a, b) => ranks.get(a.id)! - ranks.get(b.id)!);
  }, [eligible, order]);
  const liveIdentity = live.map(session => session.id).join("\0");
  useEffect(() => {
    if (!visible || !viewport.current) return;
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) entry.target.setAttribute("data-in-view", String(entry.isIntersecting));
    }, { root: viewport.current });
    viewport.current.querySelectorAll(".orchestrator-dashboard-cell").forEach(cell => observer.observe(cell));
    return () => observer.disconnect();
  }, [visible, liveIdentity]);
  const targets = activeTargets;
  const targetedCount = live.filter(session => dashboardTargeted(session, targets)).length;
  const layout = useMemo(() => dashboardLayout(width, live.length), [width, live.length]);
  useLayoutEffect(() => {
    if (!visible || !viewport.current) return;
    const element = viewport.current;
    const measure = () => setWidth(Math.floor(element.clientWidth - 48));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [visible]);
  const legend: DashboardStatus[] = ["working", "done", "needs-you", "idle", "error"];
  if (live.some(session => dashboardStatus(session) === "unknown")) legend.push("unknown");
  return <section className="orchestrator-dashboard" hidden={!visible} aria-label="Orchestrator dashboard" data-visible={visible} data-motion={visible && documentVisible}>
    <header className="orchestrator-dashboard-header">
      <div><h1>Orchestrator</h1><p>{live.length} live {live.length === 1 ? "session" : "sessions"}</p></div>
      <div className="orchestrator-dashboard-scope" title="Sessions addressed by Vibe during the current request" aria-live="polite">
        <Sparkles size={16} aria-hidden="true" /> {targetedCount ? `Vibe handling ${targetedCount} ${targetedCount === 1 ? "session" : "sessions"}` : busy ? "Vibe is thinking" : enabled ? "Vibe is ready" : "Orchestrator is off"}
      </div>
    </header>
    <div className="orchestrator-dashboard-viewport" ref={viewport}>
      {live.length === 0 ? <div className="orchestrator-dashboard-empty"><Sparkles size={30} aria-hidden="true" /><h2>Your sessions, together</h2><p>Start a session in a project to see it here.</p></div> :
        <div className="orchestrator-dashboard-grid" style={{ gridTemplateColumns: `repeat(${layout.columns}, ${layout.slot}px)`, gridAutoRows: `${layout.slot}px`, gap: layout.gap, width: layout.width, "--bubble-diameter": `${layout.diameter}px` } as CSSProperties}>
          {live.map(session => {
            const active = dashboardTargeted(session, targets);
            const status = dashboardStatus(session);
            const title = dashboardSessionTitle(session);
            const provider = dashboardProvider(session);
            const scale = dashboardScale(active, targetedCount > 0);
            const label = DASHBOARD_STATUS_LABELS[status];
            const recency = dashboardRecency(session, renderedAt, active);
            const drift = dashboardDrift(session.id);
            return <div key={session.id} className="orchestrator-dashboard-cell" data-dashboard-session-id={session.id} data-generation={session.generation} data-status={status} data-targeted={active} data-recent={recency.recent} style={{ "--drift-duration": `${drift.duration}s`, "--drift-delay": `${drift.delay}s`, "--drift-distance": `${drift.distance}px`, "--recency-opacity": recency.opacity } as CSSProperties}>
              <div className="orchestrator-dashboard-drift">
              <button type="button" className="orchestrator-dashboard-bubble" onClick={() => onOpenSession(session.id)} aria-label={`Open ${title}, ${provider}, ${label}${active ? ", Vibe handling" : ""}${recency.recent ? ", Recently used" : ""}`} title={`${title}\n${provider} · ${label}\n${session.cwd}${recency.recent ? "\nRecently used" : ""}${session.statusLabel ? `\n${session.statusLabel}` : ""}`} style={{ "--bubble-scale": scale, "--label-width": `${Math.max(116, layout.diameter * scale * 0.73)}px` } as CSSProperties}>
                <span className="orchestrator-dashboard-sphere" aria-hidden="true"><span className="orchestrator-dashboard-glass" /><span className="orchestrator-dashboard-rim" /><span className="orchestrator-dashboard-halo" /></span>
                <span className="orchestrator-dashboard-label"><strong>{title}</strong><span className="orchestrator-dashboard-provider">{provider}</span><span className="orchestrator-dashboard-status"><i />{label}</span></span>
              </button>
              <span className="orchestrator-dashboard-target" aria-hidden="true"><Sparkles size={13} />Vibe here</span>
              </div>
            </div>;
          })}
        </div>}
    </div>
    <footer className="orchestrator-dashboard-legend" aria-label="Session status legend">{legend.map(status => <span key={status} data-status={status}><i />{DASHBOARD_STATUS_LABELS[status]}</span>)}</footer>
  </section>;
}
