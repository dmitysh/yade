import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type { CSSProperties } from "react";
import { Icon, Splitter, IdeDialog, useIdeLayout } from "./Ide";
import type { DeletionCheck, Project, RunEvent, Session, Snapshot, Tab, View, Workspace } from "./types";
import NewWorkspace from "./NewWorkspace";
import DeleteWorkspace from "./DeleteWorkspace";
import { terminalTitle } from "./Terminal";
import TerminalWorkspace, { type TerminalWorkspaceHandle } from "./TerminalWorkspace";
import type { Availability } from "./ExecutorSettings";
import AppearanceSettings from "./AppearanceSettings";
import { AppearanceProvider } from "./appearance";
import Conversation, { ConversationControls, activeSession, deleteConversationHistory, executorName, sessionState, flushConversationDrafts } from "./Conversations";
import { FileBrowser, FilePanel, filePath, flushFile } from "./Files";
import type { FileLocation } from "./CodeEditor";
import FileIcon from "./FileIcon";
import Git from "./Git";
import type { GitRequest } from "./Git";
import GitMenu from "./GitMenu";
import Lifecycle from "./Lifecycle";
import Projects from "./Projects";
import ProjectOverview, { conversationStatus, terminalStatus } from "./ProjectOverview";
import NewTabMenu from "./NewTabMenu";
import SettingsSelect from "./SettingsSelect";
import CodeNavigation from "./CodeNavigation";
import { codeWorkspace, currentLocation, recordNavigation } from "./codeIntelligence";
import { formatShortcut, ShortcutProvider, useShortcuts } from "./shortcuts";
import WorkspaceShortcuts from "./WorkspaceShortcuts";

function gitRefLabel(reference: string) {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(reference) ? `Без ветки · ${reference.slice(0, 8)}` : reference;
}

export default function App() {
  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // Стандартное закрытие диалога по Escape также выводит окно macOS из полноэкранного режима.
      event.preventDefault();
      document.querySelector("dialog[open]")?.dispatchEvent(new Event("cancel", { cancelable: true }));
    }
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, []);
  return <AppearanceProvider><ShortcutProvider><WorkspaceApp /></ShortcutProvider></AppearanceProvider>;
}

function WorkspaceApp() {
  const { hint, bindings } = useShortcuts();
  const { layout, setLayout, layoutError } = useIdeLayout();
  const { overviewOpen } = layout;
  const [sidebarWidth, setSidebarWidth] = useState<number | null>(null);
  const [gitCenter, setGitCenter] = useState<HTMLDivElement | null>(null);
  const [gitReference, setGitReference] = useState<{ workspaceId: string; repository: string; reference: string } | null>(null);
  const [gitRequest, setGitRequest] = useState<GitRequest | null>(null);
  const [newWorkspaceProject, setNewWorkspaceProject] = useState<Project | null>(null);
  const [deletingWorkspace, setDeletingWorkspace] = useState<Workspace | null>(null);
  const [data, setData] = useState<Snapshot | null>(null);
  const openFiles = useMemo(() => (data?.view.tabs ?? []).flatMap(tab => {
    const path = tab.workspaceId === data?.view.workspaceId ? filePath(tab) : null;
    return path === null ? [] : [path];
  }), [data?.view.tabs, data?.view.workspaceId]);
  const latestView = useRef<View | null>(null);
  const viewSave = useRef(Promise.resolve());
  const viewWrites = useRef(0);
  const viewError = useRef("");
  const snapshotRevision = useRef(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [openAfterAdding, setOpenAfterAdding] = useState(true);
  const [choosingFolder, setChoosingFolder] = useState(false);
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [projectsOpen, setProjectsOpen] = useState(false);
  const [conversationOpen, setConversationOpen] = useState(false);
  const [newChatCode, setNewChatCode] = useState("");
  const [queuedChatCode, setQueuedChatCode] = useState<Record<string, string[]>>({});
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyId, setHistoryId] = useState<string | null>(null);
  const terminalWorkspace = useRef<TerminalWorkspaceHandle>(null);
  const [completions, setCompletions] = useState(() => new Map<string, "running" | "unseen">());
  const unseenCompletions = useMemo(() => new Set([...completions].flatMap(([id, state]) => state === "unseen" ? [id] : [])), [completions]);
  const [dirtyFiles, setDirtyFiles] = useState<Record<string, boolean>>({});
  const [fileErrors, setFileErrors] = useState<Record<string, string>>({});
  const [fileLocations, setFileLocations] = useState<Record<string, FileLocation>>({});
  const executorAvailability = useRef<Promise<Availability[]> | null>(null);
  const discoverExecutors = useCallback(() => {
    if (executorAvailability.current) return executorAvailability.current;
    const request = invoke<Availability[]>("executor_availability");
    executorAvailability.current = request;
    request.catch(() => {
      if (executorAvailability.current === request) executorAvailability.current = null;
    });
    return request;
  }, []);
  const fileDirty = useCallback((id: string, value: boolean) => {
    setDirtyFiles(current => current[id] === value ? current : { ...current, [id]: value });
  }, []);
  const fileProblem = useCallback((id: string, value: string) => {
    setFileErrors(current => current[id] === value ? current : { ...current, [id]: value });
  }, []);

  useEffect(() => {
    let ignore = false;
    invoke<Snapshot>("snapshot").then(value => { if (!ignore) setData(value); })
      .catch(reason => { if (!ignore) setError(String(reason)); });
    return () => { ignore = true; };
  }, []);

  useEffect(() => setGitRequest(null), [data?.view.workspaceId]);
  const refreshSnapshot = useCallback(async () => {
    const revision = snapshotRevision.current;
    const value = await invoke<Snapshot>("snapshot");
    if (revision === snapshotRevision.current) setData(current => current ? { ...value, view: current.view } : value);
  }, []);
  const loaded = data !== null;
  useEffect(() => {
    if (!loaded) return;
    function focus() { if (!document.hidden) void refreshSnapshot().catch(reason => setError(String(reason))); }
    window.addEventListener("focus", focus);
    return () => window.removeEventListener("focus", focus);
  }, [loaded, refreshSnapshot]);
  useEffect(() => {
    if (!loaded) return;
    let idle: number | undefined;
    let timer: number | undefined;
    const preload = () => { void discoverExecutors().catch(() => {}); };
    const frame = requestAnimationFrame(() => {
      if (typeof window.requestIdleCallback === "function") {
        idle = window.requestIdleCallback(preload, { timeout: 2000 });
      } else {
        timer = window.setTimeout(preload, 0);
      }
    });
    return () => {
      cancelAnimationFrame(frame);
      if (idle !== undefined) window.cancelIdleCallback(idle);
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [loaded, discoverExecutors]);

  useEffect(() => {
    let disposed = false;
    const unlisten = listen<RunEvent>("run-event", event => {
      if (event.payload.kind === "session_title") {
        void refreshSnapshot().catch(reason => { if (!disposed) setError(String(reason)); });
      }
    });
    void unlisten.catch(reason => { if (!disposed) setError(`События недоступны: ${String(reason)}`); });
    return () => { disposed = true; void unlisten.then(stop => stop()).catch(() => {}); };
  }, [refreshSnapshot]);

  const preparing = data?.workspaces.some(w => ["pending", "running", "needs_reconciliation"].includes(w.preparationState)) || data?.sessions.some(s => activeSession(s.state)) || data?.terminals?.some(t => t.state === "running");
  useEffect(() => {
    if (!preparing && !overviewOpen) return;
    let ignore = false;
    const timer = setInterval(() => {
      void refreshSnapshot().catch(reason => { if (!ignore) setError(String(reason)); });
    }, 500);
    return () => { ignore = true; clearInterval(timer); };
  }, [preparing, overviewOpen, refreshSnapshot]);

  useEffect(() => {
    if (!data) return;
    const { view } = data;
    const visible = new Set<string>();
    if (layout.left !== "git") {
      const active = view.tabs.find(tab => tab.id === view.activeTabs[view.workspaceId ?? ""]);
      const sessionId = historyId ?? active?.sessionId;
      if (sessionId) visible.add(`session:${sessionId}`);
      for (const id of terminalWorkspace.current?.visibleIds() ?? []) visible.add(`terminal:${id}`);
    }
    setCompletions(current => {
      const next = new Map<string, "running" | "unseen">();
      function track(id: string, status: ReturnType<typeof conversationStatus>) {
        const previous = current.get(id);
        const pending = status === "waiting" || status === "attention";
        if (status === "running" || (pending && previous === "running")) next.set(id, "running");
        else if (!visible.has(id) && ((status === "ready" && previous) || (pending && previous === "unseen"))) {
          next.set(id, "unseen");
        }
      }
      for (const session of data.sessions) track(`session:${session.id}`, conversationStatus(session));
      for (const terminal of data.terminals ?? []) if (terminal.execution) track(`terminal:${terminal.id}`, terminalStatus(terminal));
      return next.size === current.size && [...next].every(([id, state]) => current.get(id) === state) ? current : next;
    });
  }, [data, historyId, layout.left]);

  const deleteOverviewEntry = useCallback((kind: "session" | "terminal", id: string, workspaceId: string, confirmed = true) => {
    const pending = viewSave.current.then(async () => {
      const panels = terminalWorkspace.current;
      if (!confirmed && panels?.focusedId() === id) return;
      const replacementId = kind === "terminal" ? panels?.replacementFor(id) : undefined;
      const view = kind === "session" ? await deleteConversationHistory(id)
        : await invoke<View>("delete_terminal", { workspaceId, id, replacementId, confirmed });
      snapshotRevision.current += 1;
      latestView.current = view;
      if (kind === "terminal") terminalWorkspace.current?.forget(id, replacementId);
      else setHistoryId(current => current === id ? null : current);
      setData(current => current && { ...current, view,
        sessions: kind === "session" ? current.sessions.filter(session => session.id !== id) : current.sessions,
        terminals: kind === "terminal" ? current.terminals?.filter(terminal => terminal.id !== id) : current.terminals,
      });
    });
    viewSave.current = pending.catch(() => {});
    return pending;
  }, []);
  const deleteCompletedTerminal = useCallback((id: string, workspaceId: string) => deleteOverviewEntry("terminal", id, workspaceId, false), [deleteOverviewEntry]);

  async function saveView(next: (current: View) => View) {
    viewWrites.current += 1;
    setBusy(true);
    const pending = viewSave.current.then(async () => {
      setError("");
      const view = next(latestView.current!);
      await invoke("save_view", { view });
      viewError.current = "";
      latestView.current = view;
      setData(current => current ? { ...current, view } : current);
    }).catch(reason => {
      viewError.current = `Расположение не сохранено: ${String(reason)}`;
      setError(viewError.current);
    });
    viewSave.current = pending;
    await pending;
    viewWrites.current -= 1;
    if (!viewWrites.current) setBusy(false);
  }

  async function chooseFolder() {
    setChoosingFolder(true);
    setError("");
    try {
      const selected = await open({ directory: true, multiple: false, title: "Выберите папку проекта", defaultPath: path || undefined });
      if (selected === null) return;
      setPath(selected);
      setName(selected.split(/[\\/]/).filter(Boolean).at(-1) || "");
      setAdding(true);
    } catch (reason) { setError(`Папка не выбрана: ${String(reason)}`); }
    finally { setChoosingFolder(false); }
  }

  async function addFolder(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await invoke("register_folder", { name, path, groupId: null });
      const next = await invoke<Snapshot>("snapshot");
      setData(next);
      const added = next.workspaces.find(w => !w.deleted && !w.archived && !data!.workspaces.some(previous => previous.id === w.id && !previous.deleted));
      if (openAfterAdding && added) {
        const tab: Tab = { id: `overview:${added.id}`, workspaceId: added.id, sessionId: null };
        await saveView(current => ({ ...current, projectId: added.projectId, workspaceId: added.id,
          tabs: current.tabs.some(item => item.id === tab.id) ? current.tabs : [...current.tabs, tab],
          activeTabs: { ...current.activeTabs, [added.id]: tab.id },
        }));
      }
      setAdding(false);
      setName(""); setPath("");
    } catch (reason) { setError(`Проект не добавлен: ${String(reason)}`); }
    finally { setBusy(false); }
  }

  useEffect(() => {
    if (!data) return;
    setLayout(current => {
      const selected = { ...current.selected };
      let changed = false;
      for (const id of Object.values(data.view.activeTabs)) {
        const tab: Tab | undefined = data.view.tabs.find(item => item.id === id);
        if (!tab) continue;
        const key = tab.workspaceId + ":" + tabKind(tab);
        if (selected[key] !== tab.id) { selected[key] = tab.id; changed = true; }
      }
      return changed ? { ...current, selected } : current;
    });
  }, [data?.view, setLayout]);


  function tabKind(tab: Tab): "session" | "terminal" | "editor" { return tab.sessionId ? "session" : tab.id.startsWith("terminal:") ? "terminal" : "editor"; }

  const lifecycle = <Lifecycle flushView={async () => {
    await viewSave.current;
    if (viewError.current) throw new Error(viewError.current);
  }} />;
  if (!data) return <main>{lifecycle}<h1>Yade</h1>{error ? <p role="alert">Не удалось открыть состояние: {error}</p> : <p role="status">Загрузка…</p>}</main>;

  const { view } = data;
  latestView.current = view;
  const workspace = data.workspaces.find(w => w.id === view.workspaceId);
  const project = data.projects.find(p => p.id === view.projectId);
  const workspaceGroup = data.groups.find(g => g.id === workspace?.groupId);
  const projectWorkspaces = data.workspaces.filter(item => !item.deleted && !item.archived
    && (project ? item.projectId === project.id : workspaceGroup ? item.groupId === workspaceGroup.id : item.id === workspace?.id));
  const tabs = view.tabs.filter(t => t.workspaceId === workspace?.id);
  const activeTab = tabs.find(t => t.id === view.activeTabs[workspace?.id ?? ""]);
  function selectedTab(kind: string) {
    return tabs.find(tab => tab.id === activeTab?.id && tabKind(tab) === kind)
      ?? tabs.find(tab => tab.id === layout.selected[workspace?.id + ":" + kind] && tabKind(tab) === kind)
      ?? tabs.find(tab => tabKind(tab) === kind);
  }
  const editorTab = selectedTab("editor");
  const sessionTab = selectedTab("session");
  const contentTab = activeTab;
  const session = data.sessions.find(s => s.id === sessionTab?.sessionId);
  const historySession = data.sessions.find(s => s.id === historyId);
  const historyWorkspace = data.workspaces.find(w => w.id === historySession?.workspaceId);
  const fileWorkspaces = data.workspaces.filter(item => !item.deleted && !item.archived && item.operationState === "ready");

  function closeNewChat() {
    setConversationOpen(false);
    setNewChatCode("");
  }

  async function openSession(s: Session, activateWorkspace = false) {
    closeNewChat();
    setHistoryOpen(false);
    if (activateWorkspace) {
      setLayout(current => current.left === "git" ? { ...current, left: "project" } : current);
    }
    try {
      const w = data!.workspaces.find(w => w.id === s.workspaceId)!;
      if (w.deleted || w.archived) { setHistoryId(s.id); return; }
      if (activateWorkspace) setHistoryId(null);
      await refreshSnapshot();
      const tab: Tab = { id: `session:${s.id}`, workspaceId: s.workspaceId, sessionId: s.id };
      await saveView(current => ({ ...current, ...(activateWorkspace ? { projectId: w.projectId, workspaceId: w.id } : {}),
        tabs: current.tabs.some(t => t.id === tab.id) ? current.tabs : [...current.tabs, tab],
        activeTabs: { ...current.activeTabs, [w.id]: tab.id },
      }));
    } catch (reason) { setError(`Разговор не открыт: ${String(reason)}`); }
  }

  async function conversationDeleted() {
    setHistoryId(null);
    setData(await invoke<Snapshot>("snapshot"));
  }

  function queueChatCode(sessionId: string, code: string) {
    setQueuedChatCode(current => ({ ...current, [sessionId]: [...(current[sessionId] ?? []), code] }));
  }

  function consumeChatCode(sessionId: string, count: number) {
    setQueuedChatCode(current => {
      const { [sessionId]: snippets, ...remaining } = current;
      return snippets && snippets.length > count ? { ...remaining, [sessionId]: snippets.slice(count) } : remaining;
    });
  }

  function addCodeToChat(code: string) {
    if (session && sessionTab) {
      queueChatCode(session.id, code);
      void activateTab(sessionTab);
      return;
    }
    const terminals = (data!.terminals ?? []).filter(terminal => terminal.workspaceId === workspace?.id && terminal.state === "running"
      && terminal.execution && ["ready", "running", "waiting", "unknown"].includes(terminal.execution.state));
    const selectedTerminal = selectedTab("terminal")?.id;
    const terminal = terminals.find(item => "terminal:" + item.id === selectedTerminal)
      ?? terminals.sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0)).find(item => item.execution?.state === "ready")
      ?? terminals[0];
    if (terminal && workspace) {
      void openTerminal(terminal.id, workspace, false, code);
      return;
    }
    setNewChatCode(code);
    setConversationOpen(true);
  }

  async function openTerminal(id: string, target = workspace!, activateWorkspace = false, code?: string) {
    if (activateWorkspace) {
      setHistoryId(null);
      setLayout(current => current.left === "git" ? { ...current, left: "project" } : current);
    }
    const root = terminalWorkspace.current?.reveal(id) ?? id;
    const tab: Tab = { id: "terminal:" + root, workspaceId: target.id, sessionId: null };
    await saveView(current => activateWorkspace && !terminalWorkspace.current?.has(id) ? current : ({ ...current, ...(activateWorkspace ? { projectId: target.projectId, workspaceId: target.id } : {}),
      tabs: current.tabs.some(item => item.id === tab.id) ? current.tabs : [...current.tabs, tab], activeTabs: { ...current.activeTabs, [tab.workspaceId]: tab.id },
    }));
    if (code && !viewError.current && latestView.current?.workspaceId === target.id && latestView.current.activeTabs[target.id] === tab.id) {
      try { terminalWorkspace.current?.pasteToChat(id, code); }
      catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    }
    requestAnimationFrame(() => terminalWorkspace.current?.focus());
  }

  function selectWorkspace(w: Workspace, projectId = w.projectId) {
    setProjectsOpen(false);
    setHistoryId(null);
    const overview: Tab = { id: `overview:${w.id}`, workspaceId: w.id, sessionId: null };
    return saveView(current => {
      const exists = current.tabs.some(t => t.workspaceId === w.id);
      return { ...current, projectId, workspaceId: w.id,
        tabs: exists ? current.tabs : [...current.tabs, overview],
        activeTabs: exists ? current.activeTabs : { ...current.activeTabs, [w.id]: overview.id },
      };
    });
  }

  async function openGroupFolder(id: string) {
    setProjectsOpen(false);
    setBusy(true); setError("");
    try {
      const opened = await invoke<Workspace>("open_group_folder", { groupId: id });
      setData(await invoke<Snapshot>("snapshot"));
      if (opened.archived) {
        await saveView(current => ({ ...current, projectId: null, workspaceId: null }));
        throw new Error("Пространство в архиве. Сначала верните его в активный список.");
      }
      await selectWorkspace(opened);
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }

  function selectProject(p: Project) {
    setProjectsOpen(false);
    setHistoryId(null);
    const first = data!.workspaces.find(w => w.projectId === p.id && !w.archived && !w.deleted);
    if (first) return selectWorkspace(first, p.id);
    return saveView(current => ({ ...current, projectId: p.id, workspaceId: null }));
  }

  async function closeTab(tab: Tab) {
    await closeTabs([tab]);
  }

  async function closeTabs(closing: Tab[]) {
    try {
      for (const tab of closing) if (filePath(tab) !== null) await flushFile(tab.id);
    } catch (reason) {
      setError(`Вкладка оставлена открытой: черновик не сохранён. ${String(reason)}`);
      return;
    }
    await saveView(current => {
      const ids = new Set(closing.map(tab => tab.id));
      const remaining = current.tabs.filter(t => !ids.has(t.id));
      const activeTabs = { ...current.activeTabs };
      for (const tab of closing) if (activeTabs[tab.workspaceId] === tab.id) {
        const next = remaining.find(t => t.workspaceId === tab.workspaceId);
        if (next) activeTabs[tab.workspaceId] = next.id;
        else delete activeTabs[tab.workspaceId];
      }
      return { ...current, tabs: remaining, activeTabs };
    });
  }

  async function openFile(path: string, location?: FileLocation, target = workspace!) {
    const origin = currentLocation(target.id);
    const tab: Tab = { id: `file:${target.id}:${path}`, workspaceId: target.id, sessionId: null };
    if (location) setFileLocations(current => ({ ...current, [tab.id]: location }));
    await saveView(current => ({ ...current,
      ...(current.workspaceId === target.id ? {} : { projectId: target.projectId, workspaceId: target.id }),
      tabs: current.tabs.some(t => t.id === tab.id) ? current.tabs : [...current.tabs, tab],
      activeTabs: { ...current.activeTabs, [tab.workspaceId]: tab.id },
    }));
    if (viewError.current) throw new Error(viewError.current);
    recordNavigation(tab.workspaceId, { path, line: location?.line ?? 1, column: location?.column ?? 1, utf16: location?.utf16 }, origin);
  }

  async function openLinkedFile(workspaceId: string, path: string, location?: FileLocation, targetId = workspaceId) {
    if (latestView.current?.workspaceId !== workspaceId) return;
    const target = fileWorkspaces.find(item => item.id === targetId);
    if (!target) throw new Error("Пространство для ссылки недоступно");
    await openFile(path, location, target);
    setHistoryId(null);
    setLayout(current => current.left === "git" ? { ...current, left: "project" } : current);
  }

  function tabTitle(tab: Tab) {
    return filePath(tab) ?? (tab.id.startsWith("terminal:") ? terminalTitle(tab.id, data!.terminals?.find(t => `terminal:${t.id}` === tab.id)?.execution?.title) : data!.sessions.find(s => s.id === tab.sessionId)?.title ?? "Обзор");
  }

  function tabLabel(tab: Tab) {
    const s = data!.sessions.find(s => s.id === tab.sessionId);
    const label = s ? `${s.title} · ${executorName(s.executor)} · ${sessionState(s.state)}` : `${tabTitle(tab)}${dirtyFiles[tab.id] ? " · Несохранённые правки" : ""}${fileErrors[tab.id] ? ` · ${fileErrors[tab.id]}` : ""}`;
    return unseenCompletions.has(tab.id) ? `${label} · Результат не просмотрен` : label;
  }

  async function activateTab(tab: Tab) {
    await saveView(current => ({ ...current, activeTabs: { ...current.activeTabs, [tab.workspaceId]: tab.id } }));
    requestAnimationFrame(() => {
      if (tab.id.startsWith("terminal:")) terminalWorkspace.current?.focus();
      else document.getElementById(tab.id)?.querySelector<HTMLElement>(".cm-content, textarea")?.focus();
    });
  }

  function revealWorkspace() {
    setHistoryId(null);
    if (layout.left === "git") setLayout(current => ({ ...current, left: "project" }));
  }

  function openProjectSearch(mode: "all" | "text") {
    if (!workspace) return;
    revealWorkspace();
    codeWorkspace(workspace.id).request?.(mode);
  }

  function tabStrip(selected: Tab | undefined) {
    const items = tabs;
    return <div className="ide-tab-bar"><div className="ide-editor-tabs" role="tablist" aria-label="Вкладки пространства"
      onKeyDown={event => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) || !items.length) return;
        event.preventDefault();
        const index = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (items.findIndex(tab => tab.id === selected?.id) + (event.key === "ArrowRight" ? 1 : -1) + items.length) % items.length;
        void activateTab(items[index]);
        event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')[index]?.focus();
      }}>
      {items.map((tab, index) => <GitMenu className={"ide-editor-tab " + (tab.id === selected?.id ? "active" : "")} key={tab.id} contextOnly disabled={busy} label={"Действия вкладки " + tabTitle(tab)} items={[
        { label: "Закрыть", shortcut: bindings.closeTab ? formatShortcut(bindings.closeTab) : undefined, run: () => void closeTab(tab) },
        { label: "Закрыть другие вкладки", disabled: items.length < 2, run: () => void closeTabs(items.filter(item => item.id !== tab.id)) },
        { label: "Закрыть все вкладки", run: () => void closeTabs(items) },
        { label: "Закрыть неизменённые вкладки", disabled: !items.some(item => !dirtyFiles[item.id] && !fileErrors[item.id]), run: () => void closeTabs(items.filter(item => !dirtyFiles[item.id] && !fileErrors[item.id])) },
        { label: "Закрыть вкладки слева", disabled: index === 0, run: () => void closeTabs(items.slice(0, index)) },
        { label: "Закрыть вкладки справа", disabled: index === items.length - 1, run: () => void closeTabs(items.slice(index + 1)) },
      ]}>
        <button role="tab" aria-label={tabLabel(tab)} title={tabLabel(tab)} aria-selected={tab.id === selected?.id} tabIndex={tab.id === selected?.id ? 0 : -1} disabled={busy}
          onClick={() => void activateTab(tab)}>
          {filePath(tab) !== null ? <FileIcon path={filePath(tab)!} /> : <Icon name={tab.sessionId ? "chat" : tabKind(tab) === "terminal" ? "terminal" : "overview"} />}{filePath(tab)?.split("/").at(-1) ?? tabTitle(tab)}{fileErrors[tab.id] ? <span className="ide-file-error" aria-label="Ошибка сохранения файла">!</span> : dirtyFiles[tab.id] && <span className="ide-modified">●</span>}
          {unseenCompletions.has(tab.id) && <span className="ide-tab-completion" aria-hidden="true" />}
        </button>
        <button className="ide-tab-close" aria-label={"Закрыть вкладку " + tabTitle(tab)} disabled={busy} onClick={() => void closeTab(tab)}><Icon name="close" /></button>
      </GitMenu>)}
    </div><NewTabMenu key={workspace?.id} workspace={workspace} disabled={busy} discover={discoverExecutors} openSession={openSession} openTerminal={openTerminal} /></div>;
  }

  return <div className="ide-app ide-live" style={{ "--ide-left": (sidebarWidth ?? view.sidebarWidth) + "px" } as CSSProperties}>
    {lifecycle}
    <WorkspaceShortcuts tabs={tabs} activeTab={activeTab} workspace={workspace} busy={busy} title={tabTitle} activate={activateTab} close={closeTab} openTerminal={openTerminal}
      projects={() => { setProjectsOpen(true); requestAnimationFrame(() => document.getElementById("project-search")?.focus()); }}
      files={() => { setLayout(current => ({ ...current, left: current.left === "project" ? null : "project" })); }}
      git={() => { setLayout(current => ({ ...current, left: current.left === "git" ? null : "git" })); }}
      findText={() => openProjectSearch("text")}
      settings={() => setSettingsOpen(true)} reveal={revealWorkspace} report={setError} />
    <header className="ide-toolbar">
      <span className="ide-logo">Y</span>
      <button title={"Выбрать проект" + hint("projects")} className="ide-brand" onClick={() => setProjectsOpen(true)}>Yade</button>
      {(project || workspaceGroup) && <><span className="ide-toolbar-chevron"><Icon name="chevron" /></span><h1 className="ide-project-name" aria-label={project?.name ?? workspaceGroup?.name}><button className="ide-project-switch" aria-label="Открыть список проектов" aria-haspopup="dialog" title={"Выбрать проект" + hint("projects")} onClick={() => setProjectsOpen(true)}><span>{project?.name ?? workspaceGroup?.name}</span><Icon name="chevron" /></button></h1></>}
      {workspace?.gitRef && <GitMenu key={workspace.id} icon="chevron" className="ide-branch-menu" label={`Действия ветки ${gitRefLabel(workspace.gitRef)}`} disabled={busy} items={([
        ["changes", "Изменения и коммит", "git"], ["history", "История ветки", "history"],
        ["switch", "Переключить ветку…", "git"], ["create_branch", "Новая ветка…", "plus"],
        ["fetch", "Получить изменения", "download"], ["pull", "Обновить ветку", "refresh"], ["push", "Отправить коммиты", "send"],
      ] as const).map(([action, label, icon]) => ({ label, icon, run: () => {
        setGitRequest({ workspaceId: workspace.id, action }); setLayout(current => ({ ...current, left: "git" }));
      } }))}>
        <button type="button" className="ide-branch" title={workspace.gitRef} disabled={busy} aria-label={`Git: ${gitRefLabel(workspace.gitRef)}`} onClick={() => {
          setGitRequest({ workspaceId: workspace.id, action: "changes" }); setLayout(current => ({ ...current, left: "git" }));
        }}><Icon name="git" /><span>{gitRefLabel(workspace.gitRef)}</span></button>
      </GitMenu>}
      <div className="ide-toolbar-spacer" />
      {workspace && <div className="ide-workspace-select"><SettingsSelect label="Пространство" icon="layers" value={workspace.id} disabled={busy} allowDefault={false} onOpen={() => { void refreshSnapshot().catch(reason => setError(String(reason))); }}
        menuHeader={<div className="ide-workspaces-heading"><strong>Пространства <span>{projectWorkspaces.length}</span></strong><small>{project ? "В текущем проекте" : "В текущей группе"}</small></div>}
        choices={projectWorkspaces.map(item => {
          const reference = item.gitRef && gitRefLabel(item.gitRef);
          return { value: item.id, label: item.name, icon: "layers", description: reference ? <><Icon name="git" /><span title={item.gitRef!}>{reference}</span></> : undefined };
        })}
        change={value => { const next = data.workspaces.find(item => item.id === value); if (next) void selectWorkspace(next); }} /></div>}
      <button className="ide-create-workspace" aria-label="Создать пространство" title="Создать пространство" disabled={busy || project?.kind !== "repository"} onClick={() => { if (project) setNewWorkspaceProject(project); }}><Icon name="plus" /><span>Создать пространство</span></button>
      <div className="ide-toolbar-divider" />
      <button className="ide-icon-button" aria-label="Скрыть или показать дерево файлов" title="Дерево файлов" onClick={() => { setLayout(current => ({ ...current, left: current.left ? null : "project" })); }}><Icon name="layout" /></button>
      <button className="ide-icon-button" aria-label="Поиск по проекту" title={"Поиск по проекту" + hint("searchEverywhere")} disabled={!workspace} onClick={() => openProjectSearch("all")}><Icon name="search" /></button>
    </header>
    {(error || layoutError) && !adding && <p role="alert" className="error ide-global-error">{error || layoutError}</p>}
    <div className="ide-layout">
      <nav className="ide-rail" aria-label="Инструменты проекта">
        <button aria-label="Проект" title={"Проект" + hint("files")} aria-pressed={layout.left === "project"} onClick={() => { setLayout(current => ({ ...current, left: current.left === "project" ? null : "project" })); }}><Icon name="project" /></button>
        <button aria-label="Поиск" title="Поиск по проекту" disabled={!workspace} onClick={() => openProjectSearch("all")}><Icon name="search" /></button>
        <button aria-label="Изменения Git" title={"Git" + hint("git")} aria-pressed={layout.left === "git"} onClick={() => { setLayout(current => ({ ...current, left: current.left === "git" ? null : "git" })); }}><Icon name="git" /></button>
        <button aria-label="Обзор проектов" title="Обзор проектов" aria-pressed={overviewOpen} onClick={() => setLayout(current => ({ ...current, overviewOpen: !current.overviewOpen }))}><Icon name="activity" /></button>
        <div className="ide-toolbar-spacer" />
        <button aria-label="Открыть настройки" title={"Настройки" + hint("settings")} onClick={() => setSettingsOpen(true)}><Icon name="settings" /></button>
      </nav>
      <aside className="ide-project-panel" aria-label="Проекты" hidden={!layout.left}>
        <div className="ide-sidebar-scroll" hidden={layout.left !== "project"}>
          <button className="ide-current-project" aria-label="Выбрать проект" onClick={() => setProjectsOpen(true)}><Icon name="project" /><span><strong>{project?.name ?? workspaceGroup?.name ?? "Выберите проект"}</strong><small>{projectWorkspaces.length} {({ one: "пространство", few: "пространства", many: "пространств", other: "пространства" } as Record<string, string>)[new Intl.PluralRules("ru").select(projectWorkspaces.length)]}</small></span><Icon name="chevron" /></button>
          {workspace && <FileBrowser key={workspace.id} workspaceId={workspace.id} projectId={workspace.projectId ?? workspace.id} gitRef={workspace.gitRef} open={openFile} embedded
            selectedPath={editorTab ? filePath(editorTab) ?? undefined : undefined}
            refreshWorkspace={() => refreshSnapshot().catch(reason => setError(String(reason)))} />}
        </div>
        <div className="ide-git-content" hidden={layout.left !== "git"}>{workspace ? <Git key={workspace.id} workspaceId={workspace.id} projectId={workspace.projectId ?? workspace.id} open={path => { setLayout(current => ({ ...current, left: "project" })); void openFile(path); }} center={gitCenter} referenceChanged={(reference, repository) => {
          setGitReference({ workspaceId: workspace.id, repository, reference });
          if (!repository) setData(current => current ? { ...current, workspaces: current.workspaces.map(item => item.id === workspace.id ? { ...item, gitRef: reference } : item) } : current);
        }} beforeOperation={async () => {
          for (const tab of view.tabs.filter(tab => tab.workspaceId === workspace.id && filePath(tab) !== null)) await flushFile(tab.id);
        }} request={gitRequest?.workspaceId === workspace.id ? gitRequest : null} requestHandled={() => setGitRequest(null)} embedded active={layout.left === "git"} /> : <p>Выберите рабочее пространство.</p>}</div>
        <div className="ide-sidebar-footer" hidden={layout.left === "git"}><button onClick={() => setProjectsOpen(true)}><Icon name="project" />Все проекты</button><button className="ide-icon-button" aria-label="Добавить" title="Добавить проект" onClick={() => { setError(""); setAdding(true); }}><Icon name="plus" /></button></div>
      </aside>
      {!!layout.left && <Splitter label="Ширина проекта" value={sidebarWidth ?? view.sidebarWidth} change={setSidebarWidth} finish={size => { void saveView(current => ({ ...current, sidebarWidth: size })).then(() => setSidebarWidth(null)); }} min={180} max={420} />}
      <main className="ide-center">
        {layout.left !== "git" && tabStrip(contentTab)}
        {workspace && <CodeNavigation key={workspace.id} workspaceId={workspace.id} projectName={project?.name ?? workspaceGroup?.name ?? workspace.name}
          openFiles={openFiles} activeFile={contentTab ? filePath(contentTab) : null} open={openFile} reveal={revealWorkspace} toolbar={!contentTab?.id.startsWith("terminal:")} />}
        <div className="git-center-host" ref={setGitCenter} hidden={layout.left !== "git"} />
        <div className="ide-editor-body" hidden={layout.left === "git"}>
          {view.tabs.filter(tab => filePath(tab) !== null).map(tab => <FilePanel key={tab.id} tab={tab} location={fileLocations[tab.id]} dirty={fileDirty} problem={fileProblem} focused={layout.left !== "git" && tab.id === activeTab?.id} active={layout.left !== "git" && !historySession && tab.workspaceId === workspace?.id && tab.id === contentTab?.id}
            addToChat={workspace && !workspace.archived && !workspace.deleted && workspace.operationState === "ready" ? addCodeToChat : undefined} />)}
          {!historySession && (!contentTab || (tabKind(contentTab) === "editor" && filePath(contentTab) === null)) && <section className="ide-overview" role="tabpanel">
            <span className="ide-welcome-icon"><Icon name="chat" /></span><h2>{workspace ? contentTab ? "Обзор пространства" : "Выберите вкладку" : "Выберите проект"}</h2>
            <p className="muted">{workspace ? "Задайте вопрос по проекту или откройте файл слева." : "Откройте папку проекта, чтобы начать работу."}</p>
            {workspace ? <button onClick={() => setConversationOpen(true)}><Icon name="plus" />Новый разговор</button> : <button onClick={() => setProjectsOpen(true)}>Все проекты</button>}
            {workspace && <>
              <p className="path">{workspace.path}</p>
              {workspaceGroup && <section aria-label="Проекты общей папки"><p>Общая папка. У вложенных репозиториев отдельные ветки и история.</p>
                {data.projects.filter(item => item.groupId === workspaceGroup.id && item.path.startsWith(workspace.path.replace(/\/$/, "") + "/")).map(item => <p key={item.id}>{item.name} · <span className="path">{item.path}</span></p>)}
              </section>}
              {workspace.operationState !== "ready" && <p role="status">{workspace.operationState === "creating" ? "Создание пространства…" : "Операция не завершена"}</p>}
              {workspace.operationError && <p role="alert" className="error">{workspace.operationError}</p>}
              {!tabs.some(tab => tabKind(tab) === "editor") && <button disabled={busy} onClick={() => void saveView(current => ({ ...current, tabs: [...current.tabs, { id: "overview:" + workspace.id, workspaceId: workspace.id, sessionId: null }], activeTabs: { ...current.activeTabs, [workspace.id]: "overview:" + workspace.id } }))}>Открыть обзор</button>}
            </>}
          </section>}
          <section className="ide-terminal" aria-label="Терминалы" hidden={!!historySession || !contentTab || tabKind(contentTab) !== "terminal"}>
            <TerminalWorkspace ref={terminalWorkspace} terminals={data.terminals ?? []} tabs={view.tabs} workspaces={data.workspaces}
              screenReaderEnabled={data.screenReaderEnabled}
              removeCompleted={deleteCompletedTerminal}
              activeId={!historySession && layout.left !== "git" && contentTab?.id.startsWith("terminal:") ? contentTab.id : null}
              close={id => { const tab = view.tabs.find(item => item.id === "terminal:" + id); if (tab) void closeTab(tab); }} openFile={openLinkedFile} />
          </section>
          <section className="ide-chat-panel" aria-label="Разговор с исполнителем" hidden={!historySession && !contentTab?.sessionId}>
            <div className="ide-conversation-host" id={historySession ? undefined : sessionTab?.id}>
              {historySession && historyWorkspace ? <><button className="ide-back-to-workspace" onClick={() => setHistoryId(null)}>Вернуться в пространство</button><Conversation key={historySession.id} session={historySession} workspace={historyWorkspace} fileWorkspaces={fileWorkspaces} changed={refreshSnapshot} deleted={conversationDeleted} history={() => setHistoryOpen(true)} openFile={historyWorkspace.id === workspace?.id && !historyWorkspace.deleted ? (path, location, targetId) => openLinkedFile(historyWorkspace.id, path, location, targetId) : undefined} /></> : session && workspace ? <Conversation focused={layout.left !== "git" && activeTab?.id === sessionTab?.id} key={session.id} session={session} workspace={workspace} fileWorkspaces={fileWorkspaces} changed={refreshSnapshot} deleted={conversationDeleted} history={() => setHistoryOpen(true)} openFile={(path, location, targetId) => openLinkedFile(workspace.id, path, location, targetId)}
                queuedCode={queuedChatCode[session.id]} codeAppended={count => consumeChatCode(session.id, count)} /> : <p className="ide-chat-placeholder">Откройте или создайте разговор в этом пространстве.</p>}
            </div>
          </section>
        </div>
      </main>
      {overviewOpen && <ProjectOverview data={data} busy={busy} selectProject={selectProject} selectWorkspace={selectWorkspace}
        removeEntry={deleteOverviewEntry} unseenCompletions={unseenCompletions}
        openTerminal={terminal => { const target = data.workspaces.find(workspace => workspace.id === terminal.workspaceId); if (target) void openTerminal(terminal.id, target, true); }}
        openSession={session => { void openSession(session, true); }} add={() => { setError(""); setAdding(true); }} />}
    </div>
    <footer className="ide-status">{overviewOpen && <span>Все активные проекты</span>}<span role="status" className="ide-status-notice">{busy ? "Сохранение состояния…" : error ? "Не сохранено" : ""}</span><div className="ide-toolbar-spacer" /><Icon name="git" /><span>{layout.left === "git" && gitReference?.repository && gitReference.workspaceId === workspace?.id ? gitReference.reference : workspace?.gitRef ?? "Папка"}</span><button aria-label="История разговоров" title="История разговоров" onClick={() => setHistoryOpen(true)}><Icon name="chat" />История разговоров</button></footer>
    {projectsOpen && <IdeDialog title="Все проекты" className="ide-projects-dialog" close={() => setProjectsOpen(false)}><Projects data={data} busy={busy} selectProject={selectProject} selectWorkspace={selectWorkspace}
      add={() => { setProjectsOpen(false); setError(""); setAdding(true); }} openGroup={openGroupFolder}
      remove={setDeletingWorkspace}
      create={p => { setProjectsOpen(false); setNewWorkspaceProject(p); }} /></IdeDialog>}
    {conversationOpen && workspace && <IdeDialog title="Новый чат" className="new-chat-dialog" close={closeNewChat}><ConversationControls key={workspace.id} workspace={workspace} sessions={data.sessions.filter(item => item.workspaceId === workspace.id)} open={created => {
      if (newChatCode && created.workspaceId === workspace.id) queueChatCode(created.id, newChatCode);
      return openSession(created);
    }} close={closeNewChat} /></IdeDialog>}
    {historyOpen && <IdeDialog title="История разговоров" close={() => setHistoryOpen(false)}><div className="ide-history-list">{data.sessions.map(item => <button className="project" key={item.id} onClick={() => void openSession(item, true)}>Открыть историю «{item.title}»<small>{executorName(item.executor)} · {sessionState(item.state)} · {data.workspaces.find(w => w.id === item.workspaceId)?.deleted ? "Пространство удалено" : data.workspaces.find(w => w.id === item.workspaceId)?.name}</small></button>)}{!data.sessions.length && <p className="muted">Разговоров пока нет.</p>}</div></IdeDialog>}
    {adding && <IdeDialog title="Добавить проект" className="add-project-dialog" close={() => { if (!busy && !choosingFolder) setAdding(false); }}>
      <form className="add-project-form" onSubmit={addFolder}>
        <div className="add-project-fields">
          <div className={`add-project-folder ${path ? "chosen" : ""}`}>
            <Icon name="project" /><div>{path ? <><strong>{name || path.split(/[\\/]/).filter(Boolean).at(-1)}</strong><span title={path}>{path}</span></> : <span>Папка не выбрана</span>}</div>
            <button type="button" disabled={busy || choosingFolder} onClick={() => void chooseFolder()}>{choosingFolder ? "Выбор папки…" : "Выбрать папку…"}</button>
          </div>
          <label className="add-project-open"><input type="checkbox" checked={openAfterAdding} onChange={event => setOpenAfterAdding(event.target.checked)} disabled={busy} />Открыть после добавления</label>
          {error && <p className="error" role="alert">{error}</p>}
        </div>
        <div className="add-project-actions"><button type="button" disabled={busy || choosingFolder} onClick={() => setAdding(false)}>Отмена</button><button type="submit" disabled={busy || choosingFolder || !path.trim() || !name.trim()}>Добавить</button></div>
      </form>
    </IdeDialog>}
    {settingsOpen && <AppearanceSettings workspace={workspace} session={session} close={() => setSettingsOpen(false)} />}
    {newWorkspaceProject && <NewWorkspace project={newWorkspaceProject} close={() => setNewWorkspaceProject(null)} refresh={async created => {
      setData(await invoke<Snapshot>("snapshot"));
      if (created) await selectWorkspace(created);
    }} />}
    {deletingWorkspace && <DeleteWorkspace workspace={deletingWorkspace} close={() => setDeletingWorkspace(null)}
      inspect={async () => {
        await viewSave.current;
        if (viewError.current) throw new Error(viewError.current);
        for (const tab of data.view.tabs.filter(tab => tab.workspaceId === deletingWorkspace.id && filePath(tab) !== null)) await flushFile(tab.id);
        await flushConversationDrafts();
        return invoke<DeletionCheck>("inspect_workspace_deletion", { workspaceId: deletingWorkspace.id });
      }} refresh={async () => setData(await invoke<Snapshot>("snapshot"))} />}
  </div>;
}
