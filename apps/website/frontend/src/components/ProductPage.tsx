import { ArrowLeft, ArrowUpRight, Check, Download } from "lucide-react";

const fusionSteps = [
  { title: "Make a plan.", text: "The planner reads your goal and the workspace, works through the approach, and decides what to hand off." },
  { title: "Put it to work.", text: "The executor makes changes, runs commands, and checks the result. You can follow the work in one conversation." },
  { title: "Review. Refine. Finish.", text: "The planner reviews the evidence and requests another pass when needed before reporting the result back to you." }
];
const openSteps = [
  { title: "Connect your providers.", text: "Add your provider credentials inside Lina. Open Fusion keeps its own configuration, separate from your global OpenCode setup." },
  { title: "Choose your pair.", text: "Pick a Brain to plan and review, and an Executor to make changes and run tests. Choose from your connected providers' models." },
  { title: "Build in one conversation.", text: "Give the Brain your goal. It directs the Executor, reviews the work, and keeps the conversation together as you steer." }
];

export const ProductPage = ({ mode }: { mode: "fusion" | "open-fusion" }) => {
  const open = mode === "open-fusion";
  const name = open ? "Open Fusion" : "Fusion";
  return <div className={`product-page section-shell ${open ? "product-page--open" : ""}`} id="top">
    <a className="breadcrumb" href="/"><ArrowLeft size={15} /> Back to Lina Terminal</a>
    <section className="product-hero">
      <p className="eyebrow"><span>{open ? "YOUR MODELS. YOUR PAIR." : "CLAUDE + CODEX"}</span> / {name.toUpperCase()}</p>
      <h1>{open ? <>Your choice of models.<br /><span>One way to build.</span></> : <>Two minds.<br /><span>One coding teammate.</span></>}</h1>
      <p>{open ? "Bring the models you like working with. Choose a Brain to plan and review, and an Executor to build and test, all in a single Lina Terminal conversation." : "Fusion brings Claude and Codex into one conversation. One agent plans and reviews. Another writes code, runs commands, and checks the work. You steer the whole task."}</p>
      <div className="hero__actions"><a className="button button--primary" href="/#download"><Download size={17} />Get Lina Terminal</a><a className="button button--quiet" href={open ? "/fusion" : "/open-fusion"}>{open ? "Explore Fusion" : "Choose your own models"} <ArrowUpRight size={16} /></a></div>
    </section>
    <figure className="product-shot"><a href={`/screenshots/${mode}.png`} target="_blank" rel="noreferrer"><img src={`/screenshots/${mode}.png`} width="1440" height="920" alt={`${name} inside Lina Terminal, showing its conversation pane and model controls.`} /></a><figcaption><span>{name} inside Lina Terminal · example workspace</span><a href={`/screenshots/${mode}.png`} target="_blank" rel="noreferrer">Full size <ArrowUpRight size={14} /></a></figcaption></figure>
    <section className="product-section">
      <div className="section-heading"><p className="eyebrow">HOW IT WORKS</p><h2>{open ? "Pick the pair. Set the direction." : "From idea to a reviewed result."}</h2></div>
      <div className="process-grid">{(open ? openSteps : fusionSteps).map((step, index) => <article className="process-step" key={step.title}><span>0{index + 1} /</span><h3>{step.title}</h3><p>{step.text}</p></article>)}</div>
    </section>
    <section className="product-details"><div><p className="eyebrow">YOU STAY IN THE LOOP</p><h2>A clear role<br /><span>for each agent.</span></h2><p>{open ? "Open Fusion gives you flexibility across providers. Connect a provider and choose both models to start; there is no default pair selected for you." : "Use your existing Claude and Codex accounts. The default pairing puts Claude on planning and Codex on execution; you can choose the model family for each role."}</p></div>
      <ul className="check-list"><li><Check size={18} />A read-only planner focused on the approach and review.</li><li><Check size={18} />An executor that makes changes and runs checks.</li><li><Check size={18} />In-pane permission requests when approval is needed.</li><li><Check size={18} />Interrupt or send a follow-up as the task develops.</li></ul>
    </section>
    {open && <section className="product-section"><div className="section-heading"><p className="eyebrow">FIND YOUR FIT</p><h2>Fusion or Open Fusion?</h2></div><div className="comparison-wrap" role="region" aria-label="Fusion comparison" tabIndex={0}><table className="comparison-table"><thead><tr><th scope="col">Your workflow</th><th scope="col">Fusion</th><th scope="col">Open Fusion</th></tr></thead><tbody>
      <tr><th scope="row">The pair</th><td>Claude and Codex coding agents</td><td>Two models from your connected providers</td></tr>
      <tr><th scope="row">Model choice</th><td>Choose the family and model for each role</td><td>Choose a Brain and Executor across providers</td></tr>
      <tr><th scope="row">Connection</th><td>Your Claude and Codex accounts</td><td>Provider credentials connected inside Lina</td></tr>
      <tr><th scope="row">A good fit for</th><td>Working with the Claude and Codex agent pair</td><td>Experimenting with your preferred model combinations</td></tr>
      <tr><th scope="row">Shared workflow</th><td>Plan, build, and review in one chat</td><td>Plan, build, and review in one chat</td></tr>
    </tbody></table></div></section>}
    <div className="product-crosslink"><div><p>{open ? "Prefer the Claude and Codex pair?" : "Have a different pair in mind?"}</p><h2>{open ? "Get to know Fusion." : "Make it Open Fusion."}</h2></div><a className="button button--secondary" href={open ? "/fusion" : "/open-fusion"}>Explore {open ? "Fusion" : "Open Fusion"} <ArrowUpRight size={16} /></a></div>
  </div>;
};
