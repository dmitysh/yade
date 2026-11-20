import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Ide";

export interface GitMenuItem { label: string; icon?: string; shortcut?: string; disabled?: boolean; run: () => void }

export default function GitMenu({ label, items, children, disabled = false, icon = "more", contextOnly = false, className = "", contextWhen }: { label: string; items: GitMenuItem[]; children?: ReactNode; disabled?: boolean; icon?: string; contextOnly?: boolean; className?: string; contextWhen?: (target: EventTarget) => boolean }) {
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const menu = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const scope = useRef<HTMLDivElement>(null);
  const restore = useRef<HTMLElement | null>(null);
  function show(x: number, y: number) {
    if (disabled) return;
    restore.current = document.activeElement as HTMLElement;
    setPosition({ x, y });
  }
  function close(focus = false) { setPosition(null); if (focus) restore.current?.focus(); }
  useEffect(() => { if (disabled) setPosition(null); }, [disabled]);
  useEffect(() => {
    if (!position) return;
    const root = menu.current!;
    const anchor = trigger.current ?? scope.current?.querySelector("button");
    if (anchor) {
      const style = getComputedStyle(anchor);
      root.style.fontFamily = style.fontFamily;
      root.style.fontSize = `${parseFloat(style.fontSize) * (anchor.getBoundingClientRect().height / (anchor.offsetHeight || 1) || 1)}px`;
    }
    const bounds = root.getBoundingClientRect();
    root.style.left = `${Math.max(8, Math.min(position.x, window.innerWidth - bounds.width - 8))}px`;
    root.style.top = `${Math.max(8, Math.min(position.y, window.innerHeight - bounds.height - 8))}px`;
    root.querySelector<HTMLElement>('button:not(:disabled)')?.focus();
    function outside(event: PointerEvent) { if (!root.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) close(); }
    function resize() { close(); }
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", resize);
    return () => { document.removeEventListener("pointerdown", outside); window.removeEventListener("resize", resize); };
  }, [position]);
  return <div ref={scope} className={`git-menu-scope ${className}`} onContextMenu={event => {
    if (event.defaultPrevented || contextWhen?.(event.target) === false) return;
    event.preventDefault(); show(event.clientX, event.clientY);
  }} onKeyDown={event => {
    if (!event.defaultPrevented && (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) && contextWhen?.(event.target) !== false) {
      event.preventDefault(); const bounds = event.currentTarget.getBoundingClientRect(); show(bounds.left + 20, bounds.bottom);
    }
  }}>
    {children}{!contextOnly && <button ref={trigger} type="button" className="ide-icon-button git-menu-trigger" aria-label={label} title={label} disabled={disabled} aria-haspopup="menu" aria-expanded={!!position}
      onClick={event => { if (position) close(true); else { const bounds = event.currentTarget.getBoundingClientRect(); show(bounds.left, bounds.bottom + 4); } }}><Icon name={icon} /></button>}
    {position && createPortal(<div className="git-action-menu" role="menu" aria-label={label} ref={menu} style={{ left: position.x, top: position.y }} onBlur={event => {
      if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) close();
    }} onKeyDown={event => {
      event.stopPropagation();
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); return; }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      buttons[event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
    }}>{items.map(item => <button type="button" role="menuitem" key={item.label} disabled={item.disabled} onClick={() => { close(true); item.run(); }}>{item.icon && <Icon name={item.icon} />}<span>{item.label}</span>{item.shortcut && <small className="git-menu-shortcut" aria-hidden="true">{item.shortcut}</small>}</button>)}</div>, document.body)}
  </div>;
}
