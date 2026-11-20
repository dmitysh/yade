import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import fuzzysort from "fuzzysort";
import type { SymbolInformation } from "vscode-languageserver-protocol";
import { codeWorkspace, ensureLanguage, languageFor, navigate, symbolItems, type NavigationItem, type NavigationMode } from "./codeIntelligence";
import FileIcon from "./FileIcon";
import { Icon, IdeDialog } from "./Ide";
import type { FileMatch } from "./types";
import "./projectSearch.css";

const modes = { all: "Всё", files: "Файлы", symbols: "Символы", text: "Текст" } as const;
type Mode = keyof typeof modes;
const modeKeys = Object.keys(modes) as Mode[];
const placeholders = { all: "Имя файла, символ или текст", files: "Имя файла или путь", symbols: "Имя символа", text: "Текст в файлах" };
const defaultOptions = { matchCase: false, wholeWord: false, regexp: false, mask: "" };
const textFilters = [
  ["matchCase", "Aa", "Учитывать регистр"],
  ["wholeWord", "W", "Слово целиком"],
  ["regexp", ".*", "Регулярное выражение"],
] as const;
const limit = 100;
const groupLimit = 3;
const debounce = 180;
const fileName = (path: string) => path.split("/").at(-1)!;
type Scope = "project" | "open" | "active";
type Kind = Exclude<Mode, "all">;
type TextResults = { matches: FileMatch[]; truncated: boolean };
type Response<T> = { data?: T; error?: string };
type Result = NavigationItem & { kind: Kind; match?: FileMatch };

export function isProjectSearch(mode: NavigationMode): mode is Mode {
  return Object.hasOwn(modes, mode);
}

function resultKey(result: Result) {
  return JSON.stringify([result.kind, result.path, result.line, result.column, result.name]);
}

function snippet(match: FileMatch, query: string) {
  const found = match.matched ?? query;
  const line = Array.from(match.text);
  const column = match.column - 1;
  const start = Math.max(column - 28, 0);
  const before = (start ? "…" : "") + line.slice(start, column).join("").trimStart();
  const end = column + Array.from(found).length;
  return <>{before}<mark>{found}</mark>{line.slice(end).join("")}</>;
}

export default function ProjectSearch({ workspaceId, projectName, mode, changeMode, activeFile, openFiles, close }: {
  workspaceId: string; projectName?: string; mode: Mode; changeMode: (mode: Mode) => void;
  activeFile: string | null; openFiles: string[]; close: () => void;
}) {
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<Scope>("project");
  const [options, setOptions] = useState(defaultOptions);
  const [index, setIndex] = useState<Response<string[]> | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [openError, setOpenError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const opening = useRef(false);

  const paths = useMemo(() => scope === "project" ? undefined : scope === "open" ? openFiles : activeFile ? [activeFile] : [], [scope, openFiles, activeFile]);
  const indexNeeded = mode !== "text";
  const files = useMemo(() => {
    if (!index?.data) return [];
    const allowed = paths && new Set(paths);
    return allowed ? index.data.filter(path => allowed.has(path)) : index.data;
  }, [index, paths]);
  const nameQuery = query.trim();
  const textQuery = mode === "text" ? query : nameQuery;
  const symbolRequest = useMemo(() => (mode === "symbols" || mode === "all") && nameQuery && files.length
    ? { query: nameQuery, files, paths } : null, [mode, nameQuery, files, paths]);
  const textRequest = useMemo(() => (mode === "text" || mode === "all") && textQuery && (paths === undefined || paths.length)
    ? { workspaceId, query: textQuery, options: { ...(mode === "text" ? options : defaultOptions), paths } } : null, [workspaceId, mode, textQuery, options, paths]);
  const [symbols, setSymbols] = useState<(Response<NavigationItem[]> & { request: typeof symbolRequest }) | null>(null);
  const [text, setText] = useState<(Response<TextResults> & { request: typeof textRequest }) | null>(null);

  useEffect(() => {
    if (!indexNeeded || index) return;
    let disposed = false;
    invoke<string[]>("list_source_files", { workspaceId })
      .then(data => { if (!disposed) setIndex({ data }); })
      .catch(reason => { if (!disposed) setIndex({ error: String(reason) }); });
    return () => { disposed = true; };
  }, [indexNeeded, index, workspaceId]);

  useEffect(() => {
    if (!symbolRequest) return;
    let disposed = false;
    const cancellations: (() => void)[] = [];
    const params = { query: symbolRequest.query };
    const timer = setTimeout(() => {
      const languages = new Set(symbolRequest.files.map(languageFor).filter(language => language !== null));
      void Promise.allSettled([...languages].map(async language => {
        const client = await ensureLanguage(workspaceId, language);
        if (disposed) return [];
        client.sync();
        cancellations.push(() => client.cancelRequest(params));
        const value = await client.request<object, SymbolInformation[] | null>("workspace/symbol", params);
        const root = codeWorkspace(workspaceId).sessions.get(language)!.rootUri!;
        return symbolItems(value ?? [], root);
      })).then(responses => {
        if (disposed) return;
        const allowed = symbolRequest.paths && new Set(symbolRequest.paths);
        const data = responses.flatMap(response => response.status === "fulfilled" ? response.value : [])
          .filter(item => !allowed || allowed.has(item.path));
        const failed = responses.flatMap(response => response.status === "rejected"
          ? [response.reason instanceof Error ? response.reason.message : String(response.reason)] : []);
        setSymbols({ request: symbolRequest, data, error: failed.join(" · ") || undefined });
      });
    }, debounce);
    return () => { disposed = true; clearTimeout(timer); cancellations.forEach(cancel => cancel()); };
  }, [workspaceId, symbolRequest]);

  useEffect(() => {
    if (!textRequest) return;
    let disposed = false;
    const timer = setTimeout(() => {
      invoke<TextResults>("search_files", textRequest)
        .then(data => { if (!disposed) setText({ request: textRequest, data }); })
        .catch(reason => { if (!disposed) setText({ request: textRequest, error: String(reason) }); });
    }, debounce);
    return () => { disposed = true; clearTimeout(timer); };
  }, [textRequest]);

  const currentSymbols = symbols?.request === symbolRequest ? symbols : null;
  const currentText = text?.request === textRequest ? text : null;
  const workspace = codeWorkspace(workspaceId);
  const recent = new Set([activeFile, ...workspace.history.slice().reverse().map(item => item.path), ...openFiles]);
  const fileSource = useMemo(() => files.map(path => ({ path, name: fileName(path), line: 1, column: 1 })), [files]);
  const allowed = useMemo(() => new Map(fileSource.map(file => [file.path, file])), [fileSource]);
  const recentFiles = [...recent].flatMap(path => path && allowed.has(path) ? [allowed.get(path)!] : []);
  const fileHits = nameQuery && (mode === "all" || mode === "files")
    ? fuzzysort.go(nameQuery, fileSource, { keys: ["name", "path"], limit, threshold: 0 }) : null;
  const fileMatches = fileHits?.map(result => result.obj) ?? (mode === "all" ? recentFiles : [...new Set([...recentFiles, ...fileSource])]);
  const symbolSource = currentSymbols?.data ?? [];
  const symbolHits = nameQuery && symbolSource.length ? fuzzysort.go(nameQuery, symbolSource, { keys: ["name", "path"], limit, threshold: 0 }) : null;
  const symbolMatches = symbolHits?.map(result => result.obj) ?? [];
  const textMatches = currentText?.data?.matches ?? [];
  const groups: [Kind, Omit<Result, "kind">[]][] = [
    ["files", fileMatches],
    ["symbols", symbolMatches],
    ["text", textMatches.map(match => ({ ...match, name: match.text, match }))],
  ];
  const items: Result[] = groups.filter(([kind]) => mode === "all" || mode === kind).flatMap(([kind, results]) =>
    results.slice(0, mode === "all" && nameQuery ? groupLimit : kind === "text" ? results.length : limit)
      .map(result => ({ ...result, kind })));
  const totals = { files: fileHits?.total ?? fileMatches.length, symbols: symbolHits?.total ?? symbolMatches.length, text: textMatches.length };
  const total = mode === "all" ? totals.files + totals.symbols + totals.text : totals[mode];
  const selectedIndex = Math.max(0, items.findIndex(result => resultKey(result) === selected));
  const busy = (indexNeeded && !index) || (!!symbolRequest && !currentSymbols) || (!!textRequest && !currentText);
  const notice = [openError, indexNeeded && index?.error, currentSymbols?.error && `Символы: ${currentSymbols.error}`, currentText?.error].filter(Boolean).join(" · ");

  useEffect(() => { input.current?.focus(); }, [mode]);
  useEffect(() => {
    setSelected(null);
    setOpenError("");
    if (list.current) list.current.scrollTop = 0;
  }, [query, mode, scope, options]);
  useEffect(() => {
    if (scope === "active" && !activeFile) setScope("project");
  }, [scope, activeFile]);
  useEffect(() => {
    if (selected !== null) list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest" });
  }, [selected, selectedIndex]);

  async function choose(result: Result) {
    if (opening.current) return;
    opening.current = true;
    setOpenError("");
    const { path, line, column, utf16, match } = result;
    try {
      await navigate(workspaceId, { path, line, column, utf16, ...(match && { text: match.text, query: match.matched ?? textQuery }) });
      close();
    } catch (reason) { setOpenError(String(reason)); }
    finally { opening.current = false; }
  }

  return <IdeDialog title="Поиск по проекту" titleDetail={projectName} close={close} dismissOutside className="ide-project-search-dialog">
    <div className="ide-project-search" onKeyDown={event => {
      if (!event.altKey || event.metaKey || event.ctrlKey || event.shiftKey || event.nativeEvent.isComposing) return;
      const index = Number(event.code.match(/^Digit([1-4])$/)?.[1]) - 1;
      if (modeKeys[index]) { event.preventDefault(); changeMode(modeKeys[index]); input.current?.focus(); }
    }}>
      <div className="ide-project-search-tools">
        <form className="ide-search-input ide-project-search-field" onSubmit={event => {
          event.preventDefault();
          if (items[selectedIndex]) void choose(items[selectedIndex]);
        }}>
          <Icon name="search" /><input ref={input} autoFocus autoComplete="off" spellCheck={false} aria-label="Поисковый запрос"
            role="combobox" aria-expanded="true" aria-autocomplete="list" aria-controls="code-result-list"
            aria-activedescendant={items[selectedIndex] && `code-result-${selectedIndex}`}
            value={query} placeholder={placeholders[mode]} onChange={event => setQuery(event.target.value)} onKeyDown={event => {
              if (event.nativeEvent.isComposing || event.altKey || event.metaKey || event.ctrlKey || !items.length) return;
              if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
              event.preventDefault();
              const next = (selectedIndex + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
              setSelected(resultKey(items[next]));
            }} />
          {query && <button type="button" className="ide-icon-button" aria-label="Очистить запрос" onClick={() => { setQuery(""); input.current?.focus(); }}><Icon name="close" /></button>}
          {mode === "text" && <div className="ide-project-search-options">{textFilters.map(([key, label, title]) =>
            <button key={key} type="button" aria-label={title} title={title} aria-pressed={options[key]} onClick={() => {
              setOptions(current => ({ ...current, [key]: !current[key] })); input.current?.focus();
            }}>{label}</button>)}</div>}
        </form>
        <div className="ide-project-search-filters">
          <div role="tablist" aria-label="Тип результатов" className="ide-project-search-tabs" onKeyDown={event => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            changeMode(modeKeys[(modeKeys.indexOf(mode) + (event.key === "ArrowRight" ? 1 : -1) + modeKeys.length) % modeKeys.length]);
          }}>
            {modeKeys.map((key, index) => <button key={key} id={`project-search-tab-${key}`} role="tab" aria-selected={key === mode}
              aria-controls="project-search-panel" tabIndex={key === mode ? 0 : -1} title={`⌥${index + 1}`} onClick={() => { changeMode(key); input.current?.focus(); }}>{modes[key]}</button>)}
          </div>
          <div className="ide-project-search-scope"><Icon name="project" />
            <select aria-label="Область поиска" value={scope} onChange={event => { setScope(event.target.value as Scope); input.current?.focus(); }}>
              <option value="project">Всё пространство</option>
              <option value="open">Открытые файлы</option>
              <option value="active" disabled={!activeFile}>Текущий файл</option>
            </select>
          </div>
        </div>
        {mode === "text" && <label className="ide-project-search-mask">Маска файлов
          <input value={options.mask} placeholder="*.go, *.ts" onChange={event => setOptions(current => ({ ...current, mask: event.target.value }))} />
        </label>}
      </div>
      {notice && <p role="alert" className="ide-project-search-notice">{notice}</p>}
      <div className="ide-project-search-panel" role="tabpanel" id="project-search-panel" aria-labelledby={`project-search-tab-${mode}`}>
        <div ref={list} id="code-result-list" className="ide-project-search-results" role="listbox" aria-label="Результаты поиска" aria-busy={busy}>
          {items.map((item, index) => {
            const heading = mode === "all" && item.kind !== items[index - 1]?.kind;
            const highlights = item.match ? snippet(item.match, textQuery) : nameQuery
              ? fuzzysort.single(nameQuery, item.name)?.highlight((part, index) => <mark key={index}>{part}</mark>) : undefined;
            return <Fragment key={resultKey(item)}>
              {heading && <div role="presentation" className="ide-project-search-group">{nameQuery ? modes[item.kind] : "Недавние файлы"}</div>}
              <button type="button" role="option" tabIndex={-1} id={`code-result-${index}`} aria-selected={index === selectedIndex}
                title={item.kind === "files" ? item.path : `${item.path}:${item.line}:${item.column}`} className="ide-project-search-result"
                onMouseDown={event => event.preventDefault()} onClick={() => void choose(item)}>
                {item.kind === "symbols" ? <Icon name="layers" /> : <FileIcon path={item.path} />}
                <span className={item.kind === "text" ? "ide-project-search-snippet" : ""}>{highlights ?? item.name}</span>
                <small>{item.kind === "files" ? item.path.slice(0, -(item.name.length + 1)) : `${item.path}:${item.line}`}</small>
              </button>
            </Fragment>;
          })}
          {!items.length && <p className="ide-project-search-empty">{busy ? "Поиск…" : !textQuery ? "Введите запрос" : "Совпадений нет"}</p>}
        </div>
      </div>
      <div className="ide-project-search-footer">
        <span role="status">{busy ? "Поиск…" : currentText?.data?.truncated ? `Показано ${items.length} · Уточните запрос`
          : items.length < total ? `Показано ${items.length} из ${total}` : `Результатов: ${total}`}</span>
        <div><span><kbd>↑</kbd><kbd>↓</kbd> выбрать</span><span><kbd>↵</kbd> открыть</span><span><kbd>Esc</kbd> закрыть</span></div>
      </div>
    </div>
  </IdeDialog>;
}
