import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Menu, X } from "lucide-react";
import { Logo } from "./Logo";

const links = [
  { href: "/agents", label: "Agents & workflow" },
  { href: "/orchestrator", label: "Orchestrator" },
  { href: "/voice", label: "Voice" },
  { href: "/fusion", label: "Fusion" },
  { href: "/open-fusion", label: "Open Fusion" },
  { href: "/docs", label: "Docs" },
  { href: "/pricing", label: "Pricing" }
];

export const Header = () => {
  const path = window.location.pathname.replace(/\/$/, "");
  const isDocs = path === "/docs" || path.startsWith("/docs/");
  const navigation = isDocs ? [{ href: "/docs", label: "Documentation" }, { href: "/agents", label: "Product" }, { href: "/pricing", label: "Pricing" }] : links;
  const [open, setOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape" && open) { setOpen(false); toggle.current?.focus(); }
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [open]);

  return <header className="site-header">
    <div className="header-inner">
      <div className="header-docs-brand"><Logo />{isDocs && <a className="header-docs-badge" href="/docs">Docs</a>}</div>
      <nav className="site-nav" aria-label="Primary navigation">
        {navigation.map(({ href, label }) => <a key={href} href={href} aria-current={path === href || (isDocs && href === "/docs") ? "page" : undefined}>{label}</a>)}
      </nav>
      <div className="header-actions">
        <a className="button button--small button--secondary header-cta" href="/#download">Download <ArrowUpRight size={15} /></a>
        <button ref={toggle} type="button" className="menu-toggle" aria-label={open ? "Close menu" : "Open menu"} aria-expanded={open} aria-controls="mobile-nav" onClick={() => setOpen(!open)}>
          {open ? <X size={22} /> : <Menu size={22} />}
        </button>
      </div>
    </div>
    <nav id="mobile-nav" className="mobile-nav" aria-label="Mobile navigation" hidden={!open}>
      {navigation.map(({ href, label }) => <a key={href} href={href} onClick={() => setOpen(false)}>{label}</a>)}
      <a href="/#download" onClick={() => setOpen(false)}>Download for Windows</a>
      <a href="/#waitlist" onClick={() => setOpen(false)}>Release updates</a>
    </nav>
  </header>;
};
