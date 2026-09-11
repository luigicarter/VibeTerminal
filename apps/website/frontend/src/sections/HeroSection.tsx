import { ArrowDown, ArrowUpRight, Download } from "lucide-react";
import { ScreenshotGallery } from "../components/ScreenshotGallery";
import type { LatestRelease } from "../types/api";
import { releaseLinks } from "../services/releases";

export const HeroSection = ({ release }: { release: LatestRelease | null }) => {
  const { downloadUrl, hasInstaller } = releaseLinks(release);
  return <section className="hero section-shell" id="top">
    <div className="hero__copy">
      <a className="release-badge" href="/#download"><span className="status-dot" /> {release?.tagName ? `${release.tagName} is available` : "Available for Windows"}<ArrowUpRight size={14} /></a>
      <h1>All your agents.<br /><span>One place to build.</span></h1>
      <p className="hero__lede">Your terminals, coding agents, and projects, side by side.<br className="desktop-break" /> Meet Lina Terminal. A little less switching. A lot more building.</p>
      <div className="hero__actions">
        <a className="button button--primary" href={downloadUrl}><Download size={18} />{hasInstaller ? "Download for Windows" : "Get Lina for Windows"}</a>
        <a className="button button--quiet" href="#workspace-preview">Explore the workspace <ArrowDown size={17} /></a>
      </div>
      <p className="hero__note">Windows x64 <span>·</span> Your local projects <span>·</span> Your favorite agents</p>
    </div>
    <ScreenshotGallery />
    <div className="agent-strip">
      <p>A home for the tools you already use <a className="agent-strip-link" href="/agents">Explore all agents <ArrowUpRight size={13} /></a></p>
      <div><span className="agent-name"><span className="agent-symbol">✳</span> Claude</span><span className="agent-name"><span className="agent-symbol">⌘</span> Codex</span><span className="agent-name"><span className="agent-symbol">↗</span> Cursor</span><span className="agent-name"><span className="agent-symbol">✦</span> Gemini</span><span className="agent-name"><span className="agent-symbol">&gt;_</span> OpenCode</span><span className="agent-more">and more</span></div>
    </div>
  </section>;
};
