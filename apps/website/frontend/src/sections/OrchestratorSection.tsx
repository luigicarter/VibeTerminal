import { ArrowLeft, ArrowUpRight, AudioLines, Check, Download, History, Layers, MessagesSquare, Route, ScanEye } from "lucide-react";
import { OrchestratorFlow } from "../components/OrchestratorFlow";
import { VoiceExperience } from "../components/VoiceExperience";

const capabilities = [
  { icon: Route, title: "Give the task a home.", text: "Name a project and an agent, or let Lina select a worker. Related follow-ups can return to the same conversation; independent work can get a fresh one." },
  { icon: ScanEye, title: "See what's happening.", text: "Inspect session activity and recent output. The dashboard brings projects, agent states, and requests into a single view." },
  { icon: MessagesSquare, title: "Keep conversations moving.", text: "Send instructions, relay your answers to agent questions, or steer an existing task while other work continues." },
  { icon: Layers, title: "Pick up your workspace.", text: "Create projects, navigate panes, and save reusable setups. Return to a familiar arrangement when you start the next task." },
  { icon: History, title: "Find the work again.", text: "Search supported saved conversations and browse observed work history by project, agent, and result." },
  { icon: AudioLines, title: "Use your voice, too.", text: "Type in the workspace tools, hold Space to speak, or enable optional Hey Lina activation for hands-free requests." }
];
const examples = [
  { intent: "Delegate", text: "Have Codex review the latest changes in my website project." },
  { intent: "Check in", text: "What is Claude working on right now?" },
  { intent: "Continue", text: "Tell it to add tests for the changes." },
  { intent: "Pick up", text: "Find my previous conversation about the login screen." }
];

export const OrchestratorSection = () => <div className="product-page product-page--orchestrator section-shell" id="top">
  <a className="breadcrumb" href="/"><ArrowLeft size={15} /> Back to Lina Terminal</a>
  <section className="product-hero">
    <p className="eyebrow"><span>THE BIG PICTURE</span> / ORCHESTRATOR</p>
    <h1>You set the direction.<br /><span>Lina connects the work.</span></h1>
    <p>One place to talk to your workspace. Give tasks to agents, see what they're doing, and keep work moving across projects, through text or voice.</p>
    <div className="hero__actions"><a className="button button--primary" href="/#download"><Download size={17} />Get Lina Terminal</a><a className="button button--quiet" href="#orchestrator-setup">How to get started <ArrowUpRight size={16} /></a></div>
  </section>
  <section className="product-section"><OrchestratorFlow /></section>
  <figure className="product-shot orchestrator-shot"><a href="/screenshots/orchestrator.png" target="_blank" rel="noreferrer"><img src="/screenshots/orchestrator.png" width="1440" height="920" loading="lazy" alt="Lina's Orchestrator dashboard showing demonstration agent sessions as glass bubbles, with project names and activity states." /></a><figcaption><span>Inside Lina · Orchestrator dashboard with demonstration sessions</span><a href="/screenshots/orchestrator.png" target="_blank" rel="noreferrer">Full size <ArrowUpRight size={14} /></a></figcaption></figure>
  <section className="product-section"><div className="section-heading"><p className="eyebrow">FROM INDIVIDUAL PANES TO SHARED DIRECTION</p><h2>A workspace you can talk to.</h2><p>The Orchestrator works across your sessions. Fusion and Open Fusion pair models inside a session. Use them together or work directly in any terminal.</p></div><div className="capability-grid">{capabilities.map(({ icon: Icon, title, text }) => <article key={title}><Icon size={23} strokeWidth={1.5} /><h3>{title}</h3><p>{text}</p></article>)}</div></section>
  <section className="product-section request-examples"><div className="section-heading"><p className="eyebrow">START WITH WHAT YOU WANT TO DO</p><h2>Less managing.<br /><span>More making progress.</span></h2><p>Use natural language. Be specific about the project, agent, and outcome when the distinction matters.</p></div><div className="request-list">{examples.map(example => <div key={example.intent}><span>{example.intent}</span><p>“{example.text}”</p></div>)}</div></section>
  <section className="product-section" id="voice"><div className="section-heading"><p className="eyebrow">SAY IT TO LINA</p><h2>Your voice.<br /><span>Connected to your agents.</span></h2><p>Hold Space to talk, or enable “Hey Lina” for hands-free requests. Answer Lina's questions naturally and interrupt a spoken reply when you need to change direction.</p></div><VoiceExperience /><a className="text-link voice-deep-link" href="/voice">Explore voice, controls, and setup <ArrowUpRight size={16} /></a></section>
  <section className="product-details"><div><p className="eyebrow">STAY CLOSE TO THE WORK</p><h2>Keep the context.<br /><span>Keep the controls.</span></h2><p>Your terminals stay available for direct work. Follow requests, inspect results, and step in when a task needs your judgment.</p></div><ul className="check-list"><li><Check size={18} />Requests stay associated with their project and conversation.</li><li><Check size={18} />Dependent tasks can wait for earlier agent results.</li><li><Check size={18} />Interrupt, redirect, or answer an agent yourself.</li><li><Check size={18} />Live status reflects available provider observations.</li></ul></section>
  <section className="product-section" id="orchestrator-setup"><div className="section-heading"><p className="eyebrow">YOUR FIRST REQUEST</p><h2>Connect. Choose. Go.</h2></div><div className="process-grid"><article className="process-step"><span>01 / CONNECT</span><h3>Bring your OpenRouter key.</h3><p>Open Workspace settings → Orchestrator & voice. Add your key and choose the assistant model you want to use.</p></article><article className="process-step"><span>02 / SET UP</span><h3>Make it your workspace.</h3><p>Open your project folders and agent sessions. Use the text conversation in Workspace tools to give Lina a task.</p></article><article className="process-step"><span>03 / SPEAK, IF YOU LIKE</span><h3>Say “Hey Lina.”</h3><p>Enable voice, allow microphone access, and choose push-to-talk or optional hands-free activation. Hold Space when a terminal or text field isn't focused.</p></article></div><p className="product-note">The workspace runs locally; assistant requests use your selected provider. Voice uses local wake detection, with completed recordings and speech processing through OpenRouter. Model interpretation and activity detail depend on the selected provider; review important results in the terminal.</p></section>
  <div className="product-crosslink"><div><p>The whole workflow, from session to workspace.</p><h2>Get to know Lina's agents.</h2></div><a className="button button--secondary" href="/agents">Explore agent workflows <ArrowUpRight size={16} /></a></div>
</div>;
