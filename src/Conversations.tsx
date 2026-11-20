import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { Context, ConversationData, RunEvent, Session, View, Workspace } from "./types";
import ConversationRequest from "./ConversationRequest";
import ConversationTimeline from "./ConversationTimeline";
import type { FileLinks } from "./fileLinks";
import ConversationSettings from "./ConversationSettings";
import SettingsSelect from "./SettingsSelect";
import { Icon } from "./Ide";
import type { Availability } from "./ExecutorSettings";

export const executorName = (executor: string) => executor === "claude" ? "Claude Code" : "Codex";
export const activeSession = (state: string) => !["ready", "completed", "failed", "error", "interrupted", "stopped"].includes(state);
export const sessionState = (state: string): string => ({ ready: "Готова", starting: "Запускается", running: "Выполняется", waiting: "Ожидает ответа",
  stopping: "Ожидает остановки", completed: "Завершена", failed: "Ошибка выполнения", error: "Ошибка подключения", interrupted: "Прервана", stopped: "Остановлена",
  needs_reconciliation: "Требует проверки прежнего запуска" }[state] ?? "Требует проверки прежнего запуска");

export function ConversationControls({ workspace, sessions, open, close }: {
  workspace: Workspace; sessions: Session[]; open: (session: Session) => Promise<void>; close: () => void;
}) {
  const [executor, setExecutor] = useState("codex");
  const [title, setTitle] = useState("");
  const titleInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [availability, setAvailability] = useState<Availability[]>([]);
  const [availabilityError, setAvailabilityError] = useState("");
  const available = availability.find(item => item.executor === executor);
  const availabilityLabel = available ? ({ ready: "Готов", missing: "Не установлен", loginRequired: "Нужен вход", error: "Ошибка проверки" }[available.state] ?? "Не проверен")
    : availabilityError ? "Не проверен" : "Проверка…";

  useEffect(() => {
    const focus = requestAnimationFrame(() => titleInput.current?.focus());
    let ignore = false;
    invoke<Availability[]>("executor_availability").then(value => { if (!ignore) setAvailability(value); })
      .catch(reason => { if (!ignore) setAvailabilityError(String(reason)); });
    return () => { ignore = true; cancelAnimationFrame(focus); };
  }, []);

  async function create(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const session = await invoke<Session>(`create_${executor}_session`, { workspaceId: workspace.id, title: title.trim() || "Новый чат" });
      await open(session); setTitle("");
    } catch (reason) { setError(`Разговор не открыт: ${String(reason)}`); }
    finally { setBusy(false); }
  }
  return <form className="new-chat-form" onSubmit={event => void create(event)}>
    <p className="new-chat-intro">Начните разговор с агентом в текущем пространстве.</p>
    <div className="new-chat-fields">
      <div className="new-chat-field">
        <SettingsSelect label="Агент" value={executor} disabled={busy} title={available?.reason ?? availabilityError} describedBy="new-chat-availability" icon="prompt" allowDefault={false}
          choices={[{ value: "codex", label: "Codex" }, { value: "claude", label: "Claude Code" }]} change={value => setExecutor(value!)} />
        <span id="new-chat-availability" className={`new-chat-availability ${available?.state === "ready" ? "ready" : ""}`}><span className="ide-space-dot" />{availabilityLabel}</span>
      </div>
      <div className="new-chat-field">
        <label htmlFor="new-chat-title">Название чата <span>необязательно</span></label>
        <input id="new-chat-title" aria-describedby="new-chat-title-hint" ref={titleInput} value={title} disabled={busy}
          placeholder="Например, разбор авторизации" onChange={event => setTitle(event.target.value)} />
        <p id="new-chat-title-hint" className="new-chat-hint">Если оставить пустым — «Новый чат».</p>
      </div>
      <div className="new-chat-workspace">
        <div><span className="new-chat-workspace-name"><Icon name="layers" />{workspace.name}</span><span>Активных чатов: {sessions.filter(s => activeSession(s.state)).length}</span></div>
        <p>Все чаты этого пространства работают с общими файлами.</p>
      </div>
      {error && <p role="alert" className="error">{error}</p>}
    </div>
    <div className="new-chat-actions">
      <button type="button" onClick={close}>Отмена</button>
      <button disabled={busy || workspace.archived || workspace.operationState !== "ready"} type="submit">{busy ? "Создание…" : "Создать чат"}<Icon name="arrow-right" /></button>
    </div>
  </form>;
}

type Draft = { text: string; paths: string[] };
const draftSaves = new Map<string, Promise<void>>();
export async function flushConversationDrafts() { await Promise.all([...draftSaves.values()]); }
export async function deleteConversationHistory(sessionId: string) {
  await draftSaves.get(sessionId);
  return invoke<View>("delete_conversation", { sessionId, confirmed: true });
}
const emptyDraft = (): Draft => ({ text: "", paths: [] });
function saveDraft(sessionId: string, draft: Draft): Promise<void> {
  const pending = (draftSaves.get(sessionId) ?? Promise.resolve()).catch(() => {}).then(() => invoke<void>("save_conversation_draft", {
    sessionId, body: JSON.stringify(draft),
  }));
  draftSaves.set(sessionId, pending);
  void pending.then(() => { if (draftSaves.get(sessionId) === pending) draftSaves.delete(sessionId); }, () => {});
  return pending;
}
function parseDraft(body: string): Draft {
  try {
    const value = JSON.parse(body);
    if (typeof value.text === "string" && Array.isArray(value.paths) && value.paths.every((v: unknown) => typeof v === "string")) return value;
  } catch { /* Старые черновики хранились обычным текстом. */ }
  return { text: body, paths: [] };
}

export default function Conversation({ session, workspace, changed, deleted, history, openFile, fileWorkspaces, focused = false, queuedCode, codeAppended }: {
  focused?: boolean;
  queuedCode?: string[]; codeAppended?: (count: number) => void;
  session: Session; workspace: Workspace; changed: () => Promise<void>; deleted: () => Promise<void>; history?: () => void;
} & Pick<FileLinks, "openFile" | "fileWorkspaces">) {
  const [data, setData] = useState<ConversationData | null>(null);
  const [error, setError] = useState("");
  const [readError, setReadError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [draftError, setDraftError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [savingTitle, setSavingTitle] = useState(false);
  const [revision, setRevision] = useState(0);
  const [messagePages, setMessagePages] = useState<number[]>([]);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [attachmentPath, setAttachmentPath] = useState("");
  const draftRef = useRef(draft);
  const loadedDraft = useRef<string | null>(null);
  const sent = useRef<{ context: Context; draft: Draft } | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const messages = useRef<HTMLDivElement>(null);
  const followBottom = useRef(true);
  const titleInput = useRef<HTMLInputElement>(null);
  const titleButton = useRef<HTMLButtonElement>(null);
  const returnTitleFocus = useRef(false);
  const composer = useRef<HTMLTextAreaElement>(null);
  const loaded = data !== null;
  useEffect(() => { if (focused && loaded) composer.current?.focus(); }, [focused, loaded]);
  const writable = !workspace.deleted && !workspace.archived && workspace.operationState === "ready";
  const state = data?.session.state ?? session.state;
  const title = data?.session.title ?? session.title;
  const active = activeSession(state);
  const beforeMessage = messagePages.at(-1) ?? null;

  useLayoutEffect(() => {
    if (editingTitle) {
      titleInput.current?.focus();
      titleInput.current?.select();
    } else if (returnTitleFocus.current) titleButton.current?.focus();
  }, [editingTitle]);

  function scrollToBottom() {
    if (body.current && followBottom.current) body.current.scrollTop = body.current.scrollHeight;
  }

  useLayoutEffect(() => { followBottom.current = beforeMessage === null; }, [session.id, beforeMessage]);
  useLayoutEffect(scrollToBottom, [data, beforeMessage]);

  useEffect(() => {
    if (!body.current || !messages.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(scrollToBottom);
    observer.observe(body.current);
    observer.observe(messages.current);
    return () => observer.disconnect();
  }, [data !== null]);

  function updateDraft(next: Draft) {
    draftRef.current = next; setDraft(next);
    const pending = saveDraft(session.id, next);
    void pending.then(() => setDraftError(""), reason => setDraftError(`Черновик не сохранён: ${String(reason)}`));
  }

  useEffect(() => {
    if (!focused || !loaded || !writable || busy || !queuedCode?.length) return;
    const current = draftRef.current;
    updateDraft({ ...current, text: [current.text, ...queuedCode].filter(Boolean).join("\n\n") });
    codeAppended?.(queuedCode.length);
    composer.current?.focus();
  }, [focused, loaded, writable, busy, queuedCode, codeAppended]);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    async function read() {
      try {
        const value = await invoke<ConversationData>("read_conversation", { sessionId: session.id, beforeMessage, beforeEvent: null });
        if (disposed) return;
        const positions = Object.values(value.messageEvents);
        const first = Math.min(...positions);
        const end = beforeMessage === null ? Infinity : value.messageEvents[beforeMessage] ?? Infinity;
        let page = value;
        let events = value.events;
        while (page.olderEvents && page.events.length && page.events[0].sequence > first) {
          page = await invoke<ConversationData>("read_conversation", { sessionId: session.id, beforeMessage, beforeEvent: page.events[0].sequence });
          if (disposed) return;
          events = [...page.events, ...events];
        }
        value.events = events.filter(event => event.sequence >= (positions.length ? first : 0) && event.sequence < end);
        setData(value); setReadError("");
        if (loadedDraft.current === null || (!draftSaves.has(session.id) && JSON.stringify(draftRef.current) === JSON.stringify(parseDraft(loadedDraft.current)))) {
          const initial = parseDraft(value.draft);
          draftRef.current = initial; setDraft(initial);
        }
        loadedDraft.current = value.draft;
        const sending = sent.current;
        if (sending && value.messages.some(message => message.role === "user" && message.runId === sending.context.runId)) {
          sent.current = null;
          if (!value.draft && JSON.stringify(draftRef.current) === JSON.stringify(sending.draft)) {
            draftRef.current = emptyDraft(); setDraft(draftRef.current);
          }
        }
        if (activeSession(value.session.state) || value.canStop) timer = setTimeout(() => void read(), 500);
      } catch (reason) {
        if (!disposed) { setReadError(`История не обновлена: ${String(reason)}`); timer = setTimeout(() => void read(), 1000); }
      }
    }
    void read();
    return () => { disposed = true; clearTimeout(timer); };
  }, [session.id, session.state, beforeMessage, revision]);

  useEffect(() => {
    const unlisten = listen<RunEvent>("run-event", event => {
      if (event.payload.context.sessionId === session.id && event.payload.context.workspaceId === workspace.id) {
        if (event.payload.kind === "save_error") setSaveError(`Результат не сохранён: ${event.payload.payload.message}`);
        if (event.payload.kind === "session_title") setRevision(value => value + 1);
      }
    });
    void unlisten.catch(reason => setError(`События недоступны: ${String(reason)}`));
    return () => { void unlisten.then(stop => stop()).catch(() => {}); };
  }, [session.id, workspace.id]);

  useEffect(() => {
    if (!writable || busy) return;
    let disposed = false;
    const unlisten = getCurrentWebview().onDragDropEvent(event => {
      if (!disposed && event.payload.type === "drop") updateDraft({ ...draftRef.current, paths: [...new Set([...draftRef.current.paths, ...event.payload.paths])] });
    });
    void unlisten.catch(reason => setError(`Перетаскивание файлов недоступно: ${String(reason)}`));
    return () => { disposed = true; void unlisten.then(stop => stop()).catch(() => {}); };
  }, [writable, busy, session.id]);

  async function startTurn(input: unknown[], current?: Draft) {
    const context = await invoke<Context>(`start_${session.executor}_turn`, { workspaceId: workspace.id, sessionId: session.id, input, draft: current ? JSON.stringify(current) : null });
    if (current) sent.current = { context, draft: current };
    setMessagePages([]); setRevision(value => value + 1);
    await changed();
  }

  async function send(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const current = draftRef.current;
      await saveDraft(session.id, current);
      const input = await invoke<unknown[]>("prepare_conversation_input", { sessionId: session.id, text: current.text, paths: current.paths });
      await startTurn(input, current);
    } catch (reason) { setError(`Сообщение не отправлено: ${String(reason)}`); }
    finally { setBusy(false); }
  }

  async function control(force: boolean) {
    if (!data?.context) return;
    setBusy(true); setError("");
    try {
      await invoke(force ? `stop_${session.executor}_process` : `interrupt_${session.executor}_turn`, { context: data.context });
      if (force) setSaveError("");
      setRevision(value => value + 1); await changed();
    } catch (reason) { setError(`Остановка не подтверждена: ${String(reason)}`); }
    finally { setBusy(false); }
  }

  async function rename(value: string) {
    if (savingTitle) return;
    const next = value.trim();
    if (!next || next === title) { setEditingTitle(false); return; }
    setSavingTitle(true); setError("");
    try {
      await invoke("rename_conversation", { sessionId: session.id, title: next });
      setData(current => current ? { ...current, session: { ...current.session, title: next } } : current);
      setEditingTitle(false); setRevision(value => value + 1);
      await changed().catch(reason => setError(`Название сохранено, но список разговоров не обновлён: ${String(reason)}`));
    } catch (reason) { setError(`Название не сохранено: ${String(reason)}`); }
    finally { setSavingTitle(false); }
  }

  async function remove() {
    setBusy(true); setError("");
    try {
      await deleteConversationHistory(session.id);
      await deleted();
    } catch (reason) { setError(`История не удалена: ${String(reason)}`); }
    finally { setBusy(false); }
  }

  return <section id={`session:${session.id}`} className="content conversation" role="tabpanel" aria-label={`Разговор ${title}`}>
    <header className="conversation-heading"><h2>{editingTitle ?
      <input ref={titleInput} className="conversation-title-input" aria-label="Название разговора" defaultValue={title} disabled={savingTitle}
        onFocus={() => { returnTitleFocus.current = false; }}
        onBlur={event => void rename(event.currentTarget.value)} onKeyDown={event => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); returnTitleFocus.current = true; event.currentTarget.blur(); }
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); returnTitleFocus.current = true; setEditingTitle(false); }
        }} /> :
      <button ref={titleButton} className="conversation-title" title="Нажмите, чтобы переименовать разговор" disabled={!data}
        onClick={() => setEditingTitle(true)}>{title}</button>}
    </h2>
      <div className="conversation-heading-actions">
        {history && <button className="ide-icon-button" aria-label="Открыть историю разговоров" title="История разговоров" onClick={history}><Icon name="history" /></button>}
        {data && <details className="conversation-menu"><summary aria-label="Действия с разговором" title="Действия с разговором"><Icon name="more" /></summary><div>
          <button disabled={!active || ["stopping", "needs_reconciliation"].includes(state) || busy || !data.context} onClick={() => void control(false)}>Остановить выполнение</button>
          <button disabled={busy || !data.context || !data.canStop} onClick={() => void control(true)}>Завершить процесс</button>
          <button disabled={active || data.canStop || busy} onClick={() => setConfirming(true)}>Удалить историю разговора</button>
        </div></details>}
      </div>
    </header>
    <div ref={body} className={`conversation-body ${data && !data.messages.length ? "conversation-empty" : ""}`} onScroll={event => {
      const element = event.currentTarget;
      followBottom.current = beforeMessage === null && element.scrollHeight - element.clientHeight - element.scrollTop <= 1;
    }}>
    {!writable && <p>Пространство {workspace.deleted ? "удалено" : "недоступно"}. История доступна для чтения; выполнение запрещено.</p>}
    {error && <p role="alert" className="error">{error}</p>}
    {readError && <p role="alert" className="error">{readError}</p>}
    {saveError && <p role="alert" className="error">{saveError}</p>}
    {draftError && <p role="alert" className="error">{draftError}</p>}
    {["error", "failed"].includes(state) && data?.events.filter(e => e.kind === "state" && e.payload.state === state).slice(-1).map(event =>
      <p key={event.sequence} role="alert" className="error">{event.payload.detail?.message ?? event.payload.detail?.error?.message ?? JSON.stringify(event.payload.detail)}</p>)}
    {!data ? <p>Загрузка разговора…</p> : <>
      {(data.olderMessages || messagePages.length > 0) && <nav className="conversation-actions" aria-label="Страницы сообщений">
        <button disabled={!data.olderMessages} onClick={() => setMessagePages(pages => [...pages, data.messages[0].sequence])}>Предыдущие сообщения</button>
        <button disabled={!messagePages.length} onClick={() => setMessagePages(pages => pages.slice(0, -1))}>Следующие сообщения</button>
        {messagePages.length > 0 && <button onClick={() => setMessagePages([])}>К последним сообщениям</button>}
      </nav>}
      <div ref={messages} className="messages" aria-label="Сообщения разговора">
        <ConversationTimeline data={data} executor={executorName(session.executor)} active={active} workspacePath={workspace.path} fileWorkspaces={fileWorkspaces} openFile={openFile}
          canReply={writable && !active && !data.canStop && !busy && !settingsBusy && beforeMessage === null}
          reply={async text => {
            setBusy(true); setError("");
            try { await startTurn([{ type: "text", text }]); }
            finally { setBusy(false); }
          }} />
        {!data.messages.length && <div className="conversation-welcome"><span className="ide-welcome-icon"><Icon name="chat" /></span><h2>С чего начнём?</h2><p>Задайте вопрос по проекту или опишите задачу.</p></div>}
      </div>
      {data.requests.map(request => <ConversationRequest key={`${request.context.runId}:${JSON.stringify(request.payload.requestId)}`}
        request={request} executor={session.executor} reply={async result => {
          try { await invoke(`reply_${session.executor}_request`, { context: request.context, requestId: request.payload.requestId, result }); }
          catch (reason) { setError(`Ответ не принят: ${String(reason)}`); throw reason; }
          finally { setRevision(value => value + 1); }
        }} />)}
      {confirming && <section aria-label="Удаление истории">
        <p>Удалить историю «{title}» и её черновик? Остальные разговоры и файлы сохранятся.</p>
        <button disabled={busy || active || data.canStop} onClick={() => void remove()}>Подтвердить удаление истории</button>
        <button disabled={busy} onClick={() => setConfirming(false)}>Отменить удаление истории</button>
      </section>}
    </>}
    </div>
    {data && <div className="conversation-compose-area">
      <div className="conversation-context"><span title={workspace.path}><Icon name="project" />{workspace.path.split(/[\\/]/).filter(Boolean).at(-1)}</span><span>{workspace.name}</span></div>
      <form className="conversation-composer" onSubmit={event => void send(event)}>
        <label><span className="ide-visually-hidden">Сообщение</span><textarea ref={composer} rows={4} placeholder="Задайте вопрос или опишите задачу…" value={draft.text} disabled={!writable || busy} onChange={event => updateDraft({ ...draftRef.current, text: event.target.value })}
          onKeyDown={event => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              if (writable && !active && !data.canStop && !busy && !settingsBusy && (draft.text.trim() || draft.paths.length)) event.currentTarget.form?.requestSubmit();
            }
          }} /></label>
        <details className="conversation-attachments"><summary aria-label="Вложения и команды"><Icon name="attachment" />Команды</summary>
        <p className="muted">{session.executor === "codex" ? "Навыки вызываются через $имя-навыка." : "Команды /имя передаются Claude Code."} Файлы можно перетащить в разговор или добавить по пути.</p>
        <div className="attachment-input">
          <label>Путь к вложению<input value={attachmentPath} disabled={!writable || busy} onChange={event => setAttachmentPath(event.target.value)} placeholder="/Users/…" /></label>
          <button type="button" disabled={!writable || busy || !attachmentPath.trim()} onClick={() => {
            updateDraft({ ...draftRef.current, paths: [...new Set([...draftRef.current.paths, attachmentPath.trim()])] }); setAttachmentPath("");
          }}>Прикрепить файл</button>
        </div>
        {draft.paths.map(path => <div key={path} className="conversation-actions"><span className="path">{path}</span>
          <button type="button" disabled={!writable || busy} aria-label={`Убрать вложение ${path}`} onClick={() => updateDraft({ ...draftRef.current, paths: draftRef.current.paths.filter(p => p !== path) })}>Убрать</button>
        </div>)}
        </details>
        {!!draft.paths.length && <p className="muted">Вложений: {draft.paths.length}</p>}
        <ConversationSettings key={session.id} workspace={workspace} session={session} disabled={!writable || active || data.canStop || busy} saving={setSettingsBusy} />
        {active ? <button className="conversation-compose-action" aria-label="Прервать ответ" title={state === "stopping" ? "Ожидает остановки" : "Прервать ответ"}
          disabled={["stopping", "needs_reconciliation"].includes(state) || busy || !data.context} type="button" onClick={() => void control(false)}>
          <Icon name="stop" />
        </button> : <button className="conversation-compose-action" aria-label={data.session.externalId ? "Продолжить разговор" : "Отправить сообщение"} disabled={!writable || data.canStop || busy || settingsBusy || (!draft.text.trim() && !draft.paths.length)} type="submit">
          <Icon name="send" />
        </button>}
      </form>
      <div className="conversation-input-hints"><span>⇧ Enter — новая строка</span><span>Enter — отправить</span></div>
    </div>}
  </section>;
}
