import type { WorkflowPanel } from "../types/marketing";

const panels: WorkflowPanel[] = [
  {
    agent: "Codex",
    role: "implementation",
    status: "running",
    lines: ["reading workspace", "writing the changes", "running checks"]
  },
  {
    agent: "Claude",
    role: "strategy",
    status: "reviewing",
    lines: ["checking product intent", "routing next task", "flagging edge cases"]
  },
  {
    agent: "Fusion",
    role: "orchestration",
    status: "syncing",
    lines: ["delegation active", "verifying in browser", "checking the result"]
  },
  {
    agent: "Local shell",
    role: "live shell",
    status: "attached",
    lines: ["interactive shell", "workspace scoped", "logs preserved"]
  }
];

export const TerminalWorkspace = () => (
  <div className="terminal-workspace" aria-label="Tiled local workspace preview">
    <div className="terminal-workspace__bar">
      <span />
      <span />
      <span />
      <strong>vibeTerminal.local</strong>
    </div>
    <div className="terminal-workspace__grid">
      {panels.map((panel) => (
        <section className="terminal-pane" key={panel.agent}>
          <header>
            <span>{panel.agent}</span>
            <small>{panel.status}</small>
          </header>
          <p className="terminal-pane__role">{panel.role}</p>
          <ul>
            {panel.lines.map((line) => (
              <li key={line}>
                <span>$</span> {line}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  </div>
);