import { Fragment, useEffect, useLayoutEffect, useRef } from "react";
import { isSlashItemSelectable, type SlashMenu, type SlashMenuItem } from "./fusionSlashMenu";
import "./fusionCommandPalette.css";

export function FusionCommandPalette({ id, menu, activeIndex, onHighlight, onSelect, onBack, onClose, onRefresh }: {
  id: string;
  menu: SlashMenu;
  activeIndex: number;
  onHighlight: (index: number) => void;
  onSelect: (item: SlashMenuItem) => void;
  onBack?: () => void;
  onClose: () => void;
  onRefresh?: () => void;
}) {
  const activeRef = useRef<HTMLLIElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const pane = panel?.closest(".terminal-pane");
    const area = panel?.parentElement;
    if (!panel || !pane || !area || typeof ResizeObserver === "undefined") return;
    const resize = () => {
      const siblings = [...area.children].filter((child) => child !== panel);
      const occupied = siblings.reduce((height, child) => height + child.getBoundingClientRect().height, 0);
      const chrome = (pane.querySelector(".pane-header")?.getBoundingClientRect().height ?? 48)
        + (pane.querySelector(".oc-footer")?.getBoundingClientRect().height ?? 28)
        + (panel.querySelector(".fusion-palette-header")?.getBoundingClientRect().height ?? 54)
        + (panel.querySelector(".fusion-palette-footer")?.getBoundingClientRect().height ?? 30);
      const available = pane.getBoundingClientRect().height - occupied - chrome - 42;
      if (listRef.current) listRef.current.style.maxHeight = `${Math.max(48, Math.min(350, available))}px`;
    };
    const observer = new ResizeObserver(resize);
    observer.observe(pane);
    observer.observe(area);
    resize();
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, menu.items[activeIndex]?.key]);
  const count = menu.items.filter(isSlashItemSelectable).length;
  return (
    <div ref={panelRef} className="fusion-slash-panel fusion-command-palette" aria-label="Command palette">
      <div className="fusion-palette-header">
        {onBack && <button type="button" title="Back" aria-label="Back" onClick={onBack}>←</button>}
        <div className="fusion-palette-heading">
          <div className="fusion-slash-title">{menu.title || "Commands"}</div>
          <span className="fusion-palette-search-hint">Type to search · {count} option{count === 1 ? "" : "s"}</span>
        </div>
        {onRefresh && <button type="button" title="Refresh models" aria-label="Refresh models" onClick={onRefresh}>↻</button>}
        <button type="button" title="Close menu (Esc)" aria-label="Close menu" onClick={onClose}>×</button>
      </div>
      <ul ref={listRef} id={id} className="fusion-slash-menu" role="listbox" aria-label={menu.title || "Commands"}>
        {menu.items.map((item, index) => {
          const selectable = isSlashItemSelectable(item);
          const current = item.current || item.desc.endsWith(" · current");
          const section = item.section && item.section !== menu.items[index - 1]?.section;
          return <Fragment key={item.key}>
            {section && <li role="presentation" className="fusion-palette-section">{item.section}</li>}
            <li
              id={`${id}-${index}`}
              ref={index === activeIndex ? activeRef : undefined}
              role="option"
              aria-selected={selectable && index === activeIndex}
              aria-disabled={!selectable}
              className={`fusion-slash-item${selectable && index === activeIndex ? " is-active" : ""}${!selectable ? " is-disabled" : ""}`}
              onMouseMove={() => { if (selectable) onHighlight(index); }}
              onMouseDown={(event) => { event.preventDefault(); if (selectable) onSelect(item); }}
            >
              <span className="fusion-palette-copy">
                <span className="fusion-slash-name">{item.label}</span>
                <span className="fusion-slash-desc">{item.desc.replace(/ · current$/, "")}</span>
              </span>
              {current ? <span className="fusion-palette-current">✓ Current</span>
                : selectable && <span className="fusion-palette-action" aria-hidden="true">{item.fill !== undefined || item.command?.startsWith("__provider:") || item.command?.startsWith("__family:") ? "›" : "↵"}</span>}
            </li>
          </Fragment>;
        })}
        {!menu.items.length && <li role="presentation" className="fusion-palette-empty">{menu.emptyText || "No matches. Try another name or go back."}</li>}
      </ul>
      <div className="fusion-palette-footer"><span><kbd>↑</kbd><kbd>↓</kbd> navigate</span><span><kbd>Enter</kbd> select</span><span><kbd>Esc</kbd> {onBack ? "back" : "close"}</span></div>
    </div>
  );
}
