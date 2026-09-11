import { useRef, useState } from "react";
import { ArrowUpRight, Columns3, Layers, Route, Sparkles } from "lucide-react";

const screenshots = [
  { id: "workspace", label: "Workspace", icon: Columns3, src: "/screenshots/workspace.png", alt: "Lina Terminal with a project sidebar and four local terminal panes arranged on a tiled board.", caption: "A place for every session. A view of the whole project." },
  { id: "orchestrator", label: "Orchestrator", icon: Route, src: "/screenshots/orchestrator.png", alt: "The Lina Orchestrator dashboard with demonstration agent sessions and observed activity states.", caption: "See the agents, projects, and activity across your workspace." },
  { id: "fusion", label: "Fusion", icon: Sparkles, src: "/screenshots/fusion.png", alt: "Lina Terminal Fusion chat showing the planner and executor workflow with build activity.", caption: "One conversation. A planner and a builder working together." },
  { id: "open-fusion", label: "Open Fusion", icon: Layers, src: "/screenshots/open-fusion.png", alt: "Lina Terminal Open Fusion pane with controls for choosing a Brain and an Executor.", caption: "Choose the models that fit the way you work." }
];

export const ScreenshotGallery = () => {
  const [active, setActive] = useState(0);
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const current = screenshots[active];
  return <div className="workspace-preview" id="workspace-preview">
    <div className="preview-toolbar">
      <div className="preview-tabs" role="tablist" aria-label="App screenshots">
        {screenshots.map((shot, index) => <button key={shot.id} ref={(element) => { tabs.current[index] = element; }} id={`tab-${shot.id}`} role="tab" type="button" aria-selected={index === active} aria-controls={`panel-${shot.id}`} tabIndex={index === active ? 0 : -1} onClick={() => setActive(index)} onKeyDown={(event) => {
          let next = index;
          if (event.key === "ArrowRight") next = (index + 1) % screenshots.length;
          else if (event.key === "ArrowLeft") next = (index + screenshots.length - 1) % screenshots.length;
          else if (event.key === "Home") next = 0;
          else if (event.key === "End") next = screenshots.length - 1;
          else return;
          event.preventDefault(); setActive(next); tabs.current[next]?.focus();
        }}><shot.icon size={15} /><span>{shot.label}</span></button>)}
      </div>
      <span className="preview-label"><span className="status-dot" /> Example workspace</span>
    </div>
    {screenshots.map((shot, index) => <div key={shot.id} role="tabpanel" id={`panel-${shot.id}`} aria-labelledby={`tab-${shot.id}`} hidden={index !== active} tabIndex={0} className="preview-panel">
      <a href={shot.src} target="_blank" rel="noreferrer" aria-label={`Open ${shot.label} screenshot at full size`}>
        <img src={shot.src} alt={shot.alt} width="1440" height="920" fetchPriority={index === 0 ? "high" : "auto"} loading={index === 0 ? "eager" : "lazy"} />
      </a>
    </div>)}
    <div className="preview-caption"><p>{current.caption}</p><a href={current.src} target="_blank" rel="noreferrer">View full size <ArrowUpRight size={14} /></a></div>
  </div>;
};
