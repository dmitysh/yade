import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Icon, Splitter } from "./Ide";
import FileIcon from "./FileIcon";
import SettingsSelect from "./SettingsSelect";
import { commitGraph } from "./gitState";
import GitMenu from "./GitMenu";
import type { GitBranch, GitCommit, GitCommitDetails, GitHistory, GitStatus, GitTarget } from "./types";

export default function GitHistoryView({ target, status, branches, reference, revision, busy, active, compare, action, network }: {
  target: GitTarget; status: GitStatus; branches: GitBranch[]; reference: string; revision: number; busy: boolean; active: boolean;
  compare: (commit: string, path: string) => void; action: (kind: string, reference: string, title: string) => void;
  network: (kind: "fetch" | "pull" | "push") => void;
}) {
  const [query, setQuery] = useState("");
  const [author, setAuthor] = useState("");
  const [filter, setFilter] = useState(reference);
  const [history, setHistory] = useState<GitHistory | null>(null);
  const [selected, setSelected] = useState<GitCommit | null>(null);
  const [details, setDetails] = useState<GitCommitDetails | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [more, setMore] = useState(false);
  const request = useRef(0);
  const [copied, setCopied] = useState(false);
  const [detailsWidth, setDetailsWidth] = useState(300);
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!active) return;
    function keydown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f" && !document.querySelector("dialog[open]")) {
        event.preventDefault(); search.current?.focus(); search.current?.select();
      }
    }
    window.addEventListener("keydown", keydown); return () => window.removeEventListener("keydown", keydown);
  }, [active]);
  useEffect(() => setFilter(reference), [reference]);
  useEffect(() => {
    const id = ++request.current;
    setLoading(true); setError(""); setHistory(null); setSelected(null); setDetails(null);
    const timer = setTimeout(() => {
      invoke<GitHistory>("git_history", { target, options: { reference: filter || null, query, author, offset: 0 } }).then(value => {
        if (id !== request.current) return;
        setHistory(value); setSelected(value.commits[0] ?? null);
      }).catch(reason => { if (id === request.current) setError(String(reason)); })
        .finally(() => { if (id === request.current) setLoading(false); });
    }, 180);
    return () => { clearTimeout(timer); ++request.current; };
  }, [target.workspaceId, target.repository, filter, query, author, revision]);
  useEffect(() => {
    setDetails(null); setCopied(false);
    if (!selected) return;
    let ignore = false;
    invoke<GitCommitDetails>("git_commit_details", { target, reference: selected.hash }).then(value => { if (!ignore) setDetails(value); })
      .catch(reason => { if (!ignore) setError(String(reason)); });
    return () => { ignore = true; };
  }, [selected?.hash]);
  async function loadMore() {
    if (!history || more) return;
    const id = request.current;
    setMore(true);
    try {
      const next = await invoke<GitHistory>("git_history", { target, options: { reference: filter || null, query, author, offset: history.commits.length } });
      if (id === request.current) setHistory({ ...next, commits: [...history.commits, ...next.commits] });
    } catch (reason) { if (id === request.current) setError(String(reason)); }
    finally { setMore(false); }
  }
  const graph = commitGraph(history?.commits ?? []);
  const width = Math.max(2, ...graph.map(row => row.width)) * 18 + 16;
  return <section className="git-history" aria-label="История коммитов">
    <div className="git-history-toolbar">
      <label className="git-search"><Icon name="search" /><input ref={search} aria-label="Поиск коммитов" placeholder="Сообщение, автор или хеш…" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <SettingsSelect label="Ветка истории" value={filter} change={value => setFilter(value ?? "")} placeholder="Все ветки" hideLabel
        choices={branches.map(branch => ({ value: branch.reference, label: branch.name }))} />
      <label className="git-author-filter"><input aria-label="Автор коммитов" placeholder="Все авторы" value={author} onChange={event => setAuthor(event.target.value)} /></label>
      <span className="ide-toolbar-spacer" />
      <button className="ide-icon-button" aria-label="Получить изменения" title="Получить изменения" disabled={busy || !status.remotes.length} onClick={() => network("fetch")}><Icon name="download" /></button>
      <button className="ide-icon-button" aria-label="Обновить ветку" title={`Обновить ветку${status.behind ? ` · ${status.behind}` : ""}`} disabled={busy || !status.upstream} onClick={() => network("pull")}><Icon name="refresh" /></button>
      <button className="ide-icon-button" aria-label="Отправить коммиты" title={`Отправить коммиты${status.ahead ? ` · ${status.ahead}` : ""}`} disabled={busy || !status.remotes.length} onClick={() => network("push")}><Icon name="send" /></button>
    </div>
    {error && <pre className="git-notice error" role="alert">{error}</pre>}
    <div className="git-history-body">
      <div className="git-log">
        <div className="git-log-header" style={{ paddingLeft: width + 12 }}><span>Сообщение</span><span>Автор</span><span>Хеш</span><span>Время</span></div>
        {loading ? <p className="git-empty" role="status">Загрузка истории…</p> : !history?.commits.length ? <p className="git-empty">Коммиты не найдены</p> : <div className="git-log-rows" role="list" aria-label="Коммиты">
          {history.commits.map((commit, index) => <div role="listitem" key={commit.hash}><GitMenu label={`Действия коммита ${commit.hash.slice(0, 7)}`} disabled={busy || !active} items={[
            { label: "Скопировать хеш", icon: "copy", run: () => { void navigator.clipboard.writeText(commit.hash).catch(reason => setError(String(reason))); } },
            { label: "Применить коммит…", icon: "git", run: () => action("cherry_pick", commit.hash, "Применить коммит в текущей ветке?") },
            { label: "Отменить коммит…", icon: "history", run: () => action("revert", commit.hash, "Создать обратный коммит?") },
            { label: "Создать ветку…", icon: "plus", run: () => action("create_branch", commit.hash, "Новая ветка от коммита") },
            { label: "Создать тег…", icon: "tag", run: () => action("create_tag", commit.hash, "Новый тег") },
          ]}><button className={`git-log-row ${selected?.hash === commit.hash ? "selected" : ""}`} aria-current={selected?.hash === commit.hash ? "true" : undefined} onClick={() => { setError(""); setSelected(commit); }} onKeyDown={event => {
            if (!["ArrowUp", "ArrowDown"].includes(event.key)) return;
            event.preventDefault(); const next = history.commits[index + (event.key === "ArrowDown" ? 1 : -1)];
            if (next) { setSelected(next); event.currentTarget.closest(".git-log-rows")?.querySelectorAll<HTMLButtonElement>(".git-log-row")[index + (event.key === "ArrowDown" ? 1 : -1)]?.focus(); }
          }}>
            <svg className="git-graph" width={width} height="34" viewBox={`0 0 ${width} 34`} aria-hidden="true">
              {graph[index].edges.map((edge, i) => <path key={i} d={`M ${edge.from * 18 + 20} ${edge.from === graph[index].column ? 17 : 0} C ${edge.from * 18 + 20} 25, ${edge.to * 18 + 20} 25, ${edge.to * 18 + 20} 34`} stroke={edge.from % 2 ? "#69c4a5" : "#a17ce0"} fill="none" strokeWidth="2" />)}
              {index > 0 && graph[index - 1].edges.some(edge => edge.to === graph[index].column) && <path d={`M ${graph[index].column * 18 + 20} 0 V17`} stroke={graph[index].column % 2 ? "#69c4a5" : "#a17ce0"} strokeWidth="2" />}
              <circle cx={graph[index].column * 18 + 20} cy="17" r={selected?.hash === commit.hash ? 4 : 3} fill={graph[index].column % 2 ? "#69c4a5" : "#a17ce0"} stroke={selected?.hash === commit.hash ? "#d6b7ff" : "none"} strokeWidth="2" />
            </svg>
            <span className="git-commit-subject"><span>{commit.subject}</span>{commit.refs && <small><Icon name="git" />{commit.refs}</small>}</span>
            <span className="git-log-author" title={commit.email}>{commit.author}</span><code>{commit.hash.slice(0, 7)}</code><time dateTime={commit.time}>{new Date(commit.time).toLocaleDateString("ru-RU", { day: "numeric", month: "short" })}</time>
          </button></GitMenu></div>)}
        </div>}
        {history?.hasMore && <button className="git-load-more" disabled={loading || more} onClick={() => void loadMore()}>{more ? "Загрузка…" : "Показать ещё 100 коммитов"}</button>}
        <footer className="git-log-footer">Коммитов: {history?.commits.length ?? 0}{history?.hasMore ? "+" : ""}</footer>
      </div>
      <Splitter label="Ширина сведений о коммите" reverse value={detailsWidth} change={setDetailsWidth} min={230} max={500} />
      <aside className="git-commit-details" aria-label="Сведения о коммите" style={{ width: detailsWidth }}>
        {selected && details?.hash === selected.hash ? <>
          <div className="git-details-files">
            <div className="git-details-title"><span>Изменённые файлы · {details.files.length}</span><span className="ide-toolbar-spacer" /><button className="ide-icon-button" aria-label="Показать изменения" title="Показать изменения" disabled={busy || !details.files.length} onClick={() => compare(selected.hash, details.files[0].path)}><Icon name="layout" /></button></div>
            <div className="git-commit-files">{details.files.map(file => <button key={file.path} onClick={() => compare(selected.hash, file.path)} disabled={busy} title={file.path}><FileIcon path={file.path} /><span>{file.path.split("/").at(-1)}<small className="git-file-directory">{file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : ""}</small></span><small className="git-added">{file.added === null ? "двоичный" : `+${file.added}`}</small><small className="git-deleted">{file.deleted === null ? "" : `−${file.deleted}`}</small></button>)}</div>
          </div>
          <div className="git-details-message"><div className="git-commit-heading"><code>{selected.hash.slice(0, 8)}</code><span className="ide-toolbar-spacer" /><button className="ide-icon-button" aria-label="Скопировать хеш коммита" title={copied ? "Скопировано" : "Скопировать хеш"} onClick={() => { void navigator.clipboard.writeText(selected.hash).then(() => setCopied(true)).catch(reason => setError(`Хеш не скопирован: ${String(reason)}`)); }}><Icon name={copied ? "check" : "copy"} /></button></div>
            <h2>{selected.subject}</h2>{details.message.trim() !== selected.subject && <p className="git-commit-message">{details.message.slice(details.message.indexOf("\n") + 1).trim()}</p>}
            <div className="git-commit-person"><span>{selected.author}</span><small>{new Date(selected.time).toLocaleString("ru-RU")}</small></div>
          </div>
        </> : <p className="git-empty">{selected ? "Загрузка коммита…" : "Выберите коммит"}</p>}
      </aside>
    </div>
  </section>;
}
