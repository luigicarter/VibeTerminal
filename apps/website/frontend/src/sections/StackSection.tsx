import { ArrowUpRight, Monitor, RefreshCw, SquareTerminal } from "lucide-react";
import { REPOSITORY_URL } from "../services/releases";

const items = [
  { icon: SquareTerminal, title: "Real terminals. Local files.", text: "Use your installed CLIs and project folders. Keep your shell, commands, and development tools close at hand." },
  { icon: Monitor, title: "Built for your desktop.", text: "A Windows workspace for Codex, Claude, Cursor, Gemini, OpenCode, Kimi, Qwen, and regular terminals." },
  { icon: RefreshCw, title: "Updates on your terms.", text: "Lina checks for new releases. You choose when to download and restart, once your sessions are ready." }
];

export const StackSection = () => <section className="platform-band" id="stack"><div className="section-shell platform-layout">
  <div className="section-heading"><p className="eyebrow"><span>03 /</span> AT HOME ON YOUR MACHINE</p><h2>Your tools.<br /><span>Your territory.</span></h2><p>Keep the workflow you know. Give it a better home.</p><a className="text-link" href={REPOSITORY_URL} target="_blank" rel="noreferrer">Explore the project on GitHub <ArrowUpRight size={16} /></a></div>
  <div className="platform-list">{items.map(({ icon: Icon, title, text }) => <article key={title}><Icon size={22} strokeWidth={1.5} /><div><h3>{title}</h3><p>{text}</p></div></article>)}</div>
</div></section>;
