import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Sparkles } from "lucide-react";
import type { RelaySession } from "../orchestratorUi";
import { DASHBOARD_STATUS_LABELS, dashboardLayout, dashboardProjectName, dashboardProvider, dashboardRecency, dashboardScale, dashboardSessionOrder, dashboardSessionTitle, dashboardSessionVisible, dashboardStatus, dashboardTargeted, type DashboardStatus, type DashboardTarget } from "./orchestratorDashboardLayout";
import { createBubbleMotion, stepBubbleMotion, type BubbleMotion } from "./orchestratorBubbleMotion";
import "./orchestratorDashboard.css";
import { OrchestratorWorkHistory } from "./OrchestratorWorkHistory";
import type { WorkRecord } from "./orchestratorWorkHistoryModel";

export interface OrchestratorDashboardProps {
  sessions: RelaySession[];
  workHistory?: WorkRecord[];
  activeTargets: DashboardTarget[];
  busy: boolean;
  enabled: boolean;
  visible: boolean;
  onOpenSession(id: string): void;
}

export function OrchestratorDashboard({ sessions, workHistory = [], activeTargets, busy, enabled, visible, onOpenSession }: OrchestratorDashboardProps) {
  const [view, setView] = useState<"sessions" | "work">("sessions");
  const liveVisible = visible && view === "sessions";
  const viewport = useRef<HTMLDivElement>(null);
  const motion = useRef<{ key: string; bodies: BubbleMotion[] }>({ key: "", bodies: [] });
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [order, setOrder] = useState<string[] | null>(null);
  const [documentVisible, setDocumentVisible] = useState(() => !document.hidden);
  const eligible = useMemo(() => sessions.filter(dashboardSessionVisible), [sessions]);
  useLayoutEffect(() => {
    if (!liveVisible) { setOrder(null); return; }
    setOrder(previous => dashboardSessionOrder(previous, eligible));
  }, [liveVisible, eligible]);
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
  const targets = activeTargets;
  const targetedCount = live.filter(session => dashboardTargeted(session, targets)).length;
  const layout = useMemo(() => dashboardLayout(size.width, live.length, size.height), [size.width, size.height, live.length]);
  useLayoutEffect(() => {
    if (!liveVisible || !viewport.current) return;
    const element = viewport.current;
    const measure = () => {
      const style = getComputedStyle(element);
      const width = Math.max(0, element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight));
      const height = Math.max(0, element.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom));
      setSize(previous => previous.width === width && previous.height === height ? previous : { width, height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [liveVisible]);
  const logicalWidth = layout.fitScale ? size.width / layout.fitScale : 0;
  const logicalHeight = layout.fitScale ? size.height / layout.fitScale : 0;
  useLayoutEffect(() => {
    if (!liveVisible || !viewport.current || !layout.fitScale) return;
    const cells = Array.from(viewport.current.querySelectorAll<HTMLElement>(".orchestrator-dashboard-cell"));
    const key = `${liveIdentity}:${logicalWidth}:${logicalHeight}:${layout.columns}`;
    const seed = () => cells.map((cell, index) => createBubbleMotion(cell.dataset.dashboardSessionId!,
      layout.positions[index].x + layout.slot / 2 + (logicalWidth - layout.width) / 2,
      layout.positions[index].y + layout.slot / 2 + (logicalHeight - layout.height) / 2,
      layout.diameter / 2 * Number(cell.dataset.bubbleScale) + 2, motion.current.bodies.find(body => body.id === cell.dataset.dashboardSessionId)));
    if (motion.current.key !== key) motion.current = { key, bodies: seed() };
    const spheres = cells.map(cell => cell.querySelector<HTMLElement>(".orchestrator-dashboard-sphere")!);
    const surfaces = cells.map(cell => cell.querySelector<HTMLElement>(".orchestrator-dashboard-sphere-surface")!);
    const scales = cells.map(cell => ({ target: Number(cell.dataset.bubbleScale), changedAt: -Infinity }));
    const paint = () => motion.current.bodies.forEach((body, index) => {
      cells[index].style.transform = `translate3d(${body.x - layout.slot / 2}px, ${body.y - layout.slot / 2}px, 0)`;
      surfaces[index].style.transform = body.impact
        ? `rotate(${body.impactAngle}rad) scale(${1 - body.impact}, ${1 + body.impact * 0.3}) rotate(${-body.impactAngle}rad)` : "none";
    });
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0, previous = 0;
    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      // High-refresh displays still need only 60 physics/paint updates per second.
      if (previous && now - previous < 1000 / 60 - 0.5) return;
      for (let index = 0; index < cells.length; index++) {
        const body = motion.current.bodies[index];
        body.frozen = cells[index].matches(":hover, :focus-within");
        const target = Number(cells[index].dataset.bubbleScale);
        if (target !== scales[index].target) scales[index] = { target, changedAt: now };
        // Only target transitions need a style read: follow the visible CSS scale.
        const scale = now - scales[index].changedAt < 350
          ? new DOMMatrixReadOnly(getComputedStyle(spheres[index]).transform).a : target;
        body.radius = layout.diameter / 2 * scale + 2;
      }
      stepBubbleMotion(motion.current.bodies, logicalWidth, logicalHeight, previous ? (now - previous) / 1000 : 0);
      previous = now;
      paint();
    };
    const update = () => {
      cancelAnimationFrame(frame);
      previous = 0;
      if (preference.matches) motion.current.bodies = seed();
      paint();
      if (!preference.matches && documentVisible) frame = requestAnimationFrame(tick);
    };
    update();
    preference.addEventListener("change", update);
    return () => { cancelAnimationFrame(frame); preference.removeEventListener("change", update); };
  }, [liveVisible, documentVisible, liveIdentity, layout, logicalWidth, logicalHeight]);
  const legend: DashboardStatus[] = ["working", "done", "needs-you", "idle", "error"];
  for (const status of ["starting", "pending", "response", "unknown"] as DashboardStatus[]) {
    if (live.some(session => dashboardStatus(session) === status)) legend.push(status);
  }
  return <section className="orchestrator-dashboard" hidden={!visible} aria-label="Orchestrator dashboard" data-visible={visible} data-motion={liveVisible && documentVisible}>
    <header className="orchestrator-dashboard-header">
      <div><h1>Orchestrator</h1><p>{live.length} live {live.length === 1 ? "session" : "sessions"}</p></div>
      <div className="orchestrator-dashboard-scope" title="Sessions addressed by Lina during the current request" aria-live="polite">
        <Sparkles size={16} aria-hidden="true" /> {targetedCount ? `Lina handling ${targetedCount} ${targetedCount === 1 ? "session" : "sessions"}` : busy ? "Lina is thinking" : enabled ? "Lina is ready" : "Orchestrator is off"}
      </div>
    </header>
    <nav className="orchestrator-dashboard-tabs" aria-label="Dashboard view">
      <button type="button" aria-pressed={view === "sessions"} onClick={() => setView("sessions")}>Live sessions</button>
      <button type="button" aria-pressed={view === "work"} onClick={() => setView("work")}>Work history{workHistory.length ? ` (${workHistory.length})` : ""}</button>
    </nav>
    {view === "work" && <OrchestratorWorkHistory records={workHistory} sessions={sessions} onOpenSession={onOpenSession} />}
    <div className="orchestrator-dashboard-viewport" ref={viewport} hidden={!liveVisible}>
      {live.length === 0 ? <div className="orchestrator-dashboard-empty"><Sparkles size={30} aria-hidden="true" /><h2>Your sessions, together</h2><p>Start a session in a project to see it here.</p></div> :
        <div className="orchestrator-dashboard-field" style={{ width: size.width, height: size.height }}><div className="orchestrator-dashboard-grid" style={{ width: logicalWidth, height: logicalHeight, transform: `scale(${layout.fitScale})`, "--bubble-diameter": `${layout.diameter}px`, "--bubble-slot": `${layout.slot}px` } as CSSProperties}>
          {live.map((session) => {
            const active = dashboardTargeted(session, targets);
            const status = dashboardStatus(session);
            const title = dashboardSessionTitle(session);
            const project = dashboardProjectName(session);
            const identity = [project, title !== project ? title : "", session.cwd.trim()].filter(Boolean).join("\n");
            const provider = dashboardProvider(session);
            const scale = dashboardScale(active, targetedCount > 0, session.id);
            const label = DASHBOARD_STATUS_LABELS[status];
            const recency = dashboardRecency(session, renderedAt, active);
            return <div key={session.id} className="orchestrator-dashboard-cell" data-dashboard-session-id={session.id} data-generation={session.generation} data-status={status} data-targeted={active} data-bubble-scale={scale} data-recent={recency.recent} style={{ "--recency-opacity": recency.opacity } as CSSProperties}>
              <div className="orchestrator-dashboard-drift">
              <button type="button" className="orchestrator-dashboard-bubble" onClick={() => onOpenSession(session.id)} aria-label={`Open ${identity.replace(/\n/g, ", ")}, ${provider}, ${label}${active ? ", Lina handling" : ""}${recency.recent ? ", Recently used" : ""}`} title={`${identity}\n${provider} · ${label}${recency.recent ? "\nRecently used" : ""}${session.statusLabel ? `\n${session.statusLabel}` : ""}${session.pendingInput ? `\n${session.pendingInput === "submit" ? "Latest input" : "Interruption"} has not been confirmed.` : ""}`} style={{ "--bubble-scale": scale, "--label-width": `${Math.max(116, layout.diameter * scale * 0.73)}px` } as CSSProperties}>
                <span className="orchestrator-dashboard-sphere" aria-hidden="true"><span className="orchestrator-dashboard-sphere-surface"><span className="orchestrator-dashboard-glass" /><span className="orchestrator-dashboard-rim" /><span className="orchestrator-dashboard-halo" /></span></span>
                <span className="orchestrator-dashboard-label"><strong>{project}</strong><span className="orchestrator-dashboard-provider">{provider}</span><span className="orchestrator-dashboard-status"><i />{label}</span></span>
              </button>
              <span className="orchestrator-dashboard-target" aria-hidden="true"><Sparkles size={13} />Lina here</span>
              </div>
            </div>;
          })}
        </div></div>}
    </div>
    <footer className="orchestrator-dashboard-legend" hidden={!liveVisible} aria-label="Session status legend">{legend.map(status => <span key={status} data-status={status}><i />{DASHBOARD_STATUS_LABELS[status]}</span>)}</footer>
  </section>;
}
