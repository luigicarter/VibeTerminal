import { ArrowUpRight, Download, Monitor } from "lucide-react";
import type { LatestRelease } from "../types/api";
import { releaseLinks } from "../services/releases";

export const DownloadSection = ({ release, releaseError }: { release: LatestRelease | null; releaseError: string | null }) => {
  const { downloadUrl, hasInstaller, notesUrl } = releaseLinks(release);
  return <section className="download-section section-shell" id="download">
    <div className="download-card">
      <div><p className="eyebrow"><span className="status-dot" /> READY WHEN YOU ARE</p><h2>Make room for<br /><span>your next big idea.</span></h2><p>Bring your projects. Bring your agents. Start building with Lina.</p><div className="download-actions"><a className="button button--primary" href={downloadUrl}><Download size={18} />{hasInstaller ? "Download for Windows" : "Get Lina for Windows"}</a><a className="text-link" href={notesUrl} target="_blank" rel="noreferrer">Release notes <ArrowUpRight size={16} /></a></div></div>
      <div className="download-spec"><Monitor size={30} strokeWidth={1.3} /><strong>Windows</strong><span>x64 desktop installer</span><div className="download-version">{release?.tagName ?? "Latest release"}<span className="status-dot" /></div><p>{releaseError ? "View the latest download on GitHub." : release?.publishedAt ? `Released ${new Date(release.publishedAt).toLocaleDateString("en", { month: "short", day: "numeric", year: "numeric" })}` : "Available on GitHub Releases"}</p></div>
    </div>
    <p className="download-note">Agent panes use your installed command-line tools and provider accounts. Provider usage may have its own costs.</p>
  </section>;
};
