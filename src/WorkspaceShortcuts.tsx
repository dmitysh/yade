import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Icon, IdeDialog } from "./Ide";
import { shortcutFromEvent, useShortcutHandlers, useShortcuts } from "./shortcuts";
import type { Tab, Workspace } from "./types";
import "./shortcuts.css";

export default function WorkspaceShortcuts({ tabs, activeTab, workspace, busy, title, activate, close, openTerminal, projects, files, git, findText, settings, reveal, report }: {
  tabs: Tab[]; activeTab?: Tab; workspace?: Workspace; busy: boolean;
  title: (tab: Tab) => string; activate: (tab: Tab) => Promise<void>; close: (tab: Tab) => Promise<void>;
  openTerminal: (id: string) => Promise<void>;
  projects: () => void; files: () => void; git: () => void; findText: () => void; settings: () => void;
  reveal: () => void; report: (message: string) => void;
}) {
  const { bindings } = useShortcuts();
  const recent = useRef<string[]>([]);
  const focused = useRef<string | null>(null);
  const creating = useRef(false);
  const switchList = useRef<HTMLDivElement>(null);
  const [switcher, setSwitcher] = useState<{ tabs: Tab[]; index: number; modifier: string } | null>(null);
  const latest = useRef({ tabs, activate }); latest.current = { tabs, activate };
  function remember(id: string) { recent.current = [id, ...recent.current.filter(value => value !== id)]; focused.current = id; }
  useEffect(() => { if (activeTab) remember(activeTab.id); }, [activeTab?.id]);
  useEffect(() => {
    function focus(event: Event) {
      if (!(event.target instanceof Node)) return;
      const tab = latest.current.tabs.find(tab => document.getElementById(tab.id)?.contains(event.target as Node));
      if (tab) remember(tab.id);
    }
    document.addEventListener("focusin", focus); document.addEventListener("pointerdown", focus);
    return () => { document.removeEventListener("focusin", focus); document.removeEventListener("pointerdown", focus); };
  }, []);
  function newTab() {
    if (busy || !workspace || workspace.archived || workspace.deleted || workspace.operationState !== "ready") return;
    reveal();
    requestAnimationFrame(() => {
      const button = document.querySelector<HTMLButtonElement>(".ide-live .ide-new-tab");
      button?.focus();
      if (button?.getAttribute("aria-expanded") !== "true") button?.click();
    });
  }
  function focusKind(kind: "session" | "terminal") {
    if (busy) return;
    const candidates = tabs.filter(tab => kind === "session" ? !!tab.sessionId : tab.id.startsWith("terminal:"));
    const tab = recent.current.map(id => candidates.find(tab => tab.id === id)).find(Boolean) ?? candidates[0];
    if (tab) { reveal(); void activate(tab); return; }
    if (kind === "session") { newTab(); return; }
    if (!workspace || workspace.deleted || workspace.archived || workspace.operationState !== "ready" || creating.current) return;
    creating.current = true; reveal();
    void invoke<{ id: string }>("start_terminal", { workspaceId: workspace.id, cols: 80, rows: 24 })
      .then(terminal => openTerminal(terminal.id)).catch(reason => report(`Терминал не открыт: ${String(reason)}`))
      .finally(() => { creating.current = false; });
  }
  function beginSwitch(event: KeyboardEvent, direction: number) {
    if (busy || !tabs.length) return;
    const order = [...new Set([focused.current ?? activeTab?.id ?? "", ...recent.current, ...tabs.map(tab => tab.id)])];
    const ordered = order.map(id => tabs.find(tab => tab.id === id)).filter((tab): tab is Tab => !!tab);
    const index = (direction + ordered.length) % ordered.length;
    const modifier = event.ctrlKey ? "Control" : event.metaKey ? "Meta" : event.altKey ? "Alt" : event.shiftKey ? "Shift" : "";
    if (!modifier || ordered.length === 1) { reveal(); void activate(ordered[index]); }
    else setSwitcher({ tabs: ordered, index, modifier });
  }
  function commitSwitch() {
    if (!switcher) return;
    const tab = latest.current.tabs.find(tab => tab.id === switcher.tabs[switcher.index]?.id);
    setSwitcher(null);
    if (tab) { reveal(); void latest.current.activate(tab); }
  }
  useEffect(() => {
    if (!switcher) return;
    switchList.current?.focus();
    document.getElementById(`switch-tab-${switcher.index}`)?.scrollIntoView?.({ block: "nearest" });
    function keydown(event: KeyboardEvent) {
      const key = shortcutFromEvent(event);
      const direction = key === bindings.nextTab ? 1 : key === bindings.previousTab ? -1 : event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
      if (direction) {
        event.preventDefault(); event.stopImmediatePropagation();
        setSwitcher(current => current && ({ ...current, index: (current.index + direction + current.tabs.length) % current.tabs.length }));
      } else if (event.key === "Escape" || event.key === "Enter") {
        event.preventDefault(); event.stopImmediatePropagation();
        if (event.key === "Enter") commitSwitch(); else setSwitcher(null);
      }
    }
    function keyup(event: KeyboardEvent) {
      if (event.key === switcher!.modifier) { event.preventDefault(); event.stopImmediatePropagation(); commitSwitch(); }
    }
    function cancel() { setSwitcher(null); }
    window.addEventListener("keydown", keydown, true); window.addEventListener("keyup", keyup, true); window.addEventListener("blur", cancel);
    return () => { window.removeEventListener("keydown", keydown, true); window.removeEventListener("keyup", keyup, true); window.removeEventListener("blur", cancel); };
  }, [switcher, bindings]);
  useShortcutHandlers({
    projects, files, git, findText, settings,
    newTab, message: () => focusKind("session"), terminal: () => focusKind("terminal"),
    nextTab: event => beginSwitch(event, 1), previousTab: event => beginSwitch(event, -1),
    closeTab: () => { if (!busy) { const target = tabs.find(tab => tab.id === focused.current) ?? activeTab; if (target) void close(target); } },
  }, !switcher);
  return switcher && <IdeDialog title="Переключение вкладок" className="tab-switcher" close={() => setSwitcher(null)}>
    <div ref={switchList} tabIndex={0} className="tab-switcher-list" role="listbox" aria-label="Недавние вкладки" aria-activedescendant={`switch-tab-${switcher.index}`}>
      {switcher.tabs.map((tab, index) => <button id={`switch-tab-${index}`} role="option" tabIndex={-1} aria-selected={index === switcher.index} key={tab.id}
        onClick={() => { setSwitcher(null); reveal(); void activate(tab); }}><Icon name={tab.sessionId ? "chat" : tab.id.startsWith("terminal:") ? "terminal" : "file"} />{title(tab)}</button>)}
    </div><p className="muted">Отпустите клавишу-модификатор для перехода. Esc — отмена.</p>
  </IdeDialog>;
}
