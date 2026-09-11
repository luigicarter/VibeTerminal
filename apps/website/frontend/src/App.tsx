import { lazy, Suspense, useEffect } from "react";
import { Header } from "./components/Header";
import { Logo } from "./components/Logo";
import { useLatestRelease } from "./hooks/useLatestRelease";
import { useWaitlist } from "./hooks/useWaitlist";
import { DownloadSection } from "./sections/DownloadSection";
import { FusionSection } from "./sections/FusionSection";
import { HeroSection } from "./sections/HeroSection";
import { OpenFusionSection } from "./sections/OpenFusionSection";
import { StackSection } from "./sections/StackSection";
import { WaitlistSection } from "./sections/WaitlistSection";
import { WorkflowSection } from "./sections/WorkflowSection";
import { REPOSITORY_URL } from "./services/releases";
import { OrchestratorSection } from "./sections/OrchestratorSection";
import { AgentsSection } from "./sections/AgentsSection";
import { VoiceSection } from "./sections/VoiceSection";
import { usePageMotion } from "./hooks/usePageMotion";
import { PricingSection } from "./sections/PricingSection";

const DocsPage = lazy(() => import("./docs/DocsPage").then(module => ({ default: module.DocsPage })));

export const App = () => {
  const path = window.location.pathname.replace(/\/+$/, "") || "/";
  const isDocsPage = path === "/docs" || path.startsWith("/docs/");
  const release = useLatestRelease(!isDocsPage);
  const waitlist = useWaitlist();
  usePageMotion(path);
  const isVoicePage = path === "/voice";
  const isPricingPage = path === "/pricing";
  const isFusionPage = path === "/fusion";
  const isOpenFusionPage = path === "/open-fusion";
  const isOrchestratorPage = path === "/orchestrator";
  const isAgentsPage = path === "/agents";
  useEffect(() => {
    if (isDocsPage) return;
    document.title = isPricingPage ? "Pricing — Lina Terminal" : isVoicePage ? "Voice — Hey Lina — Lina Terminal" : isOrchestratorPage ? "Orchestrator — Lina Terminal" : isAgentsPage ? "Agents & Workflows — Lina Terminal" : isFusionPage ? "Fusion — Lina Terminal" : isOpenFusionPage ? "Open Fusion — Lina Terminal" : "Lina Terminal — All your agents. One place to build.";
    const description = isFusionPage ? "Claude and Codex in one conversation. Fusion pairs planning, execution, and review inside Lina Terminal." : isOpenFusionPage ? "Choose a Brain and Executor from your connected providers. Open Fusion brings your models into one Lina Terminal conversation." : "Your terminals, coding agents, and projects, side by side. Download Lina Terminal for Windows.";
    document.querySelector('meta[name="description"]')?.setAttribute("content", isPricingPage ? "Compare Lina Terminal's Base, All Terminals, and Orchestrator plans. Pricing coming soon." : isVoicePage ? "Say Hey Lina. Use hands-free voice or push-to-talk to delegate tasks, inspect agents, and answer questions in Lina Terminal." : isOrchestratorPage ? "Talk to your workspace. Lina's Orchestrator routes tasks, inspects sessions, and connects your agents through voice and text." : isAgentsPage ? "Run coding agents side by side, pair planners with executors, and coordinate your local projects in Lina Terminal." : description);
  }, [isFusionPage, isOpenFusionPage, isOrchestratorPage, isAgentsPage, isVoicePage, isPricingPage, isDocsPage]);

  return <>
    <a className="skip-link" href="#main-content">Skip to content</a>
    <Header />
    <main id="main-content">
      {isDocsPage ? <Suspense fallback={<p className="section-shell" role="status" style={{ paddingBlock: 40 }}>Loading documentation…</p>}><DocsPage path={path} /></Suspense> : isPricingPage ? <PricingSection /> : isVoicePage ? <VoiceSection /> : isOrchestratorPage ? <OrchestratorSection /> : isAgentsPage ? <AgentsSection /> : isFusionPage ? <FusionSection /> : isOpenFusionPage ? <OpenFusionSection /> : <>
        <HeroSection release={release.data} />
        <WorkflowSection />
        <StackSection />
        <DownloadSection release={release.data} releaseError={release.error} />
        <WaitlistSection disabled={waitlist.status === "loading"} error={waitlist.error} result={waitlist.data} onSubmit={waitlist.submit} />
      </>}
    </main>
    <footer className="site-footer"><div className="footer-inner section-shell">
      <div className="footer-brand"><Logo /><span>A home for your next build.</span></div>
      <nav className="footer-links" aria-label="Footer navigation"><a href="/docs">Docs</a><a href="/pricing">Pricing</a><a href="/agents">Agents</a><a href="/orchestrator">Orchestrator</a><a href={REPOSITORY_URL} target="_blank" rel="noreferrer">GitHub</a><a href="/#waitlist">Updates</a></nav>
    </div></footer>
  </>;
};
