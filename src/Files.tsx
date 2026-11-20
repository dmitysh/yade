import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import CodeEditor, { Comparison, type FileLocation } from "./CodeEditor";
import type { FileDocument, FileEntry, Tab } from "./types";
import { Icon } from "./Ide";
import FileIcon from "./FileIcon";

export function filePath(tab: Tab): string | null {
  const prefix = `file:${tab.workspaceId}:`;
  return tab.id.startsWith(prefix) ? tab.id.slice(prefix.length) : null;
}

const writes = new Map<string, Promise<void>>();
const flushers = new Map<string, () => Promise<void>>();
const documents = new Map<string, { get: () => FileDocument | null; replace: (document: FileDocument) => void }>();
const paused = new Set<string>();
async function waitForWrites(id: string) { while (writes.has(id)) await writes.get(id); }
function enqueueWrite(id: string, write: () => Promise<void>) {
  const pending = (writes.get(id) ?? Promise.resolve()).catch(() => {}).then(write);
  writes.set(id, pending);
  void pending.then(() => { if (writes.get(id) === pending) writes.delete(id); }, () => {});
  return pending;
}
export async function flushFile(id: string) { await flushers.get(id)?.(); await waitForWrites(id); }
export async function flushFiles() { await Promise.all([...new Set([...flushers.keys(), ...writes.keys()])].map(flushFile)); }

export async function pauseFileSaving(workspaceId: string) {
  paused.add(workspaceId);
  try { await Promise.all([...documents.keys()].filter(id => id.startsWith(`file:${workspaceId}:`)).map(waitForWrites)); }
  catch (reason) { paused.delete(workspaceId); throw reason; }
  return () => {
    paused.delete(workspaceId);
    for (const id of documents.keys()) if (id.startsWith(`file:${workspaceId}:`)) void flushFile(id).catch(() => {});
  };
}
export async function renameDocument(workspaceId: string, path: string): Promise<FileDocument> {
  const id = `file:${workspaceId}:${path}`;
  await waitForWrites(id);
  const document = documents.get(id)?.get() ?? await invoke<FileDocument>("open_file", { workspaceId, path });
  if (document.diskError || document.disk !== document.base) throw new Error(`${path}: сначала разрешите конфликт с диском`);
  return { ...document };
}
export function replaceFileDocuments(workspaceId: string, updated: FileDocument[]) {
  for (const document of updated) documents.get(`file:${workspaceId}:${document.path}`)?.replace(document);
}

type FileTreeProps = { workspaceId: string; open: (path: string) => void; selectedPath?: string };

function Directory({ path, ...tree }: FileTreeProps & { path: string; refresh: number; expanded: ReadonlySet<string>; toggle: (path: string) => void }) {
  const { workspaceId, open, selectedPath, refresh, expanded, toggle } = tree;
  const [entries, setEntries] = useState<FileEntry[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let ignore = false;
    let pending = false;
    async function load() {
      if (pending) return;
      pending = true;
      try {
        const next = await invoke<FileEntry[]>("list_directory", { workspaceId, path });
        if (ignore) return;
        setEntries(current => current?.length === next.length && current.every((entry, index) => {
          const updated = next[index];
          return entry.path === updated.path && entry.name === updated.name && entry.directory === updated.directory;
        }) ? current : next);
      } catch (reason) {
        if (!ignore) setError(String(reason));
      } finally { pending = false; }
    }
    void load();
    const timer = setInterval(load, 5000);
    return () => { ignore = true; clearInterval(timer); };
  }, [workspaceId, path, refresh]);
  return <ul className="file-tree">{!entries && (error ? <li role="alert">{error}</li> : <li>Загрузка…</li>)}
    {entries?.map(entry => <li key={entry.path}>{entry.directory ? <>
      <button aria-label={`${entry.name}/`} aria-expanded={expanded.has(entry.path)} onClick={() => toggle(entry.path)}><Icon name="chevron" /><Icon name="project" /><span>{entry.name}</span></button>
      {expanded.has(entry.path) && <Directory {...tree} path={entry.path} />}
    </> : <button aria-label={entry.name} aria-current={entry.path === selectedPath ? "page" : undefined} onClick={() => open(entry.path)}><FileIcon path={entry.path} /><span>{entry.name}</span></button>}</li>)}
  </ul>;
}

function FileTree({ storageKey, refresh, ...tree }: FileTreeProps & { storageKey: string; refresh: number }) {
  const [expanded, setExpanded] = useState(() => {
    try {
      const paths = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
      return new Set<string>(Array.isArray(paths) ? paths.filter(path => typeof path === "string") : []);
    } catch { return new Set<string>(); }
  });
  const [storageError, setStorageError] = useState(false);
  function toggle(path: string) {
    const next = new Set(expanded);
    if (!next.delete(path)) next.add(path);
    setExpanded(next);
    try {
      localStorage.setItem(storageKey, JSON.stringify([...next]));
      setStorageError(false);
    } catch { setStorageError(true); }
  }
  return <>
    {storageError && <p role="alert">Не удалось сохранить состояние дерева файлов.</p>}
    <Directory {...tree} path="" refresh={refresh} expanded={expanded} toggle={toggle} />
  </>;
}

function FileDrafts({ workspaceId, open }: { workspaceId: string; open: (path: string) => void }) {
  const [paths, setPaths] = useState<string[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    let ignore = false;
    invoke<string[]>("list_file_drafts", { workspaceId }).then(value => { if (!ignore) setPaths(value); })
      .catch(reason => { if (!ignore) setError(String(reason)); });
    return () => { ignore = true; };
  }, [workspaceId]);
  return <section aria-label="Сохранённые черновики">
    <h3>Сохранённые черновики</h3>
    {error && <p role="alert">{error}</p>}
    <ul>{paths.map(path => <li key={path}><button onClick={() => open(path)}><FileIcon path={path} />{path}</button></li>)}</ul>
  </section>;
}

export function FileBrowser({ workspaceId, projectId = workspaceId, gitRef = null, open, embedded = false, selectedPath, refreshWorkspace }: FileTreeProps & { projectId?: string; gitRef?: string | null; embedded?: boolean; refreshWorkspace?: () => Promise<void> }) {
  const [expanded, setExpanded] = useState(embedded);
  const [refresh, setRefresh] = useState(0);
  const storageKey = `yade.file-tree:${JSON.stringify([gitRef ? projectId : workspaceId, gitRef])}`;
  async function refreshTree() {
    await refreshWorkspace?.();
    setRefresh(current => current + 1);
  }
  return <section className="files" aria-label="Файлы пространства">
    {!embedded && <button aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>Файлы</button>}
    {expanded && <>
      <div className="ide-files-heading"><strong>Файлы</strong><button className="ide-icon-button" aria-label="Обновить дерево" title="Обновить дерево" onClick={refreshTree}><Icon name="refresh" /></button></div>
      <FileDrafts key={`drafts:${refresh}`} workspaceId={workspaceId} open={open} />
      <FileTree key={storageKey} storageKey={storageKey} refresh={refresh} workspaceId={workspaceId} open={open} selectedPath={selectedPath} />
    </>}
  </section>;
}

type FilePanelProps = {
  tab: Tab; active: boolean; focused?: boolean; location?: FileLocation; dirty: (id: string, value: boolean) => void;
  problem?: (id: string, error: string) => void; addToChat?: (code: string) => void;
};
export function FilePanel(props: FilePanelProps) {
  return filePath(props.tab)?.startsWith("file:") ? <DependencyFile {...props} /> : <EditableFile {...props} />;
}
function DependencyFile({ tab, active, focused, location, addToChat }: FilePanelProps) {
  const path = filePath(tab)!;
  const [document, setDocument] = useState<FileDocument | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let disposed = false;
    invoke<FileDocument>("read_language_file", { workspaceId: tab.workspaceId, uri: path }).then(value => { if (!disposed) setDocument(value); })
      .catch(reason => { if (!disposed) setError(String(reason)); });
    return () => { disposed = true; };
  }, [path, tab.workspaceId]);
  return <section id={tab.id} className="file-panel" role="tabpanel" hidden={!active} aria-label={`Зависимость ${path}`}>
    <p className="ide-dependency-notice"><Icon name="shield" />Зависимость · только для чтения</p>
    {error ? <p role="alert" className="error">{error}</p> : document ? <CodeEditor workspaceId={tab.workspaceId} path={path} body={document.body} active={active} focused={focused} location={location} disabled change={() => {}} save={() => {}} addToChat={addToChat} /> : <p role="status">Загрузка зависимости…</p>}
  </section>;
}
function EditableFile({ tab, active, focused, location, dirty, problem, addToChat }: FilePanelProps) {
  const path = filePath(tab)!;
  const workspaceId = tab.workspaceId;
  const [document, setDocument] = useState<FileDocument | null>(null);
  const [gitBase, setGitBase] = useState<string | null>(null);
  const current = useRef<FileDocument | null>(null);
  const [error, setError] = useState("");
  const [draftError, setDraftError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);
  const savingRef = useRef<Promise<boolean> | null>(null);
  const acceptingDisk = useRef(false);
  const mounted = useRef(true);
  const [comparison, setComparison] = useState<{ a: string; b: string; title: string } | null>(null);

  function update(next: FileDocument) { current.current = next; if (mounted.current) setDocument(next); }
  useEffect(() => {
    documents.set(tab.id, { get: () => current.current, replace: update });
    return () => { documents.delete(tab.id); };
  }, [tab.id]);
  useEffect(() => {
    mounted.current = true;
    let ignore = false;
    waitForWrites(tab.id).then(() => invoke<FileDocument>("open_file", { workspaceId, path }))
      .then(value => {
        if (!ignore) update(value.body === value.base && value.disk !== null && !value.diskError
          ? { ...value, body: value.disk, base: value.disk } : value);
      }).catch(reason => { if (!ignore) setError(String(reason)); });
    return () => { ignore = true; mounted.current = false; };
  }, [tab.id, workspaceId, path]);
  useEffect(() => { dirty(tab.id, !!document && (document.body !== document.base || saving)); }, [document?.body, document?.base, saving, tab.id, dirty]);

  async function refreshDisk() {
    const before = current.current;
    if (!before || savingRef.current) return;
    try {
      const disk = await invoke<string | null>("read_file_disk", { workspaceId, path });
      if (mounted.current && current.current === before && !savingRef.current && (disk !== before.disk || before.diskError)) {
        const { diskError: _, ...readable } = before;
        if (before.body === before.base && disk !== null) {
          update({ ...readable, body: disk, base: disk, disk });
          setSaveError("");
        } else update({ ...readable, disk });
      }
    } catch (reason) {
      if (mounted.current && current.current === before && !savingRef.current) update({ ...before, disk: null, diskError: String(reason) });
    }
  }
  useEffect(() => {
    if (!active) return;
    let reading = 0;
    function refresh() {
      void refreshDisk();
      const id = ++reading;
      invoke<string>("read_git_file", { workspaceId, path, revision: "HEAD" }).catch(() => null)
        .then(value => { if (id === reading) setGitBase(value); });
    }
    refresh();
    const timer = setInterval(refresh, 1000);
    window.addEventListener("focus", refresh);
    return () => { reading++; clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, [active, workspaceId, path]);

  function persist() {
    const pending = enqueueWrite(tab.id, async () => {
      const next = current.current!;
      await invoke<void>("save_file_draft", { workspaceId, path, body: next.body, base: next.base });
      if (mounted.current) setDraftError("");
    });
    void pending.catch(reason => { if (mounted.current) setDraftError(`Черновик не сохранён: ${String(reason)}`); });
    return pending;
  }
  function change(body: string) {
    if (!current.current || acceptingDisk.current || body === current.current.body) return;
    const next = { ...current.current, body };
    update(next); void persist();
  }
  async function save(overwrite = false): Promise<boolean> {
    if (paused.has(workspaceId)) return false;
    if (savingRef.current) { await savingRef.current; return save(overwrite); }
    const before = current.current;
    if (!before || acceptingDisk.current) return false;
    if (!overwrite && (before.diskError || before.disk !== before.base || before.body === before.base)) {
      await waitForWrites(tab.id).catch(() => persist());
      return !before.diskError && before.disk === before.base;
    }
    if (overwrite && !window.confirm("Заменить внешнюю версию файла текущим черновиком?")) return false;
    let savedFile = false;
    const pending = enqueueWrite(tab.id, async () => {
      const snapshot = current.current!;
      if (mounted.current) { setSaving(true); setSaveError(""); setError(""); }
      try {
        const saved = await invoke<FileDocument>("save_file", { workspaceId, document: snapshot, overwrite });
        update({ ...saved, body: current.current!.body });
        savedFile = true;
        if (mounted.current) { setDraftError(""); setComparison(null); }
      } catch (reason) { if (mounted.current) setSaveError(`Файл не сохранён: ${String(reason)}`); }
    }).then(async () => {
      if (!savedFile || current.current!.body !== current.current!.base) await persist();
      return savedFile;
    });
    savingRef.current = pending;
    try { return await pending; }
    finally {
      savingRef.current = null;
      if (mounted.current) { setSaving(false); void refreshDisk(); }
    }
  }
  async function acceptDisk() {
    const before = current.current;
    if (!before || before.disk === null || savingRef.current || !window.confirm("Удалить ручные правки и принять показанную версию с диска?")) return;
    acceptingDisk.current = true; setSaving(true);
    const next = { ...before, body: before.disk, base: before.disk };
    try {
      await enqueueWrite(tab.id, async () => { await invoke("save_file_draft", { workspaceId, path, body: next.body, base: next.base }); });
      if (mounted.current) { update(next); setDraftError(""); setSaveError(""); setError(""); setComparison(null); }
    } catch (reason) { if (mounted.current) setError(`Черновик не изменён: ${String(reason)}`); }
    finally { acceptingDisk.current = false; if (mounted.current) setSaving(false); }
  }
  useEffect(() => {
    const flush = async () => {
      let saved: boolean;
      do { saved = await save(); await waitForWrites(tab.id); }
      while (saved && current.current && current.current.body !== current.current.base);
    };
    flushers.set(tab.id, flush);
    const leave = () => { void flush().catch(() => {}); };
    const hide = () => { if (window.document.visibilityState === "hidden") leave(); };
    window.addEventListener("blur", leave);
    window.document.addEventListener("visibilitychange", hide);
    return () => {
      if (flushers.get(tab.id) === flush) flushers.delete(tab.id);
      window.removeEventListener("blur", leave);
      window.document.removeEventListener("visibilitychange", hide);
    };
  }, [tab.id, workspaceId, path]);
  useEffect(() => { if (!active || focused === false) void flushFile(tab.id).catch(() => {}); }, [active, focused]);
  useEffect(() => {
    if (!document || document.body === document.base || document.diskError || document.disk !== document.base) return;
    const timer = setTimeout(() => { void save().catch(() => {}); }, 1500);
    return () => clearTimeout(timer);
  }, [document?.body, document?.base, document?.disk, document?.diskError]);
  function compareDisk() {
    const snapshot = current.current;
    if (!snapshot || snapshot.diskError) return;
    setComparison({ a: snapshot.disk ?? "", b: snapshot.body, title: "Файл на диске → текущий текст" });
    setError("");
  }
  const conflict = document && (!!document.diskError || document.disk !== document.base);
  const fileError = draftError || saveError || (conflict ? document.diskError || (document.disk === null ? "Файл удалён снаружи" : "Файл изменён снаружи") : "") || (!document ? error : "");
  useEffect(() => { problem?.(tab.id, fileError); }, [tab.id, fileError, problem]);
  return <section id={tab.id} className="file-panel" role="tabpanel" hidden={!active} aria-label={`Файл ${path}`}>
    {(draftError || saveError || error) && <p role="alert" className="error">{draftError || saveError || error}</p>}
    {!document ? <p>{error ? "Файл недоступен" : "Загрузка файла…"}</p> : <>
      {conflict && <div className="error" role="alert">
        <p>{document.diskError ? `Внешняя версия файла недоступна: ${document.diskError}` : document.disk === null ? "Конфликт: файл удалён снаружи." : "Конфликт: файл изменён снаружи."} Ручные правки сохранены в редакторе.</p>
        {!document.diskError && <>
        <button disabled={saving} onClick={compareDisk}>Сравнить с диском</button>
        {document.disk !== null && <button disabled={saving} onClick={() => void acceptDisk()}>Принять версию с диска</button>}
        <button disabled={saving} onClick={() => void save(true).catch(() => {})}>{document.disk === null ? "Восстановить удалённый файл" : "Заменить файл черновиком"}</button>
        </>}
      </div>}
      <CodeEditor workspaceId={workspaceId} path={path} body={document.body} disk={document.disk} baseline={gitBase ?? document.base} active={active} focused={focused} disabled={acceptingDisk.current} location={location} change={change} save={() => void save().catch(() => {})} addToChat={addToChat} />
      {active && comparison && <><h3>{comparison.title}</h3><button onClick={() => setComparison(null)}>Закрыть сравнение</button><Comparison path={path} a={comparison.a} b={comparison.b} /></>}
    </>}
  </section>;
}
