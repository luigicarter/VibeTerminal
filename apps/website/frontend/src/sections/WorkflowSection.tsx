import { ArrowUpRight, AudioLines, FolderGit2, LayoutGrid, MessageSquare, Move, Sparkles } from "lucide-react";

const features = [
  { icon: LayoutGrid, title: "Give every agent some room.", description: "Arrange real terminals side by side. Drag, resize, split, or maximize a pane as the work changes." },
  { icon: FolderGit2, title: "Keep projects in their place.", description: "Group sessions by folder, see Git changes, and bring different projects together in Multi mode." },
  { icon: AudioLines, title: "Keep the work moving.", description: "Use the optional voice and text Orchestrator to inspect sessions, route tasks, and answer agent questions." }
];

export const WorkflowSection = () => <section className="content-band section-shell" id="workflow">
  <div className="section-heading section-heading--split">
    <div><p className="eyebrow"><span>01 /</span> THE WORKSPACE</p><h2>More flow.<br /><span>Less window juggling.</span></h2></div>
    <p>One agent is building. Another is reviewing. Your terminal is running the tests. Keep the whole picture in view.</p>
  </div>
  <div className="feature-grid">{features.map(({ icon: Icon, title, description }) => <article className="feature-card" key={title}><span className="feature-icon"><Icon size={23} strokeWidth={1.5} /></span><h3>{title}</h3><p>{description}</p></article>)}</div>
  <div className="workflow-footnote"><Move size={15} /><span>Your layout. Your local folders. Room to work your way.</span></div>
  <article className="orchestrator-spotlight">
    <div><p className="eyebrow"><AudioLines size={15} /> MEET YOUR ORCHESTRATOR</p><h2>One request.<br /><span>A connected workspace.</span></h2><p>Tell Lina what needs doing. Route a task, check on an agent, or pick up a conversation across your projects, through text or voice.</p><a className="text-link" href="/orchestrator">Explore the Orchestrator <ArrowUpRight size={16} /></a><a className="subtle-link" href="/agents">See the full agent workflow <ArrowUpRight size={14} /></a></div>
    <a className="spotlight-image" href="/orchestrator" aria-label="Explore Lina's Orchestrator dashboard"><img src="/screenshots/orchestrator.png" width="1440" height="920" loading="lazy" alt="Lina Orchestrator dashboard displaying the activity of several demonstration agent sessions." /></a>
  </article>
  <article className="voice-spotlight"><div><p className="eyebrow"><AudioLines size={15} /> HEY LINA</p><h2>Think out loud.<br /><span>Keep building.</span></h2><p>Give your workspace a voice. Delegate tasks, check progress, and answer agent questions with push-to-talk or optional hands-free control.</p><a className="text-link" href="/voice">Meet voice in Lina <ArrowUpRight size={16} /></a></div><div className="voice-spotlight__quote"><span><AudioLines size={17} /> YOUR NEXT REQUEST</span><blockquote>“Hey Lina, what's Codex working on?”</blockquote><small>Hold Space or say the wake phrase.</small></div></article>
  <div className="section-heading modes-heading"><p className="eyebrow"><span>02 /</span> BETTER TOGETHER</p><h2>Two minds. <span>One conversation.</span></h2><p>Let one agent plan and review while another does the building.</p></div>
  <div className="modes-grid">
    <a className="mode-card mode-card--fusion" href="/fusion">
      <div className="mode-card__top"><span className="mode-icon"><Sparkles size={23} /></span><span className="mode-tag">CLAUDE + CODEX</span><ArrowUpRight size={22} /></div>
      <h3>Meet Fusion.</h3><p>A planner and an executor, paired in one chat. Plan, build, check, and refine without managing the handoff yourself.</p>
      <div className="role-flow"><span>Claude <small>Plan & review</small></span><span className="flow-arrow" aria-hidden="true">⇄</span><span>Codex <small>Build & test</small></span></div>
      <span className="text-link">Explore Fusion <ArrowUpRight size={16} /></span>
    </a>
    <a className="mode-card mode-card--open" href="/open-fusion">
      <div className="mode-card__top"><span className="mode-icon"><MessageSquare size={23} /></span><span className="mode-tag">YOUR MODELS. YOUR PAIR.</span><ArrowUpRight size={22} /></div>
      <h3>Make it Open Fusion.</h3><p>Bring your own providers. Pick a Brain and an Executor from the available models, with the same plan, build, review workflow.</p>
      <div className="role-flow"><span>Your Brain <small>Plan & review</small></span><span className="flow-arrow" aria-hidden="true">⇄</span><span>Your Executor <small>Build & test</small></span></div>
      <span className="text-link">Explore Open Fusion <ArrowUpRight size={16} /></span>
    </a>
  </div>
</section>;
