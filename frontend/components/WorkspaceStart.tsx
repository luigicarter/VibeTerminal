import { ArrowUpRight, Bot, FolderOpen, FolderPlus, Layers3, TerminalSquare } from "lucide-react";
import type { AgentKind } from "../types";
import "./workspaceStart.css";

const descriptions: Record<AgentKind, string> = {
  terminal: "Your local shell",
  codex: "OpenAI coding agent",
  claude: "Claude Code",
  "claude-custom": "Claude with your provider",
  fusion: "Claude + Codex chat",
  openfusion: "Chat with two chosen models",
  cursor: "Cursor coding agent",
  gemini: "Gemini CLI",
  opencode: "OpenCode agent",
  kimi: "Kimi Code",
  "kimi-custom": "Custom Kimi setup",
  qwen: "Qwen Code"
};

export function WorkspaceStart({ profiles, mode, projectName, projectPath, canLaunch, isMissing, onLaunch, onNewProject, onOpenProject, onMultiMode }: {
  profiles: { kind: AgentKind; label: string }[];
  mode: "project" | "multi";
  projectName?: string;
  projectPath?: string;
  canLaunch: boolean;
  isMissing(kind: AgentKind): boolean;
  onLaunch(kind: AgentKind): void;
  onNewProject(): void;
  onOpenProject(): void;
  onMultiMode(): void;
}) {
  return <div className="workspace-start">
    <header className="workspace-start-heading">
      <h2>{canLaunch ? "Start a session" : "Open your workspace"}</h2>
      <p>{canLaunch
        ? mode === "multi" ? "Choose a terminal or agent, then select its working folder." : "Choose a terminal or coding agent for this project."
        : "Open a project folder, create a new one, or work across folders in Multi mode."}</p>
      {canLaunch && projectPath && mode === "project" && <div className="workspace-start-location" title={projectPath}><FolderOpen size={14}/><strong>{projectName}</strong><span>{projectPath}</span></div>}
    </header>
    {canLaunch ? <div className="session-launch-grid" aria-label="Choose a terminal or agent">
      {profiles.map(profile => {
        const Icon = profile.kind === "terminal" ? TerminalSquare : profile.kind === "fusion" || profile.kind === "openfusion" ? Layers3 : Bot;
        const missing = isMissing(profile.kind);
        return <button key={profile.kind} type="button" className={`session-launch-card${missing ? " tool-unavailable" : ""}`} data-launcher-kind={profile.kind}
          title={missing ? `${profile.label} was not detected. You can still try launching it in your shell.` : `Start ${profile.label}`}
          onClick={() => onLaunch(profile.kind)}>
          <span className="session-launch-icon"><Icon size={19}/></span>
          <span className="session-launch-copy"><strong>{profile.label}</strong><span>{descriptions[profile.kind]}</span></span>
          {missing ? <small>Not detected</small> : <ArrowUpRight className="session-launch-arrow" size={15}/>}
        </button>;
      })}
    </div> : <div className="workspace-start-projects">
      <button type="button" onClick={onOpenProject}><FolderOpen size={22}/><strong>Open project</strong><span>Choose an existing folder</span><ArrowUpRight size={16}/></button>
      <button type="button" onClick={onNewProject}><FolderPlus size={22}/><strong>New project</strong><span>Create a folder in Documents</span><ArrowUpRight size={16}/></button>
      <button type="button" onClick={onMultiMode}><Layers3 size={22}/><strong>Multi mode</strong><span>Choose a folder for each session</span><ArrowUpRight size={16}/></button>
    </div>}
  </div>;
}
