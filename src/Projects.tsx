import { useState } from "react";
import { Icon } from "./Ide";
import { activeSession } from "./Conversations";
import type { Project, Snapshot, Workspace } from "./types";
import { formatShortcut, useShortcuts } from "./shortcuts";

export default function Projects({ data, busy, selectProject, selectWorkspace, add, create, remove, openGroup }: {
  data: Snapshot; busy: boolean; selectProject: (project: Project) => void;
  selectWorkspace: (workspace: Workspace) => void; add: () => void;
  create: (project: Project) => void; remove: (workspace: Workspace) => void; openGroup: (id: string) => void;
}) {
  const { bindings } = useShortcuts();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("Все");
  const [collapsed, setCollapsed] = useState(() => data.projects.filter(p => p.id !== data.view.projectId
    && !data.view.tabs.some(tab => data.workspaces.some(w => w.id === tab.workspaceId && w.projectId === p.id))).map(p => p.id));
  const [favorites, setFavorites] = useState<string[]>(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem("yade.projects.favorites") ?? "[]");
      return Array.isArray(saved) && saved.every(id => typeof id === "string") ? saved : [];
    } catch { return []; }
  });
  const [error, setError] = useState("");
  const workspaces = data.workspaces.filter(w => !w.deleted && !w.archived);
  const opened = (w: Workspace) => w.id === data.view.workspaceId || data.view.tabs.some(tab => tab.workspaceId === w.id)
    || data.sessions.some(s => s.workspaceId === w.id && activeSession(s.state));
  const active = (p: Project) => workspaces.some(w => w.projectId === p.id && opened(w));
  const counts = [data.projects.length, data.projects.filter(active).length, data.projects.filter(p => favorites.includes(p.id)).length];
  const needle = query.trim().toLocaleLowerCase();
  const projects = data.projects.filter(p => (filter !== "Активные" || active(p)) && (filter !== "Избранные" || favorites.includes(p.id))
    && [p.name, p.path, ...workspaces.filter(w => w.projectId === p.id).flatMap(w => [w.name, w.gitRef ?? ""])].some(text => text.toLocaleLowerCase().includes(needle)))
    .sort((a, b) => Number(active(b)) - Number(active(a)));

  function favorite(id: string) {
    const next = favorites.includes(id) ? favorites.filter(item => item !== id) : [...favorites, id];
    setFavorites(next);
    try { localStorage.setItem("yade.projects.favorites", JSON.stringify(next)); setError(""); }
    catch { setError("Избранное не сохранено: локальное хранилище недоступно."); }
  }

  return <section className="projects-catalog" aria-label="Каталог проектов">
    <div className="projects-heading"><h2>Проекты</h2><span>{data.projects.length}</span><button className="projects-add" onClick={add} disabled={busy}><Icon name="plus" />Добавить</button></div>
    <label className="projects-search"><Icon name="search" /><input id="project-search" aria-label="Найти проект или рабочее пространство" placeholder="Найти проект или рабочее пространство" value={query} onChange={event => setQuery(event.target.value)} />{bindings.projects && <kbd>{formatShortcut(bindings.projects)}</kbd>}</label>
    <div className="projects-filters" aria-label="Фильтры проектов">{["Все", "Активные", "Избранные"].map((item, index) => <button key={item} aria-pressed={filter === item} onClick={() => setFilter(item)}>{item}<span>{counts[index]}</span></button>)}</div>
    <div className="projects-sort">По активности<Icon name="sort" /></div>
    <div className="projects-list">
      {projects.map(p => {
        const spaces = workspaces.filter(w => w.projectId === p.id);
        const selected = p.id === data.view.projectId;
        const expanded = !collapsed.includes(p.id);
        return <article className={`project-card ${selected ? "selected" : ""}`} key={p.id}>
          <div className="project-card-heading">
            <button className="project-select" aria-pressed={selected} disabled={busy} onClick={() => selectProject(p)} title={p.path}>
              <span className={`project-monogram tone-${data.projects.indexOf(p) % 5}`} aria-hidden="true">{p.name.split(/[-_\s]+/).slice(0, 2).map(word => word[0]).join("").toLocaleUpperCase()}</span>
              <span className="project-summary"><strong>{p.name}</strong><small>{spaces.length} простр. · {active(p) ? "открыто" : spaces[0]?.gitRef ?? (p.kind === "repository" ? "Git-репозиторий" : "Папка")}</small></span>
            </button>
            <button className="ide-icon-button project-favorite" aria-label={`Избранное: ${p.name}`} aria-pressed={favorites.includes(p.id)} onClick={() => favorite(p.id)}><Icon name="star" /></button>
            <button className="ide-icon-button project-expand" aria-label={`Пространства: ${p.name}`} aria-expanded={expanded} onClick={() => setCollapsed(current => expanded ? [...current, p.id] : current.filter(id => id !== p.id))}><Icon name="chevron" /></button>
          </div>
          {expanded && <nav aria-label={`Пространства проекта ${p.name}`}>
            {spaces.map(w => <div className={`project-workspace ${w.id === data.view.workspaceId ? "selected" : ""} ${opened(w) ? "opened" : ""}`} key={w.id}>
              <div className="workspace-heading"><button className="workspace-select" aria-label={w.name} aria-pressed={w.id === data.view.workspaceId} disabled={busy} onClick={() => selectWorkspace(w)}>
                <span className={`ide-space-dot ${opened(w) ? "active" : ""}`} /><strong>{w.name}</strong>{w.kind === "folder" && <span className="workspace-badge">Основная папка</span>}
              </button><button className="ide-icon-button workspace-delete" aria-label={`Удалить пространство ${w.name}`} title="Удалить пространство" disabled={busy} onClick={() => remove(w)}><Icon name="trash" /></button></div>
              <div className="workspace-branch"><Icon name={w.gitRef ? "git" : "project"} /><span>{w.gitRef ?? w.path}</span></div>
              {w.id === data.view.workspaceId && <div className="workspace-actions"><button className="workspace-open" disabled={busy} onClick={() => selectWorkspace(w)}>Открыть<span>↵</span></button>{p.kind === "repository" && <button className="ide-icon-button" aria-label={`Новое пространство проекта ${p.name}`} disabled={busy} onClick={() => create(p)}><Icon name="plus" /></button>}</div>}
            </div>)}
            {p.kind === "repository" && <button className="project-new-workspace" disabled={busy} onClick={() => create(p)}><Icon name="plus" />Новое пространство</button>}
          </nav>}
        </article>;
      })}
      {!projects.length && <p className="projects-empty">{data.projects.length ? "Ничего не найдено" : "Добавьте папку, чтобы сохранить рабочий контекст."}</p>}
      {data.groups.map(group => <section className="project-group" key={group.id}><h3>{group.name}</h3>{group.path && <button disabled={busy} onClick={() => openGroup(group.id)}>Открыть общую папку {group.name}</button>}{workspaces.filter(w => w.groupId === group.id).map(w => <div className="workspace-heading" key={w.id}><button disabled={busy} onClick={() => selectWorkspace(w)}>{w.name}</button><button className="ide-icon-button workspace-delete" aria-label={`Удалить пространство ${w.name}`} title="Удалить пространство" disabled={busy} onClick={() => remove(w)}><Icon name="trash" /></button></div>)}</section>)}
    </div>
    {error && <p className="error" role="alert">{error}</p>}
    <div className="projects-footer"><span className="ide-space-dot active" /><span>Активных пространств: {workspaces.filter(opened).length}</span><Icon name="keyboard" /></div>
  </section>;
}
