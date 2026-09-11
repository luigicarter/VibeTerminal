import { useState } from "react";
import { ArrowDown, ArrowRight, Check, Code2, MessageSquare, Route } from "lucide-react";

const requests = [
  { label: "Delegate a task", request: "Have Codex review the website changes.", destination: "Codex", work: "Website review", note: "The project and goal guide the selection of an agent conversation." },
  { label: "Check progress", request: "What is Claude working on in the API?", destination: "Claude", work: "Inspect current activity", note: "Lina reads the session's available activity and recent output." },
  { label: "Continue work", request: "Tell it to add tests for those changes.", destination: "Task owner", work: "Continue the conversation", note: "A related follow-up can return to the conversation that owns the work." }
];

export function OrchestratorFlow() {
  const [active, setActive] = useState(0);
  const request = requests[active];
  return <div className="workflow-visual">
    <div className="workflow-visual__top"><span>ONE WORKSPACE. A SHARED DIRECTION.</span><span className="demo-label">Routing illustration</span></div>
    <div className="workflow-controls" aria-label="Example requests">{requests.map((item,index) => <button type="button" key={item.label} aria-pressed={active === index} onClick={() => setActive(index)}>{item.label}</button>)}</div>
    <div className="flow-track" key={active}>
      <div className="flow-node flow-node--request"><span><MessageSquare size={17} /> YOU</span><p>“{request.request}”</p><small>Voice or text</small></div>
      <div className="flow-connector" aria-hidden="true"><ArrowRight size={20} /><ArrowDown size={20} /></div>
      <div className="flow-node flow-node--lina"><img src="/brand/lina-mark.svg" alt="" width="46" height="46" /><strong>Lina Orchestrator</strong><div><span>Understand</span><i /> <span>Select</span><i /><span>Route</span></div></div>
      <div className="flow-connector" aria-hidden="true"><ArrowRight size={20} /><ArrowDown size={20} /></div>
      <div className="flow-node flow-node--agent"><span><Code2 size={17} /> {request.destination}</span><strong>{request.work}</strong><small>In the project workspace</small></div>
    </div>
    <div className="flow-return"><Route size={15} /><span>Updates and questions come back to you.</span><Check size={15} /></div>
    <p className="workflow-visual__note" aria-live="polite">{request.note}</p>
  </div>;
}
