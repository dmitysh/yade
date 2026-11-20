import { useEffect, useRef, useState } from "react";
import type { PointerEvent, ReactNode } from "react";
import "./ide.css";

export function Icon({ name }: { name: string }) {
  const paths: Record<string, ReactNode> = {
    project: <><path d="M3 6h6l2 2h10v12H3z" /><path d="M3 6V4h7l2 2h7v2" /></>,
    search: <><circle cx="10" cy="10" r="6" /><path d="m15 15 6 6" /></>,
    git: <><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="5" r="2" /><path d="M6 7v10M18 7c0 7-12 3-12 10" /></>,
    commit: <><circle cx="12" cy="12" r="4" /><path d="M3 12h5m8 0h5" /></>,
    terminal: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 3 3-3 3m6 0h4" /></>,
    prompt: <path d="m4 5 6 7-6 7m10 0h7" />,
    "arrow-right": <path d="M4 12h16m-6-6 6 6-6 6" />,
    "arrow-left": <path d="M20 12H4m6-6-6 6 6 6" />,
    chat: <><path d="M3 3h15v12H8l-5 4z" /><path d="M8 18h8l5 4V9" /></>,
    settings: <><path d="m9 3 .5-1h5l.5 3 2 1 3-1 2 4-2 2v2l2 2-2 4-3-1-2 1-.5 3h-5L9 19l-2-1-3 1-2-4 2-2v-2L2 9l2-4 3 1 2-1z" /><circle cx="12" cy="12" r="3" /></>,
    play: <path d="m8 4 12 8-12 8z" />,
    chevron: <path d="m9 5 7 7-7 7" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    check: <path d="m5 12 4 4L19 6" />,
    plus: <path d="M12 5v14M5 12h14" />,
    trash: <><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7" /></>,
    send: <><path d="m5 12 7-7 7 7M12 5v15" /></>,
    stop: <rect x="6" y="6" width="12" height="12" rx="1" fill="currentColor" stroke="none" />,
    star: <path d="m12 3 2.8 5.7 6.3.9-4.5 4.4 1.1 6.2-5.7-3-5.7 3 1.1-6.2L3.2 9.6l6-.9z" />,
    sort: <><path d="M4 3v18m-3-3 3 3 3-3M11 5h10M11 10h7M11 15h4" /></>,
    more: <><circle cx="5" cy="12" r=".7" /><circle cx="12" cy="12" r=".7" /><circle cx="19" cy="12" r=".7" /></>,
    keyboard: <><rect x="2" y="5" width="20" height="14" rx="2" /><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01M7 16h10" /></>,
    bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" /></>,
    file: <><path d="M14 3H5v18h14V8zM14 3v5h5M8 12h8M8 16h6" /></>,
    overview: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>,
    activity: <path d="M3 12h4l3-9 4 18 3-9h4" />,
    layers: <><path d="m12 3 10 5-10 5L2 8zM2 12l10 5 10-5M2 16l10 5 10-5" /></>,
    layout: <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M9 9v12" /></>,
    history: <><path d="M3 3v6h6M3 9a9 9 0 1 1 0 6M12 7v5l3 2" /></>,
    refresh: <><path d="M20 4v6h-6M4 20v-6h6M4 9a8 8 0 0 1 13-5l3 3M4 17l3 3a8 8 0 0 0 13-5" /></>,
    download: <path d="M12 4v15m-6-6 6 6 6-6" />,
    minus: <path d="M5 12h14" />,
    copy: <><rect x="8" y="8" width="12" height="13" rx="2" /><path d="M15 8V3H3v13h5" /></>,
    edit: <><path d="m4 16 12-12 4 4L8 20H4zM13 7l4 4" /></>,
    cloud: <path d="M6 18a5 5 0 0 1-1-10 6 6 0 0 1 11-2 5 5 0 0 1 2 12Z" />,
    tag: <><path d="m3 3 9 0 9 9-9 9-9-9z" /><circle cx="8" cy="8" r="1" /></>,
    attachment: <path d="m8 13 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l9-9a2 2 0 0 1 3 3l-9 9a1 1 0 0 0 2 2l8-8" />,
    sliders: <><path d="M3 6h7m4 0h7M3 12h12m4 0h2M3 18h3m4 0h11M10 3v6m5 0v6M6 15v6" /></>,
    effort: <path d="M5 20v-6m7 6V8m7 12V2" />,
    bolt: <path d="m13 2-9 12h7l-1 8 10-13h-7z" />,
    brain: <><path d="M12 5a3 3 0 0 0-6-1 4 4 0 0 0-3 6 4 4 0 0 0 1 7 4 4 0 0 0 8 2V5Zm0 0a3 3 0 0 1 6-1 4 4 0 0 1 3 6 4 4 0 0 1-1 7 4 4 0 0 1-8 2" /><path d="M6 4v4m12-4v4M4 17h3m13 0h-3" /></>,
    sparkles: <path d="m10 3 2 6 6 2-6 2-2 6-2-6-6-2 6-2zM19 2v4m-2-2h4m-2 13v4m-2-2h4" />,
    shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z" /><path d="m8 12 3 3 5-6" /></>,
    plug: <><path d="M8 2v6m8-6v6M6 8h12v4a6 6 0 0 1-12 0zm6 10v4" /></>,
    info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6m0-10v.01" /></>,
    palette: <><path d="M12 3a9 9 0 1 0 0 18h1a2 2 0 0 0 1-3.7 1.5 1.5 0 0 1 1-2.8h2a4 4 0 0 0 4-4A8 8 0 0 0 12 3Z" /><circle cx="7.5" cy="10" r=".7" /><circle cx="10" cy="6.5" r=".7" /><circle cx="15" cy="7" r=".7" /></>,
    monitor: <><rect x="3" y="3" width="18" height="13" rx="2" /><path d="M12 16v5m-4 0h8" /></>,
  };
  return <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] ?? paths.project}</svg>;
}

export function Splitter({ label, vertical = false, reverse = vertical, value, change, finish, min, max }: {
  label: string; vertical?: boolean; reverse?: boolean; value: number; change: (size: number) => void;
  finish?: (size: number) => void; min: number; max: number;
}) {
  const drag = useRef({ origin: 0, size: 0, value });
  function start(event: PointerEvent<HTMLDivElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { origin: vertical ? event.clientY : event.clientX, size: value, value };
  }
  function resize(next: number) {
    drag.current.value = Math.max(min, Math.min(max, Math.round(next)));
    change(drag.current.value);
  }
  return <div className={`ide-splitter ${vertical ? "horizontal" : ""}`} role="separator" tabIndex={0}
    aria-label={label} aria-orientation={vertical ? "horizontal" : "vertical"} aria-valuemin={min} aria-valuemax={max} aria-valuenow={value}
    onPointerDown={start} onPointerMove={event => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        const delta = (vertical ? event.clientY : event.clientX) - drag.current.origin;
        resize(drag.current.size + (reverse ? -delta : delta));
      }
    }} onPointerUp={event => event.currentTarget.releasePointerCapture(event.pointerId)}
    onLostPointerCapture={() => finish?.(drag.current.value)}
    onKeyDown={event => {
      const keys = vertical ? ["ArrowUp", "ArrowDown"] : ["ArrowLeft", "ArrowRight"];
      if (!keys.includes(event.key)) return;
      event.preventDefault();
      resize(value + (event.key === keys[1] ? 20 : -20) * (reverse ? -1 : 1));
      finish?.(drag.current.value);
    }} />;
}

const initialLayout = { left: "project" as "project" | "git" | null, overviewOpen: false, selected: {} as Record<string, string> };
export function useIdeLayout() {
  const [layout, setLayout] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("yade.ide.layout") ?? "null");
      if (!saved || !["project", "git", null].includes(saved.left)
        || !saved.selected || typeof saved.selected !== "object" || Array.isArray(saved.selected) || !Object.values(saved.selected).every(value => typeof value === "string")) return initialLayout;
      return { left: saved.left, overviewOpen: saved.overviewOpen === true, selected: saved.selected } as typeof initialLayout;
    } catch { return initialLayout; }
  });
  const [layoutError, setLayoutError] = useState("");
  useEffect(() => {
    try { localStorage.setItem("yade.ide.layout", JSON.stringify(layout)); setLayoutError(""); }
    catch { setLayoutError("Расположение панелей не сохранено: локальное хранилище недоступно."); }
  }, [layout]);
  return { layout, setLayout, layoutError };
}

export function IdeDialog({ title, close, children, className = "", anchor, titleDetail, dismissOutside = false }: {
  title: string; close: () => void; children: ReactNode; className?: string; anchor?: { left: number; top: number; bottom: number };
  titleDetail?: string; dismissOutside?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const root = dialog.current!;
    root.showModal();
    if (!anchor) return;
    const bounds = root.getBoundingClientRect();
    const scale = parseFloat(getComputedStyle(root).getPropertyValue("--appearance-scale")) || 1;
    const top = anchor.bottom + bounds.height + 6 > window.innerHeight - 8 ? anchor.top - bounds.height - 6 : anchor.bottom + 6;
    root.style.margin = "0";
    root.style.left = `${Math.max(8, Math.min(anchor.left, window.innerWidth - bounds.width - 8)) / scale}px`;
    root.style.top = `${Math.max(8, Math.min(top, window.innerHeight - bounds.height - 8)) / scale}px`;
  }, [anchor]);
  return <dialog className={`ide-dialog ${className}`} ref={dialog} aria-label={title} onPointerDown={event => {
    if ((anchor || dismissOutside) && event.target === event.currentTarget) close();
  }} onCancel={event => { event.preventDefault(); close(); }}>
    <div className="ide-panel-title"><strong>{title}</strong>{titleDetail && <small>{titleDetail}</small>}<button className="ide-icon-button" aria-label={`Закрыть ${title}`} onClick={close}><Icon name="close" /></button></div>
    <div className="ide-dialog-body">{children}</div>
  </dialog>;
}
