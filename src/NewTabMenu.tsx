import { useEffect, useId, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useShortcuts } from "./shortcuts";
import { Icon } from "./Ide";
import { executorName } from "./Conversations";
import type { Availability } from "./ExecutorSettings";
import type { Session, Workspace } from "./types";

export default function NewTabMenu({ workspace, disabled, discover, openSession, openTerminal }: {
  workspace: Workspace | undefined; disabled: boolean;
  discover: () => Promise<Availability[]>;
  openSession: (session: Session) => Promise<void>; openTerminal: (id: string) => Promise<void>;
}) {
  const { hint } = useShortcuts();
  const [expanded, setExpanded] = useState(false);
  const [availability, setAvailability] = useState<Availability[] | null>(null);
  const [discoveryError, setDiscoveryError] = useState("");
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const unavailable = disabled || starting || !workspace || workspace.archived || workspace.deleted || workspace.operationState !== "ready";
  const installed = availability?.filter(item => item.state !== "missing");

  useEffect(() => {
    if (!expanded) return;
    let ignore = false;
    setDiscoveryError(""); setError("");
    discover().then(value => { if (!ignore) setAvailability(value); })
      .catch(reason => { if (!ignore) setDiscoveryError(String(reason)); });
    const focus = requestAnimationFrame(() => container.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus());
    function outside(event: PointerEvent) {
      if (!container.current?.contains(event.target as Node)) setExpanded(false);
    }
    document.addEventListener("pointerdown", outside);
    return () => { ignore = true; cancelAnimationFrame(focus); document.removeEventListener("pointerdown", outside); };
  }, [expanded, discover]);

  async function create(executor?: string) {
    if (unavailable || !workspace) return;
    setStarting(true); setError("");
    try {
      if (executor) {
        const session = await invoke<Session>(`create_${executor}_session`, { workspaceId: workspace.id, title: "Новый чат" });
        await openSession(session);
      } else {
        const terminal = await invoke<{ id: string }>("start_terminal", { workspaceId: workspace.id, cols: 80, rows: 24 });
        await openTerminal(terminal.id);
      }
      setExpanded(false);
    } catch (reason) { setError(`${executor ? "Разговор" : "Терминал"} не открыт: ${String(reason)}`); }
    finally { setStarting(false); }
  }

  return <div className="ide-new-tab-menu" ref={container} onBlur={event => {
    // В WebKit нажатие пункта меню снимает фокус без новой цели до события click.
    if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setExpanded(false);
  }} onKeyDown={event => {
    if (expanded && /^[1-9]$/.test(event.key) && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault(); event.stopPropagation();
      if (!event.repeat) container.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')[Number(event.key) - 1]?.click();
    }
    if (event.key === "Escape") {
      event.preventDefault(); event.stopPropagation(); setExpanded(false); trigger.current?.focus();
    }
  }}>
    <button ref={trigger} className="ide-icon-button ide-new-tab" aria-label="Новая вкладка" title={"Новая вкладка" + hint("newTab")}
      aria-haspopup="menu" aria-expanded={expanded} aria-controls={expanded ? menuId : undefined} disabled={unavailable}
      onClick={() => setExpanded(current => !current)} onKeyDown={event => {
        if (event.key === "ArrowDown") { event.preventDefault(); setExpanded(true); }
      }}><Icon name="plus" /></button>
    {expanded && <div id={menuId} className="ide-new-tab-options" role="menu" aria-label="Новая вкладка" aria-busy={starting} onKeyDown={event => {
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)'));
      if (!items.length) return;
      const index = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
        : (items.indexOf(document.activeElement as HTMLElement) + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[index].focus();
    }}>
      <button role="menuitem" disabled={unavailable} onClick={() => void create()}><span className="ide-executor-mark"><Icon name="terminal" /></span><span className="ide-new-tab-label"><strong>Терминал</strong><small>Оболочка в папке пространства</small></span><kbd aria-hidden="true">1</kbd></button>
      <div role="separator" className="ide-new-tab-divider" />
      <div className="ide-new-tab-heading">Исполнители</div>
      {!availability && !discoveryError && <p role="status">Поиск исполнителей…</p>}
      {installed?.map((item, index) => <button key={item.executor} role="menuitem" disabled={unavailable || item.state !== "ready"}
        title={[item.reason, item.action].filter(Boolean).join(". ")} onClick={() => void create(item.executor)}>
        <span className={`ide-executor-mark ${item.executor}`}><Icon name={item.executor === "claude" ? "sparkles" : "prompt"} /></span>
        <span className="ide-new-tab-label"><strong>{executorName(item.executor)}</strong><small>{item.state === "ready" ? "Новый разговор" : item.action || item.reason}</small></span>
        {item.state === "ready" && <span className="ide-space-dot active" />}
        <kbd aria-hidden="true">{index + 2}</kbd>
      </button>)}
      {availability && !installed?.length && <p>Исполнители не найдены. Установите Codex или Claude Code — Yade найдёт их автоматически.</p>}
      {discoveryError && <p role="alert">Не удалось найти исполнителей: {discoveryError}</p>}
      {starting && <p role="status">Создание…</p>}
      {error && <p role="alert" className="error">{error}</p>}
      <div className="ide-new-tab-divider" />
      <p>Нажмите цифру, чтобы открыть</p>
    </div>}
  </div>;
}
