import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { AudioLines, Check, CornerDownLeft, Mic, Pause, Play, RotateCcw, Route, Volume2 } from "lucide-react";

const stages = [
  { label: "Speak", icon: Mic, title: "“Hey Lina, ask Codex to review the website.”", detail: "Say the wake phrase and your request, or hold Space and release when you're finished.", status: "Listening to your request" },
  { label: "Understand", icon: AudioLines, title: "A clear task. A clear destination.", detail: "The Orchestrator interprets the goal, project, and agent. When it needs more context, it can ask you.", status: "Understanding the request" },
  { label: "Route", icon: Route, title: "The request reaches the right conversation.", detail: "Lina selects the task's session or opens a suitable one, then passes along your instruction.", status: "Routing to Codex · website" },
  { label: "Reply", icon: Volume2, title: "Hear the update. Keep the work in view.", detail: "Lina speaks its response. When it asks a question, answer naturally without repeating the wake phrase.", status: "Speaking · ready for your reply" }
];
const barHeights = [8,14,9,22,34,17,29,46,21,55,37,20,43,65,48,33,52,74,39,57,29,64,45,28,68,48,34,56,27,42,20,38,56,32,19,43,29,16,24,12,18,8];

export function VoiceExperience() {
  const [stage, setStage] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [inView, setInView] = useState(true);
  const [reducedMotion, setReducedMotion] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const steps = useRef<Array<HTMLButtonElement | null>>([]);
  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReducedMotion(preference.matches);
    const change = () => { setReducedMotion(preference.matches); if (preference.matches) setPlaying(false); };
    preference.addEventListener("change", change);
    const observer = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting));
    if (container.current) observer.observe(container.current);
    const hide = () => { if (document.hidden) setPlaying(false); };
    document.addEventListener("visibilitychange", hide);
    return () => { preference.removeEventListener("change", change); observer.disconnect(); document.removeEventListener("visibilitychange", hide); };
  }, []);
  useEffect(() => {
    if (!playing || !inView || reducedMotion) return;
    const timer = window.setTimeout(() => {
      if (stage === stages.length - 1) setPlaying(false);
      else setStage(current => current + 1);
    }, 3600);
    return () => window.clearTimeout(timer);
  }, [playing, stage, inView, reducedMotion]);
  const current = stages[stage];
  const CurrentIcon = current.icon;
  const choose = (index: number) => { setPlaying(false); setStage(index); };
  return <div className={`voice-experience ${playing && inView && !reducedMotion ? "is-playing" : ""}`} ref={container}>
    <div className="voice-experience__top"><span><Mic size={15} /> THE VOICE WORKFLOW</span><span className="demo-label">Interactive illustration</span></div>
    <div className="voice-experience__body">
      <div className="voice-signal" aria-hidden="true"><div className="voice-signal__icon"><CurrentIcon size={27} strokeWidth={1.3} /></div><div className="voice-wave">{barHeights.map((height, index) => <i key={index} style={{ "--bar-height": `${height}px`, "--bar-delay": `${index * -71}ms` } as CSSProperties} />)}</div><span>{current.status}</span></div>
      <div className="voice-story" key={stage}><span className="voice-story__number">0{stage + 1} / 04</span><h3>{current.title}</h3><p>{current.detail}</p></div>
    </div>
    <div className="voice-step-list" role="tablist" aria-label="Voice workflow stages">
      {stages.map((item, index) => <button type="button" key={item.label} ref={element => { steps.current[index] = element; }} role="tab" id={`voice-tab-${index}`} aria-controls="voice-stage-detail" aria-selected={stage === index} tabIndex={stage === index ? 0 : -1} onClick={() => choose(index)} onKeyDown={event => {
        let next: number;
        if (event.key === "ArrowRight") next = (index + 1) % stages.length;
        else if (event.key === "ArrowLeft") next = (index + stages.length - 1) % stages.length;
        else if (event.key === "Home") next = 0;
        else if (event.key === "End") next = stages.length - 1;
        else return;
        event.preventDefault(); choose(next); steps.current[next]?.focus();
      }}><span>{index < stage ? <Check size={13} /> : `0${index + 1}`}</span>{item.label}</button>)}
    </div>
    <div id="voice-stage-detail" role="tabpanel" aria-labelledby={`voice-tab-${stage}`} className="sr-only">{current.title} {current.detail}</div>
    <div className="voice-experience__footer"><p>This preview uses no microphone or audio.</p><button type="button" className="text-link" onClick={() => {
      if (reducedMotion) { choose((stage + 1) % stages.length); return; }
      if (playing) { setPlaying(false); return; }
      if (stage === stages.length - 1) setStage(0);
      setPlaying(true);
    }}>{reducedMotion ? <CornerDownLeft size={15} /> : playing ? <Pause size={15} /> : stage === stages.length - 1 ? <RotateCcw size={15} /> : <Play size={15} />}{reducedMotion ? "Next stage" : playing ? "Pause" : stage === stages.length - 1 ? "Replay walkthrough" : "Play walkthrough"}</button></div>
  </div>;
}
