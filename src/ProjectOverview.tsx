import { useState } from "react";
import type { ReactNode } from "react";
import { Icon, IdeDialog } from "./Ide";
import { activeSession, executorName, sessionState } from "./Conversations";
import { terminalTitle } from "./Terminal";
import type { Project, Session, Snapshot, TerminalInfo, Workspace } from "./types";
import "./projectOverview.css";

const statuses = {
  running: "Работает", waiting: "Ждёт ответа", ready: "Готов", error: "Ошибка", attention: "Нужна проверка",
};
type Status = keyof typeof statuses;

export function conversationStatus(session: Session): Status {
  if (session.state === "waiting") return "waiting";
  if (["starting", "running", "stopping"].includes(session.state)) return "running";
  if (["failed", "error"].includes(session.state)) return "error";
  return activeSession(session.state) ? "attention" : "ready";
}

function description(session: Session) {
  return { ready: "Готов к запуску", starting: "Запускает выполнение", running: "Выполняет задачу", waiting: "Нужен ответ для продолжения",
    stopping: "Останавливает выполнение", completed: "Выполнение завершено", failed: "Не удалось выполнить задачу", error: "Не удалось подключиться",
    interrupted: "Выполнение прервано", stopped: "Выполнение остановлено" }[session.state] ?? "Требуется проверка прежнего запуска";
}

export function terminalStatus(terminal: TerminalInfo): Status {
  if (terminal.error || terminal.state === "failed") return "error";
  if (terminal.execution && terminal.state === "running") {
    if (terminal.execution.state === "failed") return "error";
    if (["completed", "stopped"].includes(terminal.execution.state)) return "ready";
    if (["running", "waiting", "ready"].includes(terminal.execution.state)) return terminal.execution.state as Status;
    return "attention";
  }
  if (terminal.state === "running") return "running";
  return ["completed", "stopped"].includes(terminal.state) ? "ready" : "attention";
}

function terminalDescription(terminal: TerminalInfo) {
  if (!terminal.execution) return terminal.error ?? "Интерактивная оболочка";
  const state = terminalStatus(terminal);
  const text = terminal.error ?? (terminal.state !== "running" ? "Терминал завершён" : terminal.execution.state === "completed" ? "Работа в терминале завершена" : state === "attention"
    ? "Статус не удалось определить по экрану терминала"
    : { running: "Выполняет задачу", waiting: "Нужен ответ для продолжения", ready: "Готов к работе", error: "Не удалось выполнить задачу" }[state]);
  return `${executorName(terminal.execution.executor)} · ${text}`;
}

function counted(count: number, one: string, few: string, many: string) {
  const form = new Intl.PluralRules("ru").select(count);
  return `${count} ${form === "one" ? one : form === "few" ? few : many}`;
}

function StatusBadge({ status, children = statuses[status] }: { status: Status; children?: ReactNode }) {
  return <span className={`overview-status overview-status-${status}`}><span />{children}</span>;
}

export default function ProjectOverview({ data, busy, selectProject, selectWorkspace, openSession, openTerminal, removeEntry, add, unseenCompletions }: {
  data: Snapshot; busy: boolean; selectProject: (project: Project) => void;
  selectWorkspace: (workspace: Workspace) => void; openSession: (session: Session) => void;
  openTerminal: (terminal: TerminalInfo) => void; add: () => void;
  unseenCompletions?: ReadonlySet<string>;
  removeEntry: (kind: "session" | "terminal", id: string, workspaceId: string) => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const [entryLimits, setEntryLimits] = useState<Record<string, number>>({});
  const [deleting, setDeleting] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [projectOrder] = useState(() => [...data.projects]
    .sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0)).map(project => project.id));
  const projects = [...data.projects].sort((a, b) => projectOrder.indexOf(a.id) - projectOrder.indexOf(b.id));
  const workspaces = data.workspaces.filter(workspace => !workspace.deleted && !workspace.archived && data.projects.some(project => project.id === workspace.projectId));
  const sessions = data.sessions.filter(session => workspaces.some(workspace => workspace.id === session.workspaceId));
  const terminals = (data.terminals ?? []).filter(terminal => workspaces.some(workspace => workspace.id === terminal.workspaceId));
  const executions = terminals.filter(terminal => terminal.execution);
  const entries = [
    ...sessions.map(session => ({ id: `session:${session.id}`, workspaceId: session.workspaceId, lastActivityAt: session.lastActivityAt ?? 0,
      title: session.title, description: `${session.executor === "claude" ? "Claude" : executorName(session.executor)} · ${description(session)}`,
      status: conversationStatus(session), label: statuses[conversationStatus(session)], tooltip: sessionState(session.state), open: () => openSession(session),
      deleteLabel: "Удалить разговор", confirmation: "История разговора и его черновик будут удалены.", blocked: activeSession(session.state),
      remove: () => removeEntry("session", session.id, session.workspaceId),
    })),
    ...terminals.map(terminal => ({ id: `terminal:${terminal.id}`, workspaceId: terminal.workspaceId, lastActivityAt: terminal.lastActivityAt ?? 0,
      title: terminalTitle(terminal.id, terminal.execution?.title), description: terminalDescription(terminal), status: terminalStatus(terminal),
      label: terminal.execution ? (terminalStatus(terminal) === "attention" ? "Статус неизвестен" : statuses[terminalStatus(terminal)])
        : terminalStatus(terminal) === "error" ? "Ошибка" : ({ running: "Открыт", completed: "Завершён", stopped: "Остановлен" }[terminal.state] ?? "Нужна проверка"),
      tooltip: terminal.execution ? terminalDescription(terminal) : terminal.error ?? "Терминал в пространстве", open: () => openTerminal(terminal),
      deleteLabel: "Удалить терминал", confirmation: terminal.state === "running" ? "Терминал будет остановлен, его вывод будет удалён." : "Вывод терминала будет удалён.",
      blocked: false, remove: () => removeEntry("terminal", terminal.id, terminal.workspaceId),
    })),
  ];
  const needle = query.trim().toLocaleLowerCase();
  const matches = (text: string) => text.toLocaleLowerCase().includes(needle);
  const results = projects.map(project => {
    const allSpaces = workspaces.filter(workspace => workspace.projectId === project.id);
    const matchesProject = matches(project.name) || matches(project.path);
    const spaces = allSpaces.map(workspace => {
      const matchesWorkspace = matchesProject || [workspace.name, workspace.gitRef ?? workspace.path].some(matches);
      const current = entries.filter(entry => entry.workspaceId === workspace.id && (matchesWorkspace || matches(entry.title)))
        .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
      return { workspace, current, visible: matchesWorkspace || current.length > 0 };
    }).filter(space => space.visible);
    return { project, allSpaces, spaces, matchesProject };
  }).filter(result => result.matchesProject || result.spaces.length > 0);
  const count = (status: Status) => sessions.filter(session => conversationStatus(session) === status).length
    + executions.filter(terminal => terminalStatus(terminal) === status).length;
  const selected = entries.find(entry => entry.id === deleting);

  async function confirmDelete() {
    if (!selected || removing || selected.blocked) return;
    setRemoving(true); setDeleteError("");
    try { await selected.remove(); setDeleting(null); }
    catch (reason) { setDeleteError(String(reason)); }
    finally { setRemoving(false); }
  }

  return <aside className="project-overview" aria-label="Обзор проектов">
    <div className="overview-content">
      <div className="overview-heading"><div><h1>Обзор проектов</h1><p>
        {counted(data.projects.length, "проект", "проекта", "проектов")}<span>·</span>{counted(workspaces.length, "пространство", "пространства", "пространств")}<span>·</span>{counted(sessions.length + executions.length, "агент", "агента", "агентов")}
        {terminals.length > 0 && <><span>·</span>{counted(terminals.length, "терминал", "терминала", "терминалов")}</>}
      </p></div>
        <div className="overview-summary" aria-label="Сводка статусов">
          <StatusBadge status="running">{counted(count("running"), "работает", "работают", "работают")}</StatusBadge>
          <StatusBadge status="waiting">{counted(count("waiting"), "ждёт ответа", "ждут ответа", "ждут ответа")}</StatusBadge>
          <StatusBadge status="error">{counted(count("error"), "ошибка", "ошибки", "ошибок")}</StatusBadge>
          {count("attention") > 0 && <StatusBadge status="attention">{counted(count("attention"), "требует проверки", "требуют проверки", "требуют проверки")}</StatusBadge>}
        </div>
        {projects.length > 0 && <label className="projects-search overview-search"><Icon name="search" />
          <input type="search" aria-label="Поиск в мониторинге" placeholder="Поиск в мониторинге" value={query} onChange={event => setQuery(event.target.value)} />
        </label>}
      </div>
      <div className="overview-projects">
        {results.map(({ project, allSpaces, spaces }) => {
          const projectSessions = sessions.filter(session => allSpaces.some(workspace => workspace.id === session.workspaceId));
          const projectTerminals = terminals.filter(terminal => allSpaces.some(workspace => workspace.id === terminal.workspaceId));
          return <article className="overview-project" key={project.id} aria-label={`Проект ${project.name}`}>
            <div className="overview-project-heading">
              <button className="overview-project-link" aria-current={project.id === data.view.projectId ? "true" : undefined} disabled={busy} onClick={() => selectProject(project)} title={project.path}>
                <Icon name="project" /><span><strong>{project.name}</strong><small>{counted(allSpaces.length, "пространство", "пространства", "пространств")} · {counted(projectSessions.length + projectTerminals.filter(terminal => terminal.execution).length, "агент", "агента", "агентов")}{projectTerminals.length > 0 && ` · ${counted(projectTerminals.length, "терминал", "терминала", "терминалов")}`}</small></span>
              </button>
            </div>
            {spaces.map(({ workspace, current }) => {
              const expanded = Boolean(needle) || !collapsed.includes(workspace.id);
              const limit = needle ? current.length : entryLimits[workspace.id] ?? 3;
              return <section className="overview-workspace" key={workspace.id} aria-label={`Пространство ${workspace.name}`}>
                <div className="overview-workspace-heading">
                  <button className="overview-workspace-toggle" aria-label={`Свернуть или развернуть пространство ${workspace.name}`} aria-expanded={expanded} aria-controls={`overview-workspace:${workspace.id}`} disabled={Boolean(needle)}
                    onClick={() => setCollapsed(value => expanded ? [...value, workspace.id] : value.filter(id => id !== workspace.id))}><Icon name="chevron" /></button>
                  <button className="overview-workspace-link" disabled={busy} onClick={() => selectWorkspace(workspace)}><Icon name="layers" /><strong>{workspace.name}</strong></button>
                </div>
                <div id={`overview-workspace:${workspace.id}`} hidden={!expanded}>
                  <div className="overview-workspace-ref" title={workspace.gitRef ?? workspace.path}><Icon name={workspace.gitRef ? "git" : "project"} /><span>{workspace.gitRef ?? workspace.path}</span></div>
                  {workspace.operationState !== "ready" && <p className="overview-workspace-note">{workspace.operationState === "creating" ? "Создание пространства…" : "Операция не завершена"}</p>}
                  {workspace.operationError && <p className="overview-workspace-error">{workspace.operationError}</p>}
                  {!["skipped", "completed"].includes(workspace.preparationState) && <p className={`overview-workspace-note ${!["pending", "running"].includes(workspace.preparationState) ? "overview-workspace-error" : ""}`}>
                    {{ pending: "Подготовка в очереди", running: "Подготовка пространства…", failed: "Ошибка подготовки", needs_reconciliation: "Подготовка требует проверки" }[workspace.preparationState] ?? "Подготовка требует проверки"}
                  </p>}
                  {current.length ? <div className="overview-sessions" id={`overview-sessions:${workspace.id}`}>{current.slice(0, limit).map(entry => <div className={`overview-session-row${unseenCompletions?.has(entry.id) ? " overview-session-unseen" : ""}`} key={entry.id}>
                    <button className="overview-session" disabled={busy} onClick={entry.open} title={entry.tooltip}
                      aria-description={unseenCompletions?.has(entry.id) ? "Результат не просмотрен" : undefined}>
                      <span><strong>{entry.title}</strong><small>{entry.description}</small></span>
                      <StatusBadge status={entry.status}>{entry.label}</StatusBadge>
                    </button>
                    <button className="ide-icon-button workspace-delete overview-session-delete" aria-label={`${entry.deleteLabel} «${entry.title}»`}
                      title={entry.blocked ? "Сначала остановите выполнение" : entry.deleteLabel} disabled={busy || entry.blocked}
                      onClick={() => { setDeleteError(""); setDeleting(entry.id); }}><Icon name="trash" /></button>
                  </div>)}</div> : <p className="overview-workspace-note">Разговоров и терминалов пока нет</p>}
                  {current.length > limit && <button className="overview-more-sessions" aria-controls={`overview-sessions:${workspace.id}`} onClick={() => setEntryLimits(value => ({ ...value, [workspace.id]: (value[workspace.id] ?? 3) + 3 }))}>Еще</button>}
                </div>
              </section>;
            })}
            {!spaces.length && <p className="overview-project-empty">Нет активных рабочих пространств</p>}
          </article>;
        })}
      </div>
      {projects.length > 0 && !results.length && <p className="overview-project-empty" role="status">Ничего не найдено</p>}
      {!data.projects.length && <div className="overview-empty"><Icon name="project" /><h2>Проектов пока нет</h2><p>Добавьте проект, чтобы следить за его работой здесь.</p><button className="projects-add" disabled={busy} onClick={add}><Icon name="plus" />Добавить проект</button></div>}
    </div>
    {selected && <IdeDialog title={selected.deleteLabel} className="new-workspace-dialog" close={() => { if (!removing) setDeleting(null); }}>
      <div className="new-workspace-fields workspace-delete-fields">
        <p className="workspace-delete-question">{selected.deleteLabel} «{selected.title}»?</p>
        <p>{selected.blocked ? "Сначала остановите выполнение." : selected.confirmation}</p>
        {deleteError && <p className="error" role="alert">{deleteError}</p>}
      </div>
      <div className="new-workspace-actions">
        <button disabled={removing} onClick={() => setDeleting(null)} autoFocus>Отмена</button>
        <button className="workspace-delete-confirm" disabled={busy || removing || selected.blocked} onClick={() => void confirmDelete()}>{removing ? "Удаление…" : "Удалить"}</button>
      </div>
    </IdeDialog>}
  </aside>;
}
