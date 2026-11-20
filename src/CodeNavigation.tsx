import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { EditorState } from "@codemirror/state";
import { LSPPlugin } from "@codemirror/lsp-client";
import { diff } from "@codemirror/merge";
import fuzzysort from "fuzzysort";
import type { DocumentSymbol, TextEdit, WorkspaceEdit } from "vscode-languageserver-protocol";
import { Comparison, type FileLocation } from "./CodeEditor";
import { Icon, IdeDialog } from "./Ide";
import GitMenu from "./GitMenu";
import FileIcon from "./FileIcon";
import ProjectSearch, { isProjectSearch } from "./ProjectSearch";
import { pauseFileSaving, renameDocument, replaceFileDocuments } from "./Files";
import type { FileDocument } from "./types";
import {
  activeEditor, applyTextEdits, codeChanged, codeWorkspace, fileFromUri, fileUri, languageFor,
  navigate, navigateHistory, releaseWorkspace, requestLocations, retryLanguage, symbolItems, useCodeRevision,
  type NavigationItem, type NavigationMode,
} from "./codeIntelligence";
import { formatShortcut, useShortcutHandlers, useShortcuts } from "./shortcuts";
import "./codeNavigation.css";

const titles: Record<NavigationMode, string> = { all: "Поиск по проекту", files: "Найти файл", symbols: "Найти символ", text: "Найти текст", structure: "Структура файла", problems: "Проблемы", line: "Перейти к строке", rename: "Переименовать символ" };
const noOpenFiles: string[] = [];

export default function CodeNavigation({ workspaceId, open, reveal, toolbar = true, projectName, openFiles = noOpenFiles, activeFile }: {
  workspaceId: string; open: (path: string, location?: FileLocation) => Promise<void>; reveal?: () => void; toolbar?: boolean;
  projectName?: string; openFiles?: string[]; activeFile?: string | null;
}) {
  useCodeRevision();
  const { bindings, hint } = useShortcuts();
  const [mode, setMode] = useState<NavigationMode | null>(null);
  const [fixed, setFixed] = useState<{ items: NavigationItem[]; title: string } | null>(null);
  const [error, setError] = useState("");
  const [dismissedLanguageError, setDismissedLanguageError] = useState("");
  const [installing, setInstalling] = useState(false);
  const openRef = useRef(open); openRef.current = open;
  const workspace = codeWorkspace(workspaceId);
  function show(mode: NavigationMode) { reveal?.(); setFixed(null); setMode(mode); setError(""); }
  function close() { setMode(null); setFixed(null); requestAnimationFrame(() => { if (workspace.visible) activeEditor(workspaceId)?.focus(); }); }
  useEffect(() => {
    workspace.visible = true;
    workspace.open = (path, location) => openRef.current(path, location);
    workspace.request = (mode, items, title) => { setFixed(items ? { items, title: title ?? titles[mode] } : null); setMode(mode); };
    return () => releaseWorkspace(workspaceId);
  }, [workspaceId]);
  useShortcutHandlers({
    searchEverywhere: () => show("all"), findFile: () => show("files"),
    findSymbol: () => show("symbols"), structure: () => show("structure"), line: () => show("line"),
  });
  const current = workspace.activePath ? workspace.sessions.get(languageFor(workspace.activePath)!) : null;
  const languageError = current?.status === "missing" && current.error !== dismissedLanguageError ? current.error : "";
  const problems = [...workspace.diagnostics.values()].reduce((count, diagnostics) => count + diagnostics.length, 0);
  function locations(method: string) {
    const view = activeEditor(workspaceId);
    if (!view) return;
    void requestLocations(workspaceId, view, method).catch(reason => setError(String(reason)));
  }
  async function retry(install = false) {
    if (!current) return;
    setInstalling(true); setError(""); setDismissedLanguageError("");
    try { await retryLanguage(workspaceId, current.language, install); }
    catch (reason) { setError(String(reason)); }
    finally { setInstalling(false); }
  }
  return <>
    <div className="ide-code-navigation" aria-label="Навигация по коду" hidden={!toolbar}>
      <button className="ide-icon-button" aria-label="Назад по коду" title={"Назад" + hint("back")} disabled={workspace.index < 1} onClick={() => void navigateHistory(workspaceId, -1).catch(reason => setError(String(reason)))}><Icon name="arrow-left" /></button>
      <button className="ide-icon-button" aria-label="Вперёд по коду" title={"Вперёд" + hint("forward")} disabled={workspace.index >= workspace.history.length - 1} onClick={() => void navigateHistory(workspaceId, 1).catch(reason => setError(String(reason)))}><Icon name="arrow-right" /></button>
      <button className="ide-code-search" title={titles.all + hint("searchEverywhere")} onClick={() => show("all")}><Icon name="search" /><span>{titles.all}</span>{bindings.searchEverywhere && <kbd>{formatShortcut(bindings.searchEverywhere)}</kbd>}</button>
      <span className="ide-toolbar-spacer" />
      {current?.status === "starting" && <small role="status">Подключение языка…</small>}
      {current?.status === "missing" && <button disabled={installing} title={current.error} onClick={() => void retry(!current.prerequisite)}>{installing ? "Подготовка…" : current.prerequisite ? "Повторить проверку" : "Установить поддержку языка"}</button>}
      {current?.status === "trust" && <button disabled={installing} title={current.error} onClick={() => void retry()}>Подключить навигацию</button>}
      {current?.status === "error" && <button disabled={installing} title={current.error} onClick={() => void retry()}>Повторить подключение</button>}
      <button className="ide-code-problems" title="Ошибки и предупреждения" aria-label={`Проблемы: ${problems}`} onClick={() => show("problems")}><Icon name="info" /><span>{problems}</span></button>
      <GitMenu label="Команды навигации" items={[
        { label: "Найти файл" + hint("findFile"), icon: "file", run: () => show("files") },
        { label: "Найти символ" + hint("findSymbol"), icon: "search", run: () => show("symbols") },
        { label: "Структура файла" + hint("structure"), icon: "layers", run: () => show("structure") },
        { label: "К объявлению или использованиям" + hint("definition"), icon: "arrow-right", run: () => locations("textDocument/definition"), disabled: !workspace.activePath },
        { label: "К типу" + hint("typeDefinition"), run: () => locations("textDocument/typeDefinition"), disabled: !workspace.activePath },
        { label: "К реализации" + hint("implementation"), run: () => locations("textDocument/implementation"), disabled: !workspace.activePath },
        { label: "Использования" + hint("references"), run: () => locations("textDocument/references"), disabled: !workspace.activePath },
        { label: "Перейти к строке" + hint("line"), run: () => show("line"), disabled: !workspace.activePath },
        { label: "Переименовать символ" + hint("rename"), icon: "edit", run: () => show("rename"), disabled: !workspace.activePath || !!activeEditor(workspaceId)?.state.readOnly },
      ]} />
    </div>
    {(error || languageError) && <p className="ide-code-notice error" role="alert">{error || languageError}<button className="ide-icon-button" aria-label="Закрыть сообщение навигации" onClick={() => { setError(""); setDismissedLanguageError(current?.error || ""); }}><Icon name="close" /></button></p>}
    {mode === "rename" ? <RenameSymbol workspaceId={workspaceId} close={close} />
      : mode && !fixed && isProjectSearch(mode) ? <ProjectSearch workspaceId={workspaceId} projectName={projectName} mode={mode} changeMode={setMode}
        activeFile={activeFile === undefined ? workspace.activePath : activeFile} openFiles={openFiles} close={close} />
      : mode && <NavigationSearch workspaceId={workspaceId} mode={mode} fixed={fixed} close={close} />}
  </>;
}

function NavigationSearch({ workspaceId, mode, fixed, close }: { workspaceId: string; mode: NavigationMode; fixed: { items: NavigationItem[]; title: string } | null; close: () => void }) {
  useCodeRevision();
  const [query, setQuery] = useState("");
  const [symbols, setSymbols] = useState<NavigationItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState(0);
  const results = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [anchor] = useState(() => {
    const editor = fixed && activeEditor(workspaceId);
    return editor ? editor.coordsAtPos(editor.state.selection.main.head) ?? undefined : undefined;
  });
  useEffect(() => { input.current?.focus(); setError(""); }, [mode, fixed]);
  useEffect(() => {
    if (fixed || mode !== "structure") return;
    const view = activeEditor(workspaceId), plugin = view && LSPPlugin.get(view);
    if (!plugin) { setError("Откройте файл Go или TypeScript / JavaScript и дождитесь подключения языка"); return; }
    let disposed = false;
    setBusy(true);
    plugin.client.sync();
    const params = { textDocument: { uri: plugin.uri } };
    plugin.client.request<object, DocumentSymbol[] | null>("textDocument/documentSymbol", params).then(value => {
      if (disposed) return;
      const root = codeWorkspace(workspaceId).sessions.get(languageFor(plugin.uri)!)!.rootUri!;
      setSymbols(symbolItems(value ?? [], root, plugin.uri));
    }).catch(reason => { if (!disposed) setError(String(reason)); }).finally(() => { if (!disposed) setBusy(false); });
    return () => { disposed = true; plugin.client.cancelRequest(params); };
  }, [workspaceId, mode, fixed]);
  const workspace = codeWorkspace(workspaceId);
  const problems: NavigationItem[] = mode === "problems" ? [...workspace.diagnostics].flatMap(([uri, diagnostics]) => {
    const root = [...workspace.sessions.values()].find(value => value.rootUri)?.rootUri;
    return !root ? [] : diagnostics.map(diagnostic => ({ path: fileFromUri(root, uri), name: typeof diagnostic.message === "string" ? diagnostic.message : diagnostic.message.value, detail: `${diagnostic.severity === 1 ? "Ошибка" : "Предупреждение"} · ${fileFromUri(root, uri)}:${diagnostic.range.start.line + 1}`, line: diagnostic.range.start.line + 1, column: diagnostic.range.start.character + 1, utf16: true }));
  }) : [];
  const source: NavigationItem[] = fixed?.items ?? (mode === "problems" ? problems : symbols);
  const items = query ? fuzzysort.go(query, source, { keys: ["name", "path", "code"], limit: 100, threshold: 0 }).map(result => result.obj) : source.slice(0, 100);
  useEffect(() => { setSelected(0); }, [query, mode, fixed]);
  useEffect(() => { setSelected(current => Math.max(0, Math.min(current, items.length - 1))); }, [items.length]);
  useEffect(() => { results.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" }); }, [selected]);
  async function choose(item: NavigationItem) {
    try { await navigate(workspaceId, item); close(); }
    catch (reason) { setError(String(reason)); }
  }
  async function line(event: React.FormEvent) {
    event.preventDefault();
    const match = query.match(/^(\d+)(?::(\d+))?$/), view = activeEditor(workspaceId);
    if (!match || !view || !workspace.activePath || +match[1] < 1 || +match[1] > view.state.doc.lines || (match[2] && +match[2] < 1)) { setError("Введите существующую строку или строка:столбец"); return; }
    await choose({ path: workspace.activePath, name: "", line: +match[1], column: +(match[2] ?? 1), utf16: true });
  }
  return <IdeDialog title={fixed?.title ?? titles[mode]} close={close} anchor={anchor} className={`ide-code-search-dialog${fixed ? " ide-code-targets-dialog" : ""}`}>
    <form className="ide-search-input" onSubmit={event => { if (mode === "line") void line(event); else { event.preventDefault(); if (items[selected]) void choose(items[selected]); } }}>
      <Icon name={mode === "line" ? "arrow-right" : "search"} /><input ref={input} autoFocus autoComplete="off" role={mode === "line" ? "textbox" : "combobox"} aria-expanded={mode === "line" ? undefined : true} aria-autocomplete={mode === "line" ? undefined : "list"} aria-label={mode === "line" ? "Строка и столбец" : "Поисковый запрос"} placeholder={mode === "line" ? "Строка:столбец" : fixed ? "Фильтр по файлу или коду…" : "Начните вводить имя…"} value={query} onChange={event => setQuery(event.target.value)} aria-controls="code-search-results" aria-activedescendant={items[selected] ? `code-result-${selected}` : undefined} onKeyDown={event => {
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) && items.length) {
          event.preventDefault(); setSelected(current => event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length);
        }
      }} />{mode === "line" && <button type="submit">Перейти</button>}
    </form>
    {error && <p role="alert" className="ide-code-notice error">{error}</p>}
    {mode !== "line" && <div className="ide-code-search-results" id="code-search-results" role="listbox" aria-label="Результаты навигации" ref={results} aria-busy={busy}>
      {items.map((item, index) => <button type="button" role="option" id={`code-result-${index}`} aria-selected={index === selected} className="ide-search-result" title={`${item.path}:${item.line}:${item.column}`} key={`${item.path}:${item.line}:${item.column}:${index}`} onMouseMove={() => setSelected(index)} onClick={() => void choose(item)}><FileIcon path={item.path} />{fixed ? <><span className="ide-code-target-file">{item.name}</span><span className="ide-code-target-line">{item.line}</span><code>{item.code ?? item.detail ?? item.path}</code></> : <><span><strong>{item.name}</strong><small>{item.detail ?? item.path}</small></span><span>{item.line > 1 ? `:${item.line}` : "↵"}</span></>}</button>)}
      {!items.length && <p className="ide-search-empty" role="status">{busy ? "Поиск…" : mode === "problems" ? "Языковой сервер пока не сообщил о проблемах" : "Ничего не найдено"}</p>}
    </div>}
    <div className="ide-search-footer"><span>{busy ? "Поиск…" : mode === "line" ? "Нумерация с 1" : source.length > 100 ? "Первые 100 результатов · уточните запрос" : `Результатов: ${items.length}`}</span><span>↑ ↓ выбрать · Enter открыть · Esc закрыть</span></div>
  </IdeDialog>;
}

interface RenameEdit { document: FileDocument; body: string }
function RenameSymbol({ workspaceId, close }: { workspaceId: string; close: () => void }) {
  const [view] = useState(() => activeEditor(workspaceId));
  const word = view?.state.wordAt(view.state.selection.main.head);
  const [name, setName] = useState(() => word && view ? view.state.sliceDoc(word.from, word.to) : "");
  const [edits, setEdits] = useState<RenameEdit[]>([]);
  const [selected, setSelected] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pause = useRef<Promise<() => void> | null>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const disposed = useRef(false);
  useEffect(() => {
    disposed.current = false;
    nameInput.current?.focus(); nameInput.current?.select();
    pause.current = pauseFileSaving(workspaceId);
    void pause.current.catch(reason => { if (!disposed.current) setError(String(reason)); });
    return () => { disposed.current = true; void pause.current?.then(resume => resume()).catch(() => {}); };
  }, [workspaceId]);
  async function preview() {
    setBusy(true); setError("");
    try {
      await pause.current;
      const plugin = view && LSPPlugin.get(view);
      if (!plugin || !word || view.state.readOnly) throw new Error("Выберите символ в редактируемом файле и дождитесь подключения языка");
      plugin.client.sync();
      const snapshots = new Map(plugin.client.workspace.files.map(file => [file.uri, file.getView()?.state.sliceDoc()]));
      const result = await plugin.client.request<object, WorkspaceEdit | null>("textDocument/rename", { textDocument: { uri: plugin.uri }, position: plugin.toPosition(word.from), newName: name.trim() });
      const changes = new Map<string, TextEdit[]>(Object.entries(result?.changes ?? {}));
      for (const change of result?.documentChanges ?? []) {
        if (!("textDocument" in change)) throw new Error("Операция также меняет имена файлов; такое переименование не поддерживается");
        if (change.textDocument.version !== null && change.textDocument.version !== undefined && plugin.client.workspace.getFile(change.textDocument.uri)?.version !== change.textDocument.version) throw new Error("Документ изменился после запроса; повторите просмотр");
        const textEdits = change.edits.map(edit => { if (!("newText" in edit)) throw new Error("Языковой сервер предложил шаблон вместо текстовой правки"); return edit; });
        changes.set(change.textDocument.uri, [...(changes.get(change.textDocument.uri) ?? []), ...textEdits]);
      }
      const root = codeWorkspace(workspaceId).sessions.get(languageFor(plugin.uri)!)!.rootUri!;
      const prepared: RenameEdit[] = [];
      for (const [uri, changesForFile] of changes) {
        const path = fileFromUri(root, uri);
        if (path.startsWith("file:")) throw new Error("Переименование затрагивает внешнюю зависимость, доступную только для чтения");
        const document = await renameDocument(workspaceId, path);
        if (snapshots.get(uri) !== undefined && snapshots.get(uri) !== document.body) throw new Error(`${path}: текст изменился после запроса`);
        const body = applyTextEdits(document.body, changesForFile);
        if (body !== document.body) prepared.push({ document, body });
      }
      if (!prepared.length) throw new Error("Языковой сервер не предложил изменений");
      if (!disposed.current) { setEdits(prepared); setSelected(0); }
    } catch (reason) { if (!disposed.current) setError(String(reason)); }
    finally { if (!disposed.current) setBusy(false); }
  }
  async function apply() {
    setBusy(true); setError("");
    try {
      for (const edit of edits) {
        const current = await renameDocument(workspaceId, edit.document.path);
        if (current.body !== edit.document.body || current.base !== edit.document.base) throw new Error(`${current.path}: текст изменился; повторите предварительный просмотр`);
      }
      const updated = await invoke<FileDocument[]>("apply_file_edits", { workspaceId, edits });
      replaceFileDocuments(workspaceId, updated);
      const workspace = codeWorkspace(workspaceId);
      for (const document of updated) {
        const editor = workspace.editors.get(document.path);
        if (!editor) continue;
        const body = EditorState.create({ doc: document.body }).doc.toString();
        editor.dispatch({ changes: diff(editor.state.doc.toString(), body).map(change => ({ from: change.fromA, to: change.toA, insert: body.slice(change.fromB, change.toB) })), userEvent: "input.rename" });
      }
      for (const value of workspace.sessions.values()) {
        if (value.client && value.rootUri) {
          value.client.sync();
          value.client.notification("workspace/didChangeWatchedFiles", { changes: updated.map(document => ({ uri: fileUri(value.rootUri!, document.path), type: 2 })) });
        }
      }
      close();
    } catch (reason) { if (!disposed.current) { setError(String(reason)); setEdits([]); } }
    finally { if (!disposed.current) setBusy(false); }
  }
  return <IdeDialog title="Переименовать символ" close={() => { if (!busy) close(); }} className={`ide-rename-dialog ${edits.length ? "has-preview" : ""}`}>
    <form onSubmit={event => { event.preventDefault(); void (edits.length ? apply() : preview()); }}>
      <label className="ide-rename-name">Новое имя<input ref={nameInput} autoFocus value={name} disabled={busy} onChange={event => { setName(event.target.value); setEdits([]); }} required /></label>
      {error && <p role="alert" className="ide-code-notice error">{error}</p>}
      {!!edits.length && <><p className="ide-rename-summary">Изменения в {edits.length} файлах. Текущие несохранённые правки включены в сравнение.</p><div className="ide-rename-preview"><div className="ide-rename-files" role="listbox" aria-label="Файлы переименования">{edits.map((edit, index) => <button type="button" role="option" aria-selected={selected === index} key={edit.document.path} onClick={() => setSelected(index)}><FileIcon path={edit.document.path} /><span>{edit.document.path}</span></button>)}</div><div className="ide-rename-code"><div className="ide-rename-labels"><span>Текущий текст</span><span>После переименования</span></div><Comparison path={edits[selected].document.path} a={edits[selected].document.body} b={edits[selected].body} /></div></div></>}
      <div className="ide-rename-actions"><button type="button" disabled={busy} onClick={close}>Отмена</button><button type="submit" className="primary" disabled={busy || !name.trim()}>{busy ? "Выполняется…" : edits.length ? "Применить переименование" : "Предварительный просмотр"}</button></div>
    </form>
  </IdeDialog>;
}
