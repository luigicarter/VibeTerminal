import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ArrowUpRight, BookOpen, Check, ChevronDown, ChevronRight, Copy, Hash, Info, Lightbulb, List, Search, TriangleAlert, X } from 'lucide-react';
import { blockText, docGroups, docHref, docPages, searchDocs, type DocBlock } from './content';
import './docs.css';

function CodeBlock({ code, language }: { code: string; language: string }) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'error'>('idle');
  const timer = useRef<number>();
  useEffect(() => () => window.clearTimeout(timer.current), []);
  async function copy() {
    window.clearTimeout(timer.current);
    try { await navigator.clipboard.writeText(code); setStatus('copied'); }
    catch { setStatus('error'); }
    timer.current = window.setTimeout(() => setStatus('idle'), 3000);
  }
  return <div className="doc-code">
    <div className="doc-code__bar"><span>{language}</span><button type="button" onClick={() => void copy()} aria-label={`Copy ${language.toLowerCase()}`}>{status === 'copied' ? <Check size={14} /> : <Copy size={14} />}{status === 'copied' ? 'Copied' : 'Copy'}</button></div>
    <pre tabIndex={0} aria-label={language}><code>{code}</code></pre>
    <span className={status === 'error' ? 'doc-copy-error' : 'sr-only'} role="status">{status === 'error' ? 'Could not copy. Select the text and copy it manually.' : status === 'copied' ? 'Copied to clipboard.' : ''}</span>
  </div>;
}

function Block({ block }: { block: DocBlock }) {
  switch (block.type) {
    case 'paragraph': return <p>{block.text}</p>;
    case 'list': return <ul className="doc-list">{block.items.map(item => <li key={item}>{item}</li>)}</ul>;
    case 'steps': return <ol className="doc-steps">{block.items.map((item,index) => <li key={item.title}><span aria-hidden="true">{index + 1}</span><div><h3>{item.title}</h3><p>{item.text}</p></div></li>)}</ol>;
    case 'callout': {
      const Icon = block.tone === 'tip' ? Lightbulb : block.tone === 'important' ? TriangleAlert : Info;
      return <aside className={`doc-callout doc-callout--${block.tone}`}><Icon size={18} /><div><strong>{block.title}</strong><p>{block.text}</p></div></aside>;
    }
    case 'code': return <CodeBlock code={block.code} language={block.language} />;
    case 'table': return <div className="doc-table-scroll" role="region" aria-label={`${block.headers.join(', ')} reference`} tabIndex={0}><table className="doc-table"><thead><tr>{block.headers.map(header => <th scope="col" key={header}>{header}</th>)}</tr></thead><tbody>{block.rows.map((row,index) => <tr key={index}>{row.map((cell,column) => column === 0 ? <th scope="row" key={column}>{cell}</th> : <td key={column}>{cell}</td>)}</tr>)}</tbody></table></div>;
    case 'cards': return <div className="doc-link-grid">{block.items.map(item => <a href={item.href} key={item.href} {...(item.href.startsWith('https:') ? {target:'_blank',rel:'noreferrer'} : {})}><div><strong>{item.title}</strong><ArrowUpRight size={17} /></div><p>{item.text}</p></a>)}</div>;
    case 'image': return <figure className="doc-image"><a href={block.src} target="_blank" rel="noreferrer" aria-label={`Open full-size screenshot: ${block.alt}`}><img src={block.src} alt={block.alt} width="1440" height="920" loading="lazy" /></a><figcaption>{block.caption}<a href={block.src} target="_blank" rel="noreferrer">Full size <ArrowUpRight size={13} /></a></figcaption></figure>;
  }
}

export function DocsPage({ path }: { path: string }) {
  const slug = path.replace(/^\/docs\/?/, '').replace(/\/$/, '');
  const page = docPages.find(item => item.slug === slug);
  const [query, setQuery] = useState('');
  const [mobileOpen, setMobileOpen] = useState(false);
  const [activeSection, setActiveSection] = useState(page?.sections[0]?.id || '');
  const searchInput = useRef<HTMLInputElement>(null);
  const mobileToggle = useRef<HTMLButtonElement>(null);
  const results = useMemo(() => searchDocs(query), [query]);
  const orderedPages = docGroups.flatMap(group => docPages.filter(item => item.group === group));
  const pageIndex = orderedPages.findIndex(item => item.slug === slug);
  const previous = pageIndex > 0 ? orderedPages[pageIndex - 1] : null;
  const next = pageIndex >= 0 ? orderedPages[pageIndex + 1] : null;
  const wordCount = page?.sections.reduce((sum, section) => sum + section.blocks.map(blockText).join(' ').split(/\s+/).length, 0) || 0;
  useEffect(() => {
    document.title = `${page?.title || 'Page not found'} — Lina Terminal Docs`;
    document.querySelector('meta[name="description"]')?.setAttribute('content', page?.description || 'Find help in the Lina Terminal documentation.');
  }, [page]);
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'k') {
        event.preventDefault(); setMobileOpen(true);
        requestAnimationFrame(() => searchInput.current?.focus());
      }
      if (event.key === 'Escape') {
        if (query) setQuery('');
        else if (mobileOpen) { setMobileOpen(false); mobileToggle.current?.focus(); }
      }
    };
    document.addEventListener('keydown', keyboard);
    return () => document.removeEventListener('keydown', keyboard);
  }, [query, mobileOpen]);
  useEffect(() => {
    if (!page) return;
    let hashFrame = 0;
    if (window.location.hash) {
      try {
        const target = decodeURIComponent(window.location.hash.slice(1));
        if (page.sections.some(section => section.id === target)) hashFrame = requestAnimationFrame(() => document.getElementById(target)?.scrollIntoView({ behavior: 'auto' }));
      } catch { /* An invalid hash must not prevent the guide from loading. */ }
    }
    let frame = 0;
    const update = () => {
      frame = 0;
      let current = page.sections[0]?.id || '';
      for (const section of page.sections) {
        const element = document.getElementById(section.id);
        if (element && element.getBoundingClientRect().top <= 160) current = section.id;
      }
      setActiveSection(current);
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(update); };
    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => { window.removeEventListener('scroll', onScroll); cancelAnimationFrame(frame); cancelAnimationFrame(hashFrame); };
  }, [page]);

  return <div className="docs-layout">
    <div className="docs-mobile-bar"><button ref={mobileToggle} type="button" aria-expanded={mobileOpen} aria-controls="docs-sidebar" onClick={() => setMobileOpen(value => !value)}>{mobileOpen ? <X size={17} /> : <List size={17} />}Documentation<ChevronDown size={14} /></button><span>{page?.title || 'Page not found'}</span></div>
    <aside id="docs-sidebar" className={`docs-sidebar${mobileOpen ? ' is-open' : ''}`}>
      <a href="/docs" className="docs-sidebar__title"><BookOpen size={17} />Documentation</a>
      <div className="docs-search"><Search size={16} /><input ref={searchInput} type="search" aria-label="Search documentation" aria-describedby="docs-search-help" placeholder="Search docs…" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => {
        if (event.key === 'Enter' && results[0]) {
          event.preventDefault(); const first = results[0]; window.location.assign(docHref(first.page.slug) + (first.section ? `#${first.section.id}` : ''));
        }
      }} /><kbd aria-hidden="true">⌃ K</kbd></div>
      <span id="docs-search-help" className="sr-only">Search all guides. Press Enter to open the first result. Control or Command K focuses search.</span>
      {query.trim() ? <div className="docs-results"><p role="status">{results.length} {results.length === 1 ? 'guide' : 'guides'} found</p>{results.length ? results.map(result => <a key={result.page.slug} href={docHref(result.page.slug) + (result.section ? `#${result.section.id}` : '')} onClick={() => setMobileOpen(false)}><strong>{result.page.title}</strong><span>{result.excerpt}</span><small>{result.page.group}<ArrowUpRight size={12} /></small></a>) : <div className="docs-empty"><p>No matches for “{query}”.</p><span>Try a topic like voice, models, or resume.</span></div>}<button type="button" onClick={() => { setQuery(''); searchInput.current?.focus(); }}>Clear search</button></div> : <nav aria-label="Documentation guides">{docGroups.map(group => <div className="docs-nav-group" key={group}><h2>{group}</h2>{docPages.filter(item => item.group === group).map(item => <a key={item.slug} href={docHref(item.slug)} aria-current={page?.slug === item.slug ? 'page' : undefined} onClick={() => setMobileOpen(false)}>{item.title}{page?.slug === item.slug && <ChevronRight size={13} />}</a>)}</div>)}</nav>}
      <a className="docs-sidebar__help" href="https://github.com/luigicarter/VibeTerminal/issues" target="_blank" rel="noreferrer">Get help on GitHub <ArrowUpRight size={14} /></a>
    </aside>

    {page ? <>
      <article className="docs-article" id="docs-article">
        <nav className="docs-breadcrumb" aria-label="Breadcrumb"><a href="/docs">Docs</a><ChevronRight size={12} /><span>{page.group}</span></nav>
        <header className="docs-article__header"><div><span className="docs-guide-label">USER GUIDE</span><span>{Math.max(1,Math.ceil(wordCount / 200))} min read</span></div><h1>{page.title}</h1><p>{page.description}</p></header>
        <details className="docs-mobile-toc"><summary>On this page<ChevronDown size={14} /></summary><nav aria-label="On this page, mobile">{page.sections.map(section => <a href={`#${section.id}`} key={section.id}>{section.title}</a>)}</nav></details>
        <div className="docs-prose">{page.sections.map(section => <section id={section.id} key={section.id} className="doc-section"><h2>{section.title}<a href={`#${section.id}`} className="doc-heading-anchor" aria-label={`Link to ${section.title}`}><Hash size={17} /></a></h2>{section.blocks.map((block,index) => <Block key={index} block={block} />)}</section>)}</div>
        <nav className="docs-pagination" aria-label="Guide navigation">{previous ? <a href={docHref(previous.slug)}><span><ArrowLeft size={14} /> Previous</span><strong>{previous.title}</strong></a> : <span />}{next && <a href={docHref(next.slug)}><span>Next <ArrowRight size={14} /></span><strong>{next.title}</strong></a>}</nav>
        <div className="docs-article__footer"><span>Lina Terminal documentation</span><a href="https://github.com/luigicarter/VibeTerminal/issues" target="_blank" rel="noreferrer">Report a docs issue <ArrowUpRight size={13} /></a></div>
      </article>
      <aside className="docs-toc"><p>On this page</p><nav aria-label="On this page">{page.sections.map(section => <a key={section.id} href={`#${section.id}`} aria-current={activeSection === section.id ? 'location' : undefined}>{section.title}</a>)}</nav><div className="docs-toc__help"><BookOpen size={17} /><strong>Just getting started?</strong><p>Open your first project and terminal.</p><a href="/docs/quick-start">Follow the quick start <ArrowRight size={13} /></a></div></aside>
    </> : <article className="docs-article docs-not-found"><span className="docs-guide-label">404</span><h1>Guide not found.</h1><p>Choose a guide in the sidebar, or search the documentation for the topic you need.</p><a className="button button--secondary" href="/docs"><ArrowLeft size={16} />Back to introduction</a></article>}
  </div>;
}
