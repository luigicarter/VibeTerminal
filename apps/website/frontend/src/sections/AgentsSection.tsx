import { ArrowLeft, ArrowUpRight, Check, Download, FolderGit2, GitBranch, Layers, LayoutGrid, MessageSquare, Route, Sparkles, SquareTerminal } from "lucide-react";
import { REPOSITORY_URL } from "../services/releases";

const modes = [
  { icon: SquareTerminal, number: "01", title: "Work with an agent.", text: "Run your coding CLI in a real terminal. Give it a task, follow the output, and keep your own shell alongside it.", link: "#agent-catalog", label: "See supported agents" },
  { icon: Sparkles, number: "02", title: "Pair the specialists.", text: "Use Fusion or Open Fusion for a planner and an executor in one chat, with a separate review step built into the workflow.", link: "/fusion", label: "Meet Fusion" },
  { icon: Route, number: "03", title: "Connect the workspace.", text: "Let the Orchestrator route tasks, inspect sessions, and bring your instructions to the right agent across projects.", link: "/orchestrator", label: "Meet the Orchestrator" }
];
const agents = [
  { name: "Codex", detail: "OpenAI's coding agent", command: "codex" },
  { name: "Claude", detail: "Claude Code and custom providers", command: "claude" },
  { name: "Cursor", detail: "Cursor's command-line agent", command: "cursor-agent" },
  { name: "Gemini", detail: "Google's terminal coding agent", command: "gemini" },
  { name: "OpenCode", detail: "A multi-provider coding CLI", command: "opencode" },
  { name: "Kimi", detail: "Kimi and the Kimi + CC launcher", command: "kimi" },
  { name: "Qwen", detail: "Qwen's coding CLI", command: "qwen" },
  { name: "Grok Build", detail: "Grok's native coding workflow", command: "Grok Build" },
  { name: "Your terminal", detail: "PowerShell and your local tools", command: ">_" }
];
const tools = [
  { icon: LayoutGrid, title: "A board that fits the work", text: "Drag, resize, split, maximize, duplicate, or restart panes. Use Shift while dropping to swap positions." },
  { icon: FolderGit2, title: "Projects with their own context", text: "Keep sessions grouped by local folder, with Git branch and change information close by." },
  { icon: Layers, title: "Several projects, one view", text: "Use Multi mode to arrange terminals from different folders together, with a working folder for every session." },
  { icon: MessageSquare, title: "Conversations you can return to", text: "Find and resume supported agent threads. Keep going in the conversation that belongs to the task." },
  { icon: GitBranch, title: "Handoffs with context", text: "Stage an instruction alongside selected output and file references, then send it when you're ready." },
  { icon: Route, title: "Reusable ways to start", text: "Save a workspace setup and launch a fresh arrangement of sessions when the next project needs it." }
];

export const AgentsSection = () => <div className="product-page product-page--agents section-shell" id="top">
  <a className="breadcrumb" href="/"><ArrowLeft size={15} /> Back to Lina Terminal</a>
  <section className="product-hero"><p className="eyebrow"><span>BUILT AROUND AGENTIC WORK</span> / AGENTS & WORKFLOWS</p><h1>Build with agents.<br /><span>Work as a team.</span></h1><p>Give an agent a task. Pair a planner with a builder. Coordinate work across projects. Lina brings these ways of working into one desktop workspace, with your terminals always within reach.</p><div className="hero__actions"><a className="button button--primary" href="/#download"><Download size={17} />Get Lina Terminal</a><a className="button button--quiet" href="#agent-catalog">Find your agents <ArrowUpRight size={16} /></a></div></section>
  <section className="product-section"><div className="section-heading"><p className="eyebrow">THREE WAYS TO WORK</p><h2>Start with a pane.<br /><span>Grow into a workflow.</span></h2></div><div className="agent-mode-grid">{modes.map(({ icon: Icon, ...mode }) => <article key={mode.number}><div><Icon size={24} /><span>{mode.number} /</span></div><h3>{mode.title}</h3><p>{mode.text}</p><a className="text-link" href={mode.link}>{mode.label} <ArrowUpRight size={15} /></a></article>)}</div></section>
  <figure className="product-shot"><a href="/screenshots/workspace.png" target="_blank" rel="noreferrer"><img src="/screenshots/workspace.png" width="1440" height="920" loading="lazy" alt="A real Lina Terminal demo workspace with separate project shell, test, file, and development server panes." /></a><figcaption><span>Your tools, side by side · example workspace</span><a href="/screenshots/workspace.png" target="_blank" rel="noreferrer">Full size <ArrowUpRight size={14} /></a></figcaption></figure>
  <section className="product-section" id="agent-catalog"><div className="section-heading"><p className="eyebrow">BRING YOUR FAVORITES</p><h2>There's room for your agent.</h2><p>Agent panes launch the tools installed on your machine. Connect through each tool's own account or provider setup, then work in the same local project.</p></div><div className="agent-catalog">{agents.map(agent => <article key={agent.name}><h3>{agent.name}</h3><p>{agent.detail}</p><code>{agent.command}</code></article>)}</div><p className="product-note">Install and sign in to the CLIs you want to use. Available tools and status detail vary by provider. Regular terminal panes work without an AI provider.</p></section>
  <section className="product-section"><div className="section-heading"><p className="eyebrow">THE WORKSPACE AROUND THE AGENTS</p><h2>The small things<br /><span>that keep you moving.</span></h2></div><div className="capability-grid">{tools.map(({ icon: Icon, title, text }) => <article key={title}><Icon size={23} strokeWidth={1.5} /><h3>{title}</h3><p>{text}</p></article>)}</div></section>
  <section className="product-details"><div><p className="eyebrow">YOUR PART OF THE LOOP</p><h2>Delegate the work.<br /><span>Stay involved.</span></h2><p>Lina gives your agents room to act while keeping their work visible. Choose the right tool for the task and inspect the outcome before moving on.</p></div><ul className="check-list"><li><Check size={18} />Watch commands and output in the actual terminal.</li><li><Check size={18} />See working, waiting, done, and failed states where supported.</li><li><Check size={18} />Use your own projects, tools, and provider accounts.</li><li><Check size={18} />Update the app when your sessions are ready.</li></ul></section>
  <div className="product-crosslink"><div><p>Set up your first project and session.</p><h2>Your next build starts here.</h2></div><a className="button button--secondary" href={`${REPOSITORY_URL}#quick-start`} target="_blank" rel="noreferrer">Read the quick start <ArrowUpRight size={16} /></a></div>
</div>;
