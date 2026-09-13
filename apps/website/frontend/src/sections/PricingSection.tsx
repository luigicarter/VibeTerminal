import { ArrowUpRight, Check, Layers3, Route } from "lucide-react";

const plans = [
  {
    id: "full-access",
    name: "Full Access",
    eyebrow: "THE FULL TERMINAL TOOLKIT",
    icon: Layers3,
    description: "Every terminal and agent mode, with the complete workspace to make them your own.",
    includes: "The full workspace and all agent modes",
    features: [
      "Local terminals, projects, and flexible pane layouts",
      "Multi mode, Git branches, and change summaries",
      "Fusion and Open Fusion",
      "Codex, Open Codex, and Codex Web",
      "Claude, Cursor, Gemini, and every supported agent",
      "Your providers, accounts, and model choices"
    ],
    link: "/agents#agent-catalog",
    linkLabel: "Meet the agent workflows"
  },
  {
    id: "orchestrator",
    name: "Orchestrator",
    eyebrow: "THE CONNECTED WORKSPACE",
    icon: Route,
    description: "Bring your agents together with a workspace you can talk to.",
    includes: "Everything in Full Access, plus",
    features: [
      "The workspace-wide Orchestrator",
      "Task routing and agent assignment",
      "Voice and text instructions",
      "Hey Lina and push-to-talk",
      "Agent question and answer follow-ups",
      "Live session dashboard and work history"
    ],
    link: "/orchestrator",
    linkLabel: "Explore the Orchestrator"
  }
];

export const PricingSection = () => <div className="pricing-page section-shell" id="top">
  <section className="pricing-heading section-heading">
    <p className="eyebrow">PRICING</p>
    <h1>Your workspace.<br /><span>Your way to build.</span></h1>
    <p>Two plans. Every terminal and agent mode in both.<br className="desktop-break" /> Choose Orchestrator to add voice and task coordination.</p>
    <span className="pricing-preview-label">Plan preview · prices coming soon</span>
  </section>
  <section className="pricing-grid" aria-label="Lina Terminal plans">
    {plans.map((plan, index) => <article className={`pricing-card ${plan.id === "orchestrator" ? "pricing-card--complete" : ""}`} key={plan.id} aria-labelledby={`plan-${plan.id}`}>
      <div className="pricing-card__top"><span className="pricing-card__icon"><plan.icon size={23} strokeWidth={1.5} /></span><span className="pricing-card__edition">{index === 0 ? "YOUR WORKSPACE" : "YOUR WORKSPACE + LINA"}</span></div>
      <p className="pricing-card__eyebrow">{plan.eyebrow}</p>
      <h2 id={`plan-${plan.id}`}>{plan.name}</h2>
      <p className="pricing-card__description">{plan.description}</p>
      <div className="pricing-card__price"><strong>Coming soon</strong><span>Pricing to be announced</span></div>
      <a className={`button ${plan.id === "orchestrator" ? "button--primary" : "button--secondary"}`} href="/#waitlist">Get pricing updates <ArrowUpRight size={16} /></a>
      <div className="pricing-card__features"><h3>{plan.includes}</h3><ul>{plan.features.map(feature => <li key={feature}><Check size={16} strokeWidth={1.6} /><span>{feature}</span></li>)}</ul></div>
      <a className="text-link pricing-card__learn" href={plan.link}>{plan.linkLabel} <ArrowUpRight size={15} /></a>
    </article>)}
  </section>
  <div className="pricing-notes">
    <p>AI provider accounts, subscriptions, and usage are separate. Bring the accounts or API keys required by your chosen tools.</p>
    <p>These are upcoming plan options. Prices and billing details will be announced before plans become available.</p>
  </div>
</div>;
