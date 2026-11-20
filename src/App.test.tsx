// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import App from "./App";
import type { DeletionCheck, RunEvent, Session } from "./types";
import type { Snapshot, View } from "./types";

const events = vi.hoisted(() => new Set<(event: { payload: RunEvent }) => void>());
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (_name, callback) => {
  events.add(callback); return () => events.delete(callback);
}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("./Lifecycle", () => ({ default: () => null }));
vi.mock("./Conversations", async importOriginal => ({
  ...await importOriginal<typeof import("./Conversations")>(),
  default: ({ session }: { session: Session }) => <h2>{session.title}</h2>,
  ConversationControls: () => null,
}));
vi.mock("./Terminal", () => ({
  TerminalPanel: ({ active, id, screenReaderEnabled }: { active: boolean; id: string; screenReaderEnabled?: boolean }) => <section role="tabpanel" aria-label={`Оболочка ${id}`} hidden={!active} data-screen-reader={screenReaderEnabled}>Вывод оболочки</section>, terminalTitle: (id: string, title?: string | null) => title || `Терминал ${id.replace(/^terminal:/, "").slice(0, 8)}`,
}));
vi.mock("./CodeEditor", () => ({
  default: ({ path, body, disabled, change }: any) => <textarea aria-label={`Код ${path}`} value={body} disabled={disabled} onChange={e => change(e.target.value)} />,
  Comparison: () => null,
}));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); vi.resetAllMocks(); events.clear(); localStorage.clear(); });
HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };

function openProjects() {
  const current = screen.queryByRole("dialog");
  if (current) fireEvent.click(within(current).getByRole("button", { name: /^Закрыть / }));
  fireEvent.click(within(screen.getByRole("complementary", { name: "Проекты" })).getByRole("button", { name: "Все проекты" }));
  return within(screen.getByRole("dialog", { name: "Все проекты" }));
}

function chooseProject(name: string | RegExp) {
  fireEvent.click(openProjects().getByRole("button", { name }));
}

function fixture(): Snapshot {
  return {
    groups: [{ id: "g1", name: "Команда", path: null }],
    projects: [
      { id: "p1", groupId: "g1", name: "Первый", path: "/first", kind: "folder", preparationCommand: null },
      { id: "p2", groupId: null, name: "Второй", path: "/second", kind: "folder", preparationCommand: null },
    ],
    workspaces: [
      { id: "w1", projectId: "p1", groupId: null, name: "Основное", path: "/first", kind: "folder", archived: false, deleted: false, sourceRef: null, sourceCommit: null, gitRef: null, operationState: "ready", operationError: null, preparationCommand: null, preparationState: "skipped", preparationOutput: "" },
      { id: "w2", projectId: "p2", groupId: null, name: "Другое", path: "/second", kind: "folder", archived: false, deleted: false, sourceRef: null, sourceCommit: null, gitRef: null, operationState: "ready", operationError: null, preparationCommand: null, preparationState: "skipped", preparationOutput: "" },
    ],
    sessions: [{ id: "s1", workspaceId: "w1", executor: "codex", title: "Исправление", state: "running" }],
    view: { projectId: "p1", workspaceId: "w1", tabs: [{ id: "session:s1", workspaceId: "w1", sessionId: "s1" }], activeTabs: { w1: "session:s1" }, sidebarWidth: 260 },
  };
}

test("название проекта в верхней панели открывает список и позволяет переключить проект", async () => {
  const saved = fixture();
  vi.mocked(invoke).mockImplementation(async (command, args: any) => {
    if (command === "snapshot") return structuredClone(saved);
    if (command === "save_view") { saved.view = structuredClone(args.view); return; }
    if (["list_directory", "list_file_drafts", "executor_availability"].includes(command)) return [];
    throw new Error(command);
  });
  render(<App />);
  const trigger = await screen.findByRole("button", { name: "Открыть список проектов" });
  expect(trigger.textContent).toBe("Первый");
  fireEvent.click(trigger);
  const catalog = within(screen.getByRole("dialog", { name: "Все проекты" }));
  expect(catalog.getByRole("button", { name: /^Первый/ })).toBeTruthy();
  fireEvent.click(catalog.getByRole("button", { name: /^Второй/ }));
  await waitFor(() => expect(saved.view.projectId).toBe("p2"));
  expect(saved.view.workspaceId).toBe("w2");
  expect(screen.queryByRole("dialog", { name: "Все проекты" })).toBeNull();
  expect(screen.getByRole("button", { name: "Открыть список проектов" }).textContent).toBe("Второй");
});

test("Escape отменяет стандартное действие окна, сохраняя обработчики интерфейса и закрытие диалогов", async () => {
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === "snapshot") return fixture();
    if (["list_directory", "list_file_drafts", "executor_availability"].includes(command)) return [];
    throw new Error(command);
  });
  const { unmount } = render(<App />);
  const escape = () => new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  const startup = escape();
  fireEvent(document.body, startup);
  expect(startup.defaultPrevented).toBe(true);
  const settings = await screen.findByRole("button", { name: "Открыть настройки" });
  const handled = vi.fn();
  settings.addEventListener("keydown", handled);
  const event = escape();
  fireEvent(settings, event);
  expect(event.defaultPrevented).toBe(true);
  expect(handled).toHaveBeenCalledOnce();
  expect(fireEvent.keyDown(settings, { key: "Enter" })).toBe(true);
  fireEvent.click(settings);
  const dialog = screen.getByRole("dialog", { name: "Настройки" });
  const handledCancel = escape();
  handledCancel.preventDefault();
  fireEvent(dialog, handledCancel);
  expect(screen.getByRole("dialog", { name: "Настройки" })).toBe(dialog);
  const cancel = escape();
  fireEvent(dialog, cancel);
  expect(cancel.defaultPrevented).toBe(true);
  expect(screen.queryByRole("dialog", { name: "Настройки" })).toBeNull();
  unmount();
  expect(fireEvent(document.body, escape())).toBe(true);
});

test.each([
  ["Закрыть", ["overview:w1", "terminal:t1"], "terminal:t1"],
  ["Закрыть другие вкладки", ["session:s1"], "session:s1"],
  ["Закрыть все вкладки", [], undefined],
  ["Закрыть неизменённые вкладки", [], undefined],
  ["Закрыть вкладки слева", ["session:s1", "terminal:t1"], "terminal:t1"],
  ["Закрыть вкладки справа", ["overview:w1", "session:s1"], "overview:w1"],
] as const)("меню вкладки: %s действует только в текущем пространстве", async (action, remaining, active) => {
  const saved = fixture();
  saved.sessions[0].state = "completed";
  saved.view.tabs = [
    { id: "overview:w1", workspaceId: "w1", sessionId: null }, saved.view.tabs[0],
    { id: "terminal:t1", workspaceId: "w1", sessionId: null },
    { id: "overview:w2", workspaceId: "w2", sessionId: null },
  ];
  saved.view.activeTabs = { w1: "terminal:t1", w2: "overview:w2" };
  vi.mocked(invoke).mockImplementation(async (command, args: any) => {
    if (command === "snapshot") return structuredClone(saved);
    if (command === "save_view") { saved.view = structuredClone(args.view); return; }
    if (["list_directory", "list_file_drafts", "executor_availability"].includes(command)) return [];
    throw new Error(command);
  });
  render(<App />);
  const tab = await screen.findByRole("tab", { name: /Исправление/ });
  tab.focus();
  fireEvent.contextMenu(tab, { clientX: 100, clientY: 100 });
  const menu = screen.getByRole("menu", { name: "Действия вкладки Исправление" });
  expect(within(menu).getAllByRole("menuitem").map(item => item.querySelector("span")?.textContent)).toEqual([
    "Закрыть", "Закрыть другие вкладки", "Закрыть все вкладки", "Закрыть неизменённые вкладки", "Закрыть вкладки слева", "Закрыть вкладки справа",
  ]);
  expect(menu.querySelector("small")?.textContent).toBe("⌘W");
  expect(saved.view.activeTabs.w1).toBe("terminal:t1");
  fireEvent.keyDown(document.activeElement!, { key: "End" });
  expect(document.activeElement).toBe(within(menu).getByRole("menuitem", { name: "Закрыть вкладки справа" }));
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(screen.queryByRole("menu")).toBeNull();
  expect(document.activeElement).toBe(tab);
  fireEvent.keyDown(tab, { key: "F10", shiftKey: true });
  fireEvent.click(screen.getByRole("menuitem", { name: new RegExp(`^${action}(?: ⌘W)?$`) }));
  await waitFor(() => expect(saved.view.tabs.map(tab => tab.id)).toEqual([...remaining, "overview:w2"]));
  expect(saved.view.activeTabs.w1).toBe(active);
  expect(saved.view.activeTabs.w2).toBe("overview:w2");
  expect(screen.queryByRole("menu")).toBeNull();
  expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "save_view")).toHaveLength(1);
  expect(vi.mocked(invoke).mock.calls.some(([command]) => ["stop_terminal", "interrupt_session"].includes(command))).toBe(false);
});

test("меню вкладок отключает закрытие отсутствующих соседей и закрывается по нажатию снаружи", async () => {
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === "snapshot") return fixture();
    if (["list_directory", "list_file_drafts", "executor_availability"].includes(command)) return [];
    throw new Error(command);
  });
  render(<App />);
  fireEvent.contextMenu(await screen.findByRole("tab", { name: /Исправление/ }));
  for (const name of ["Закрыть другие вкладки", "Закрыть вкладки слева", "Закрыть вкладки справа"]) {
    expect((screen.getByRole("menuitem", { name }) as HTMLButtonElement).disabled).toBe(true);
  }
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole("menu")).toBeNull();
});

test("закрытие неизменённых вкладок сохраняет вкладку с ручными правками", async () => {
  const saved = fixture();
  saved.sessions = [];
  saved.view.tabs = [
    { id: "file:w1:changed.ts", workspaceId: "w1", sessionId: null },
    { id: "file:w1:clean.ts", workspaceId: "w1", sessionId: null },
  ];
  saved.view.activeTabs.w1 = "file:w1:changed.ts";
  vi.mocked(invoke).mockImplementation(async (command, args: any) => {
    if (command === "snapshot") return structuredClone(saved);
    if (command === "save_view") { saved.view = structuredClone(args.view); return; }
    if (["list_directory", "list_file_drafts", "executor_availability"].includes(command)) return [];
    if (command === "open_file") return { path: args.path, body: "исходник", base: "исходник", disk: "исходник" };
    if (command === "read_file_disk") return "исходник";
    if (command === "save_file_draft") return;
    throw new Error(command);
  });
  render(<App />);
  fireEvent.change(await screen.findByRole("textbox", { name: "Код changed.ts" }), { target: { value: "ручные правки" } });
  const tab = await screen.findByRole("tab", { name: "changed.ts · Несохранённые правки" });
  await waitFor(() => expect(document.querySelectorAll(".file-panel textarea")).toHaveLength(2));
  fireEvent.contextMenu(tab);
  fireEvent.click(screen.getByRole("menuitem", { name: "Закрыть неизменённые вкладки" }));
  await waitFor(() => expect(saved.view.tabs.map(tab => tab.id)).toEqual(["file:w1:changed.ts"]));
  expect((screen.getByRole("textbox", { name: "Код changed.ts" }) as HTMLTextAreaElement).value).toBe("ручные правки");
  expect(saved.view.activeTabs.w1).toBe("file:w1:changed.ts");
  fireEvent.contextMenu(screen.getByRole("tab", { name: /changed.ts/ }));
  expect((screen.getByRole("menuitem", { name: "Закрыть неизменённые вкладки" }) as HTMLButtonElement).disabled).toBe(true);
});

test("массовое закрытие оставляет все вкладки открытыми при ошибке сохранения черновика", async () => {
  const saved = fixture();
  saved.sessions[0].state = "completed";
  saved.view.tabs.push({ id: "file:w1:failed-bulk.ts", workspaceId: "w1", sessionId: null });
  saved.view.activeTabs.w1 = "file:w1:failed-bulk.ts";
  const original = structuredClone(saved.view);
  vi.mocked(invoke).mockImplementation(async (command, args: any) => {
    if (command === "snapshot") return structuredClone(saved);
    if (command === "save_view") { saved.view = structuredClone(args.view); return; }
    if (["list_directory", "list_file_drafts", "executor_availability"].includes(command)) return [];
    if (command === "open_file") return { path: args.path, body: "исходник", base: "исходник", disk: "исходник" };
    if (command === "read_file_disk") return "исходник";
    if (command === "save_file_draft") throw new Error("база недоступна");
    throw new Error(command);
  });
  render(<App />);
  fireEvent.change(await screen.findByRole("textbox", { name: "Код failed-bulk.ts" }), { target: { value: "ручные правки" } });
  await screen.findByText(/Черновик не сохранён:.*база недоступна/);
  fireEvent.contextMenu(screen.getByRole("tab", { name: /Исправление/ }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Закрыть все вкладки" }));
  await screen.findByText(/Вкладка оставлена открытой/);
  expect(saved.view).toEqual(original);
  expect((screen.getByRole("textbox", { name: "Код failed-bulk.ts" }) as HTMLTextAreaElement).value).toBe("ручные правки");
  expect(vi.mocked(invoke).mock.calls.some(([command]) => command === "save_view")).toBe(false);
});

test("Git занимает центральную область и возвращает открытый редактор без потери текста", async () => {
  const saved = fixture();
  saved.view.tabs = [{ id: "file:w1:file.txt", workspaceId: "w1", sessionId: null }];
  saved.view.activeTabs.w1 = saved.view.tabs[0].id;
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === "snapshot") return structuredClone(saved);
    if (["list_directory", "list_file_drafts", "git_branches", "git_stashes"].includes(command)) return [];
    if (command === "open_file") return { path: "file.txt", body: "сохранённый текст", base: "сохранённый текст", disk: "сохранённый текст" };
    if (command === "list_git_repositories") return [""];
    if (command === "git_status") return { reference: "feature/git", changes: [], remotes: [], upstream: null, ahead: 0, behind: 0, operation: null };
    if (command === "save_file_draft") return;
    throw new Error(command);
  });
  const { container } = render(<App />);
  const editor = await screen.findByRole("textbox", { name: "Код file.txt" });
  fireEvent.change(editor, { target: { value: "несохранённый текст" } });
  fireEvent.click(screen.getByRole("button", { name: "Изменения Git" }));
  await screen.findByRole("combobox", { name: "Текущая ветка" });
  expect(container.querySelector(".ide-center .git-center-host .git-main")).toBeTruthy();
  expect(screen.queryByRole("textbox", { name: "Код file.txt" })).toBeNull();
  expect(container.querySelector(".ide-status")?.textContent).toContain("feature/git");
  fireEvent.click(screen.getByRole("button", { name: "Проект" }));
  expect(screen.getByRole("textbox", { name: "Код file.txt" })).toBe(editor);
  expect((editor as HTMLTextAreaElement).value).toBe("несохранённый текст");
});

test("обзор сохраняет открытые редактор и терминал при переключении", async () => {
  const saved = fixture();
  saved.sessions = [];
  saved.view.tabs = [{ id: "file:w1:file.txt", workspaceId: "w1", sessionId: null }, { id: "terminal:t1", workspaceId: "w1", sessionId: null }];
  saved.view.activeTabs.w1 = "file:w1:file.txt";
  vi.mocked(invoke).mockImplementation(async (command, args: any) => {
    if (command === "snapshot") return structuredClone(saved);
    if (command === "save_view") { saved.view = structuredClone(args.view); return; }
    if (["list_directory", "list_file_drafts"].includes(command)) return [];
    if (command === "open_file") return { path: "file.txt", body: "исходник", base: "исходник", disk: "исходник" };
    if (command === "read_file_disk") return "исходник";
    if (command === "save_file_draft") return;
    throw new Error(command);
  });
  render(<App />);
  const editor = await screen.findByRole("textbox", { name: "Код file.txt" });
  fireEvent.change(editor, { target: { value: "ручные правки" } });
  expect(screen.queryByRole("button", { name: "Обзор" })).toBeNull();
  const toggle = screen.getByRole("button", { name: "Обзор проектов" });
  fireEvent.click(toggle);
  expect(screen.getByRole("complementary", { name: "Обзор проектов" })).toBeTruthy();
  const rail = within(screen.getByRole("navigation", { name: "Инструменты проекта" }));
  expect(rail.getByRole("button", { name: "Обзор проектов" }).getAttribute("aria-pressed")).toBe("true");
  expect(rail.getByRole("button", { name: "Проект" }).getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByText("Все активные проекты")).toBeTruthy();
  expect(screen.getByRole("textbox", { name: "Код file.txt" })).toBe(editor);
  expect(editor.isConnected).toBe(true);
  expect(screen.getByRole("complementary", { name: "Проекты" })).toBeTruthy();
  expect(screen.getByRole("separator", { name: "Ширина проекта" })).toBeTruthy();
  fireEvent.click(toggle);
  expect(screen.getByRole("textbox", { name: "Код file.txt" })).toBe(editor);
  expect((editor as HTMLTextAreaElement).value).toBe("ручные правки");
  fireEvent.click(screen.getByRole("tab", { name: "Терминал t1" }));
  const terminal = await screen.findByRole("tabpanel", { name: "Оболочка t1" });
  fireEvent.click(toggle);
  expect(await screen.findByRole("tabpanel", { name: "Оболочка t1" })).toBe(terminal);
  expect(terminal.isConnected).toBe(true);
  fireEvent.click(rail.getByRole("button", { name: "Проект" }));
  expect(screen.getByRole("complementary", { name: "Обзор проектов" })).toBeTruthy();
  fireEvent.click(screen.getByRole("tab", { name: /^file\.txt/ }));
  expect(screen.getByRole("complementary", { name: "Обзор проектов" })).toBeTruthy();
  fireEvent.click(screen.getByRole("tab", { name: "Терминал t1" }));
  expect(await screen.findByRole("tabpanel", { name: "Оболочка t1" })).toBe(terminal);
  expect(saved.view.tabs).toHaveLength(2);
});

test("обзор обновляет статусы без перестановки проектов и открывает разговор другого проекта", async () => {
  const saved = fixture();
  saved.sessions[0].state = "completed";
  localStorage.setItem("yade.ide.layout", JSON.stringify({ left: "git", selected: {} }));
  const previousView = structuredClone(saved.view);
  vi.mocked(invoke).mockImplementation(async (command, args: any) => {
    if (command === "snapshot") return structuredClone(saved);
    if (command === "save_view") { saved.view = structuredClone(args.view); return; }
    if (["list_directory", "list_file_drafts", "list_git_repositories"].includes(command)) return [];
    throw new Error(command);
  });
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Обзор проектов" }));
  const overview = within(screen.getByRole("complementary", { name: "Обзор проектов" }));
  expect(overview.getByRole("button", { name: /Исправление.*Выполнение завершено/ })).toBeTruthy();
  expect(overview.getByText("Разговоров и терминалов пока нет")).toBeTruthy();
  const session: Session = { id: "s2", workspaceId: "w2", title: "Вопрос по второму проекту", executor: "claude", state: "waiting" };
  saved.sessions.push(session);
  saved.projects[1].lastActivityAt = 1000;
  const open = await screen.findByRole("button", { name: /^Вопрос по второму проекту/ });
  expect(overview.getAllByRole("article")[0].getAttribute("aria-label")).toBe("Проект Первый");
  expect(saved.view).toEqual(previousView);
  fireEvent.click(open);
  await screen.findByRole("heading", { name: session.title });
  expect(screen.getByRole("complementary", { name: "Обзор проектов" })).toBeTruthy();
  expect(saved.view.projectId).toBe("p2");
  expect(saved.view.workspaceId).toBe("w2");
  expect(saved.view.activeTabs.w2).toBe("session:s2");
  expect(saved.view.tabs.map(tab => tab.id)).toEqual(["session:s1", "session:s2"]);
});

test.each(["session", "terminal"] as const)("готовая вкладка выделяется после каждого фонового выполнения, пока её не откроют (%s)", async kind => {
  const saved = fixture();
  const execution = { executor: "codex", title: "Исправление", state: "ready" };
  const terminal = { id: "t1", workspaceId: "w1", state: "running", exitCode: null, error: null, execution };
  const activity = kind === "session" ? saved.sessions[0] : execution;
  activity.state = "ready";
  if (kind === "terminal") {
    saved.sessions = [];
    saved.terminals = [terminal];
    saved.view.tabs = [{ id: "terminal:t1", workspaceId: "w1", sessionId: null }];
  }
  saved.view.tabs.push({ id: "overview:w1", workspaceId: "w1", sessionId: null });
  saved.view.activeTabs.w1 = "overview:w1";
  localStorage.setItem("yade.ide.layout", JSON.stringify({ left: "project", selected: {}, overviewOpen: true }));
  vi.mocked(invoke).mockImplementation(async (command, args: any) => {
    if (command === "snapshot") return structuredClone(saved);
    if (command === "save_view") { saved.view = structuredClone(args.view); return; }
    if (["list_directory", "list_file_drafts", "executor_availability"].includes(command)) return [];
    throw new Error(command);
  });
  render(<App />);
  const overview = within(await screen.findByRole("complementary", { name: "Обзор проектов" }));
  const entry = () => overview.getByRole("button", { name: /^Исправление/ });
  const tab = () => screen.getByRole("tab", { name: /^Исправление/ });
  const unread = () => tab().querySelector(".ide-tab-completion");
  const ready = kind === "session" ? "completed" : "ready";
  async function status(state: string, label: string) {
    activity.state = state;
    await act(async () => { fireEvent(window, new Event("focus")); });
    await overview.findByText(label, { exact: true });
  }

  expect(unread()).toBeNull();
  await status("running", "Работает");
  await status(ready, "Готов");
  expect(unread()).toBeTruthy();
  expect(entry().getAttribute("aria-description")).toBe("Результат не просмотрен");
  fireEvent.click(tab());
  await waitFor(() => expect(unread()).toBeNull());
  expect(entry().getAttribute("aria-description")).toBeNull();

  await status("running", "Работает");
  await status(ready, "Готов");
  expect(unread()).toBeNull();
  await status("running", "Работает");
  fireEvent.click(screen.getByRole("tab", { name: "Обзор" }));
  await waitFor(() => expect(tab().getAttribute("aria-selected")).toBe("false"));
  await status("waiting", "Ждёт ответа");
  await status(ready, "Готов");
  expect(unread()).toBeTruthy();
  fireEvent.click(entry());
  await waitFor(() => expect(unread()).toBeNull());
  expect(entry().getAttribute("aria-description")).toBeNull();
});

test("обзор открывает существующие терминалы текущего и другого проекта без перезапуска и потери вкладок", async () => {
  const saved = fixture();
  saved.sessions = [];
  saved.terminals = [
    { id: "t1", workspaceId: "w1", state: "running", exitCode: null, error: null, lastActivityAt: 1000 },
    { id: "t2", workspaceId: "w2", state: "running", exitCode: null, error: null, lastActivityAt: 2000 },
  ];
  saved.view.tabs = [{ id: "terminal:t1", workspaceId: "w1", sessionId: null }];
  saved.view.activeTabs = { w1: "terminal:t1" };
  vi.mocked(invoke).mockImplementation(async (command, args: any) => {
    if (command === "snapshot") return structuredClone(saved);
    if (command === "save_view") { saved.view = structuredClone(args.view); return; }
    if (["list_directory", "list_file_drafts", "list_git_repositories"].includes(command)) return [];
    throw new Error(command);
  });
  render(<App />);
  const terminal = await screen.findByRole("tabpanel", { name: "Оболочка t1" });
  fireEvent.click(screen.getByRole("button", { name: "Обзор проектов" }));
  const overview = within(screen.getByRole("complementary", { name: "Обзор проектов" }));
  fireEvent.click(overview.getByRole("button", { name: /^Терминал t1/ }));
  expect(await screen.findByRole("tabpanel", { name: "Оболочка t1" })).toBe(terminal);
  expect(saved.view.tabs).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Изменения Git" }));
  expect(screen.getByRole("complementary", { name: "Обзор проектов" })).toBeTruthy();
  fireEvent.click(within(screen.getByRole("complementary", { name: "Обзор проектов" })).getByRole("button", { name: /^Терминал t2/ }));
  await screen.findByRole("tabpanel", { name: "Оболочка t2" });
  expect(saved.view.projectId).toBe("p2");
  expect(saved.view.workspaceId).toBe("w2");
  expect(saved.view.activeTabs.w2).toBe("terminal:t2");
  expect(saved.view.tabs.map(tab => tab.id)).toEqual(["terminal:t1", "terminal:t2"]);
  expect(terminal.isConnected).toBe(true);
  expect(vi.mocked(invoke).mock.calls.some(([command]) => ["start_terminal", "stop_terminal"].includes(command))).toBe(false);
});

test.each(["session", "terminal"] as const)("корзинка в обзоре подтверждает удаление и обновляет вкладки (%s)", async kind => {
  const saved = fixture();
  saved.sessions[0].state = "ready";
  saved.terminals = [{ id: "t1", workspaceId: "w1", state: "running", exitCode: null, error: null }];
  saved.view.tabs.push({ id: "terminal:t1", workspaceId: "w1", sessionId: null });
  const id = kind === "session" ? "s1" : "t1";
  const title = kind === "session" ? "Исправление" : "Терминал t1";
  const action = kind === "session" ? "Удалить разговор" : "Удалить терминал";
  const command = kind === "session" ? "delete_conversation" : "delete_terminal";
  const remove = vi.fn((_args: unknown) => {
    saved.sessions = saved.sessions.filter(session => session.id !== id);
    saved.terminals = saved.terminals?.filter(terminal => terminal.id !== id);
    saved.view.tabs = saved.view.tabs.filter(tab => tab.id !== `${kind}:${id}`);
    saved.view.activeTabs.w1 = saved.view.tabs[0].id;
    return structuredClone(saved.view);
  });
  vi.mocked(invoke).mockImplementation(async (name, args) => {
    if (name === "snapshot") return structuredClone(saved);
    if (name === command) return remove(args);
    if (["list_directory", "list_file_drafts", "executor_availability"].includes(name)) return [];
    throw new Error(name);
  });
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Обзор проектов" }));
  const overview = within(screen.getByRole("complementary", { name: "Обзор проектов" }));
  const trash = overview.getByRole("button", { name: `${action} «${title}»` });
  fireEvent.click(trash);
  const dialog = () => within(screen.getByRole("dialog", { name: action }));
  if (kind === "terminal") expect(dialog().getByText(/Терминал будет остановлен/)).toBeTruthy();
  fireEvent.click(dialog().getByRole("button", { name: "Отмена" }));
  expect(remove).not.toHaveBeenCalled();
  fireEvent.click(trash);
  fireEvent.click(dialog().getByRole("button", { name: "Удалить" }));
  await waitFor(() => expect(trash.isConnected).toBe(false));
  expect(remove).toHaveBeenCalledWith(kind === "session" ? { sessionId: id, confirmed: true }
    : { id, workspaceId: "w1", replacementId: undefined, confirmed: true });
  expect(screen.queryByRole("tab", { name: title })).toBeNull();
  expect(overview.getByRole("button", { name: kind === "session" ? /^Терминал t1/ : /^Исправление/ })).toBeTruthy();
});

test.each([true, false])("корзинка удаляет выбранное или соседнее пространство и обновляет вкладки: %s", async selected => {
  const saved = fixture();
  saved.sessions[0].state = "completed";
  saved.workspaces[1].projectId = "p1";
  saved.view.tabs.push({ id: "overview:w2", workspaceId: "w2", sessionId: null });
  saved.view.activeTabs.w2 = "overview:w2";
  const target = saved.workspaces[selected ? 0 : 1];
  const expected: DeletionCheck = { workspaceId: target.id, path: target.path, kind: "folder", pathExists: true, registered: false, branch: null, head: null, drafts: [], changes: "", unmerged: "" };
  vi.mocked(invoke).mockImplementation(async (command, args: any) => {
    if (command === "snapshot") return structuredClone(saved);
    if (["list_directory", "list_file_drafts"].includes(command)) return [];
    if (command === "inspect_workspace_deletion") return expected;
    if (command === "delete_workspace") {
      target.deleted = true;
      saved.view.tabs = saved.view.tabs.filter(tab => tab.workspaceId !== target.id);
      delete saved.view.activeTabs[target.id];
      if (selected) saved.view.workspaceId = null;
      return;
    }
    throw new Error(command);
  });
  render(<App />);
  await screen.findByRole("heading", { name: "Исправление" });
  const catalog = openProjects();
  fireEvent.click(catalog.getByRole("button", { name: `Удалить пространство ${target.name}` }));
  let confirmation = within(await screen.findByRole("dialog", { name: "Удаление пространства" }));
  await confirmation.findByText(/Папка и вложенные репозитории останутся на диске/);
  expect(invoke).toHaveBeenCalledWith("inspect_workspace_deletion", { workspaceId: target.id });
  expect(vi.mocked(invoke).mock.calls.some(([command]) => command === "delete_workspace" || command === "save_view")).toBe(false);
  fireEvent.click(confirmation.getByRole("button", { name: "Отмена" }));
  expect(catalog.getByRole("button", { name: `Удалить пространство ${target.name}` })).toBeTruthy();
  fireEvent.click(catalog.getByRole("button", { name: `Удалить пространство ${target.name}` }));
  confirmation = within(await screen.findByRole("dialog", { name: "Удаление пространства" }));
  await confirmation.findByText(/Папка и вложенные репозитории останутся на диске/);
  fireEvent.click(confirmation.getByRole("button", { name: "Удалить пространство" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Удаление пространства" })).toBeNull());
  expect(invoke).toHaveBeenCalledWith("delete_workspace", { expected, confirmed: true, discardWork: false });
  expect(catalog.queryByRole("button", { name: target.name })).toBeNull();
  fireEvent.click(catalog.getByRole("button", { name: "Закрыть Все проекты" }));
  expect(screen.queryByRole("tab", { name: selected ? /^Исправление/ : "Обзор" })).toBeNull();
  if (!selected) expect(screen.getByRole("heading", { name: "Исправление" })).toBeTruthy();
});

test("настройки внешнего вида доступны из приложения и сохраняются после его повторного открытия", async () => {
  const saved = fixture();
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === "snapshot") return structuredClone(saved);
    if (["list_directory", "list_file_drafts"].includes(command)) return [];
  });
  const app = render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Открыть настройки" }));
  const dialog = within(screen.getByRole("dialog", { name: "Настройки" }));
  fireEvent.click(dialog.getByRole("combobox", { name: "Шрифт чата" }));
  fireEvent.click(dialog.getByRole("option", { name: "С засечками" }));
  fireEvent.click(dialog.getByRole("button", { name: "Закрыть настройки" }));
  expect(app.container.querySelector<HTMLElement>(".appearance-root")!.style.getPropertyValue("--font-chat")).toBe("ui-serif, Georgia, serif");
  app.unmount();
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Открыть настройки" }));
  expect(screen.getByRole("combobox", { name: "Шрифт чата" }).textContent).toBe("С засечками");
});

test.each([true, false])("исполнители загружаются после кадра интерфейса без клика, поддержка свободного времени: %s", async supportsIdle => {
  vi.useFakeTimers();
  let frame!: FrameRequestCallback;
  vi.stubGlobal("requestAnimationFrame", vi.fn(callback => { frame = callback; return 1; }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const idle = vi.fn(callback => window.setTimeout(callback, 0));
  vi.stubGlobal("requestIdleCallback", supportsIdle ? idle : undefined);
  vi.stubGlobal("cancelIdleCallback", vi.fn(id => window.clearTimeout(id)));
  let loadSnapshot!: (value: Snapshot) => void;
  let finishSearch!: (value: unknown) => void;
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === "snapshot") return new Promise(resolve => { loadSnapshot = resolve; });
    if (["list_directory", "list_file_drafts"].includes(command)) return [];
    if (command === "executor_availability") return new Promise(resolve => { finishSearch = resolve; });
    throw new Error(command);
  });
  render(<App />);
  expect(requestAnimationFrame).not.toHaveBeenCalled();
  await act(async () => loadSnapshot(fixture()));
  const trigger = screen.getByRole("button", { name: "Новая вкладка" });
  expect(vi.mocked(invoke).mock.calls.some(([command]) => command === "executor_availability")).toBe(false);
  expect(idle).not.toHaveBeenCalled();
  act(() => frame(0));
  if (supportsIdle) expect(idle).toHaveBeenCalledWith(expect.any(Function), { timeout: 2000 });
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "executor_availability")).toHaveLength(1);
  expect(screen.queryByRole("menu")).toBeNull();
  expect((trigger as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(trigger);
  expect(screen.getByText("Поиск исполнителей…")).toBeTruthy();
  await act(async () => finishSearch([{ executor: "codex", state: "ready" }]));
  expect(screen.getByRole("menuitem", { name: /^Codex\s*Новый разговор/ })).toBeTruthy();
  expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "executor_availability")).toHaveLength(1);
  fireEvent.click(trigger);
  fireEvent.click(trigger);
  await act(async () => {});
  expect(screen.getByRole("menuitem", { name: /^Codex\s*Новый разговор/ })).toBeTruthy();
  expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "executor_availability")).toHaveLength(1);
});

test("название терминальной вкладки обновляется после ответа без активных обычных разговоров", async () => {
  const saved = fixture(); saved.sessions[0].state = "completed";
  saved.terminals = [{ id: "t1", workspaceId: "w1", state: "running", exitCode: null, error: null,
    execution: { executor: "codex", state: "ready", title: null } }];
  saved.view.tabs.push({ id: "terminal:t1", workspaceId: "w1", sessionId: null });
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === "snapshot") return structuredClone(saved);
    if (["list_directory", "list_file_drafts", "executor_availability"].includes(command)) return [];
  });
  render(<App />);
  await screen.findByRole("tab", { name: "Терминал t1" });
  saved.terminals[0].execution!.title = "Восстановление вкладок";
  await screen.findByRole("tab", { name: "Восстановление вкладок" });
  expect(screen.getByRole("heading", { name: "Исправление" })).toBeTruthy();
  expect(vi.mocked(invoke).mock.calls.some(([command]) => ["start_terminal", "stop_terminal"].includes(command))).toBe(false);
});

test("состояние экранного диктора обновляется у открытого терминала без перезапуска", async () => {
  const saved = { ...fixture(), screenReaderEnabled: false };
  saved.sessions[0].state = "completed";
  saved.terminals = [{ id: "t1", workspaceId: "w1", state: "running", exitCode: null, error: null }];
  saved.view.tabs.push({ id: "terminal:t1", workspaceId: "w1", sessionId: null });
  saved.view.activeTabs.w1 = "terminal:t1";
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === "snapshot") return structuredClone(saved);
    if (["list_directory", "list_file_drafts", "executor_availability"].includes(command)) return [];
  });
  render(<App />);
  const panel = await screen.findByRole("tabpanel", { name: "Оболочка t1" });
  expect(panel.getAttribute("data-screen-reader")).toBe("false");
  saved.screenReaderEnabled = true;
  await waitFor(() => expect(panel.getAttribute("data-screen-reader")).toBe("true"));
  saved.screenReaderEnabled = false;
  await waitFor(() => expect(panel.getAttribute("data-screen-reader")).toBe("false"));
  expect(screen.getByRole("tabpanel", { name: "Оболочка t1" })).toBe(panel);
  expect(vi.mocked(invoke).mock.calls.some(([command]) => ["start_terminal", "stop_terminal"].includes(command))).toBe(false);
});

test("штатное название обновляет вкладку и историю без их повторного открытия", async () => {
  const saved = fixture(); saved.sessions[0].title = "Новый чат";
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === "snapshot") return structuredClone(saved);
    if (["list_directory", "list_file_drafts", "executor_availability"].includes(command)) return [];
  });
  render(<App />);
  await screen.findByRole("heading", { name: "Новый чат" });
  saved.sessions[0].title = "Восстановление вкладок"; saved.sessions[0].state = "completed";
  await screen.findByRole("tab", { name: /Восстановление вкладок · Codex/ });
  await screen.findByRole("heading", { name: "Восстановление вкладок" });
  fireEvent.click(screen.getByRole("button", { name: "История разговоров" }));
  expect(screen.getByRole("button", { name: /Открыть историю «Восстановление вкладок»/ })).toBeTruthy();
});

test("фоновое название обновляет неактивную вкладку и историю после завершения всех ответов", async () => {
  const saved = fixture(); saved.sessions[0].state = "completed";
  saved.sessions.push({ ...saved.sessions[0], id: "s2", title: "Новый чат" });
  saved.view.tabs.push({ id: "session:s2", workspaceId: "w1", sessionId: "s2" });
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === "snapshot") return structuredClone(saved);
    if (["list_directory", "list_file_drafts", "executor_availability"].includes(command)) return [];
  });
  render(<App />);
  await screen.findByRole("heading", { name: "Исправление" });
  expect(screen.getByRole("tab", { name: /Новый чат · Codex/ })).toBeTruthy();
  saved.sessions[1].title = "Восстановление вкладок";
  await act(async () => { for (const callback of events) callback({ payload: {
    sequence: 10, context: { workspaceId: "w1", sessionId: "s2", runId: "run-s2" }, kind: "session_title", payload: { title: "Восстановление вкладок" },
  } }); });
  await screen.findByRole("tab", { name: /Восстановление вкладок · Codex/ });
  expect(screen.getByRole("heading", { name: "Исправление" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "История разговоров" }));
  expect(screen.getByRole("button", { name: /Открыть историю «Восстановление вкладок»/ })).toBeTruthy();
});

test.each([false, true])("верхнее меню создаёт вкладку выбранного разговора, выбор клавиатурой: %s", async keyboard => {
  const saved = fixture();
  const created: Session = { id: "s2", workspaceId: "w1", executor: "claude", title: "Новый чат", state: "ready" };
  vi.mocked(invoke).mockImplementation(async (command, args: any) => {
    if (command === "snapshot") return structuredClone(saved);
    if (["list_directory", "list_file_drafts"].includes(command)) return [];
    if (command === "save_view") { saved.view = structuredClone(args.view); return; }
    if (command === "executor_availability") return [{ executor: "claude", path: "/bin/claude", version: "1.0", state: "ready", reason: "Готов", action: "" }];
    if (command === "create_claude_session") { saved.sessions.push(created); return created; }
    throw new Error(command);
  });
  render(<App />);
  const trigger = await screen.findByRole("button", { name: "Новая вкладка" });
  if (keyboard) fireEvent.keyDown(window, { key: "t", code: "KeyT", metaKey: true });
  else fireEvent.click(trigger);
  const item = await screen.findByRole("menuitem", { name: /^Claude Code\s*Новый разговор/ });
  if (keyboard) fireEvent.keyDown(document.activeElement!, { key: "2", code: "Digit2" });
  else fireEvent.click(item);
  await screen.findByRole("heading", { name: "Новый чат" });
  expect(saved.view.activeTabs.w1).toBe("session:s2");
  expect(screen.getByRole("tab", { name: /Новый чат · Claude Code/ }).getAttribute("aria-selected")).toBe("true");
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("терминал из верхнего меню открывается общей вкладкой и восстанавливается после перезапуска", async () => {
  const saved = fixture();
  vi.mocked(invoke).mockImplementation(async (command, args: any) => {
    if (command === "snapshot") return structuredClone(saved);
    if (["list_directory", "list_file_drafts", "executor_availability"].includes(command)) return [];
    if (command === "save_view") { saved.view = structuredClone(args.view); return; }
    if (command === "start_terminal") return { id: "t1" };
    throw new Error(command);
  });
  const first = render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Новая вкладка" }));
  fireEvent.click(screen.getByRole("menuitem", { name: /Терминал/ }));
  await screen.findByRole("tabpanel", { name: "Оболочка t1" });
  expect(saved.view.tabs).toContainEqual({ id: "terminal:t1", workspaceId: "w1", sessionId: null });
  expect(saved.view.activeTabs.w1).toBe("terminal:t1");
  const tabs = within(screen.getByRole("tablist", { name: "Вкладки пространства" }));
  expect(tabs.getByRole("tab", { name: "Терминал t1" }).getAttribute("aria-selected")).toBe("true");
  expect(tabs.getByRole("tab", { name: /^Исправление/ }).getAttribute("aria-selected")).toBe("false");
  expect(screen.queryByRole("heading", { name: "Исправление" })).toBeNull();
  expect(screen.queryByRole("heading", { name: "Обзор пространства" })).toBeNull();
  expect(screen.queryByRole("region", { name: "Нижняя панель", hidden: true })).toBeNull();
  expect(screen.queryByRole("separator", { name: "Высота терминала" })).toBeNull();
  expect(screen.queryByRole("region", { name: "Терминалы пространства" })).toBeNull();
  first.unmount();
  render(<App />);
  await screen.findByRole("tabpanel", { name: "Оболочка t1" });
  expect(screen.getByRole("tab", { name: "Терминал t1" }).getAttribute("aria-selected")).toBe("true");
  expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "start_terminal")).toHaveLength(1);
});

test("найденные при открытии исполнители сохраняются до закрытия приложения и при смене пространства", async () => {
  const saved = fixture();
  let now = 1000;
  let searches = 0;
  let frame!: FrameRequestCallback;
  let preload!: IdleRequestCallback;
  vi.stubGlobal("requestAnimationFrame", vi.fn(callback => { frame = callback; return 1; }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("requestIdleCallback", vi.fn(callback => { preload = callback; return 1; }));
  vi.stubGlobal("cancelIdleCallback", vi.fn());
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  vi.mocked(invoke).mockImplementation(async (command, args: any) => {
    if (command === "snapshot") return structuredClone(saved);
    if (["list_directory", "list_file_drafts"].includes(command)) return [];
    if (command === "save_view") { saved.view = structuredClone(args.view); return; }
    if (command === "executor_availability") return [{ executor: ++searches === 1 ? "codex" : "claude", state: "ready" }];
    throw new Error(command);
  });
  try {
    render(<App />);
    await screen.findByRole("button", { name: "Новая вкладка" });
    act(() => frame(0));
    await act(async () => preload({ didTimeout: false, timeRemaining: () => 50 }));
    expect(searches).toBe(1);
    expect(screen.queryByRole("menu")).toBeNull();
    now += 5 * 60_000;
    fireEvent.click(screen.getByRole("button", { name: "Новая вкладка" }));
    await screen.findByRole("menuitem", { name: /^Codex\s*Новый разговор/ });
    fireEvent.click(screen.getByRole("button", { name: "Новая вкладка" }));
    fireEvent.click(screen.getByRole("button", { name: "Новая вкладка" }));
    expect(screen.getByRole("menuitem", { name: /^Codex\s*Новый разговор/ })).toBeTruthy();
    expect(screen.queryByText("Поиск исполнителей…")).toBeNull();
    expect(searches).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Новая вкладка" }));
    chooseProject(/^Второй/);
    await screen.findByRole("heading", { name: "Второй" });
    now += 5 * 60_000;
    fireEvent.click(screen.getByRole("button", { name: "Новая вкладка" }));
    await screen.findByRole("menuitem", { name: /^Codex\s*Новый разговор/ });
    expect(searches).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Новая вкладка" }));
    now += 60_000;
    fireEvent.click(screen.getByRole("button", { name: "Новая вкладка" }));
    await screen.findByRole("menuitem", { name: /^Codex\s*Новый разговор/ });
    expect(searches).toBe(1);
    expect(screen.queryByRole("menuitem", { name: /^Claude Code\s*Новый разговор/ })).toBeNull();
  } finally { clock.mockRestore(); }
});

test("повторное открытие использует текущий поиск и сохраняет результат закрытого меню", async () => {
  let finish!: (value: unknown) => void;
  let searches = 0;
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === "snapshot") return fixture();
    if (["list_directory", "list_file_drafts"].includes(command)) return [];
    if (command === "executor_availability") {
      searches++;
      return new Promise(resolve => { finish = resolve; });
    }
    throw new Error(command);
  });
  render(<App />);
  const trigger = await screen.findByRole("button", { name: "Новая вкладка" });
  fireEvent.click(trigger);
  fireEvent.click(trigger);
  fireEvent.click(trigger);
  expect(searches).toBe(1);
  fireEvent.click(trigger);
  await act(async () => finish([{ executor: "codex", state: "ready" }]));
  fireEvent.click(trigger);
  await screen.findByRole("menuitem", { name: /^Codex\s*Новый разговор/ });
  expect(searches).toBe(1);
});

test("ошибка поиска не кешируется, успешный пустой список кешируется", async () => {
  let searches = 0;
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === "snapshot") return fixture();
    if (["list_directory", "list_file_drafts"].includes(command)) return [];
    if (command === "executor_availability") {
      if (++searches === 1) throw new Error("Поиск недоступен");
      return [];
    }
    throw new Error(command);
  });
  render(<App />);
  const trigger = await screen.findByRole("button", { name: "Новая вкладка" });
  fireEvent.click(trigger);
  expect((await screen.findByRole("alert")).textContent).toContain("Поиск недоступен");
  fireEvent.click(trigger);
  fireEvent.click(trigger);
  await screen.findByText(/Исполнители не найдены/);
  fireEvent.click(trigger);
  fireEvent.click(trigger);
  await screen.findByText(/Исполнители не найдены/);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(searches).toBe(2);
});

test("переключение, вкладки и ширина восстанавливаются без запуска сохранённой сессии", async () => {
  const saved = fixture();
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "list_directory") return [];
    if (command === "list_file_drafts") return [];
    if (command === "executor_availability") return [];
    if (command === "snapshot") return structuredClone(saved);
    if (command === "save_view") { saved.view = structuredClone((args as { view: View }).view); return undefined; }
    throw new Error(`неожиданная команда: ${command}`);
  });
  const first = render(<App />);
  await screen.findByRole("heading", { name: "Исправление" });
  chooseProject(/^Второй/);
  await screen.findByRole("heading", { name: "Второй" });
  expect(screen.getByText("/second", { selector: "p" })).toBeTruthy();
  for (let i = 0; i < 3; i++) fireEvent.keyDown(screen.getByRole("separator", { name: "Ширина проекта" }), { key: "ArrowRight" });
  await waitFor(() => expect(saved.view.sidebarWidth).toBe(320));
  first.unmount();
  const second = render(<App />);
  await screen.findByRole("heading", { name: "Второй" });
  expect(screen.getByRole("separator", { name: "Ширина проекта" }).getAttribute("aria-valuenow")).toBe("320");
  expect(screen.getByRole("tab", { name: "Обзор" }).getAttribute("aria-selected")).toBe("true");
  chooseProject(/^Первый/);
  await screen.findByRole("heading", { name: "Исправление" });
  fireEvent.click(screen.getByRole("button", { name: "Закрыть вкладку Исправление" }));
  await waitFor(() => expect(saved.view.tabs.some(t => t.sessionId === "s1")).toBe(false));
  second.unmount();
  render(<App />);
  await screen.findByRole("heading", { name: "Выберите вкладку" });
  expect(screen.queryByRole("tab", { name: "Исправление" })).toBeNull();
  expect(invoke).toHaveBeenCalled();
  expect(vi.mocked(invoke).mock.calls.every(([command]) => ["snapshot", "save_view", "list_directory", "list_file_drafts", "executor_availability"].includes(command))).toBe(true);
  expect(saved.sessions[0].state).toBe("running");
});

test("перетаскивание с дробными координатами сохраняет целую ширину и восстанавливает её", async () => {
  const saved = fixture();
  vi.mocked(invoke).mockImplementation(async (command, args: any) => {
    if (command === "snapshot") return structuredClone(saved);
    if (["list_directory", "list_file_drafts"].includes(command)) return [];
    if (command === "save_view") {
      if (!Number.isInteger(args.view.sidebarWidth)) throw new Error("sidebarWidth должен быть целым");
      saved.view = structuredClone(args.view);
      return;
    }
    throw new Error(command);
  });
  const first = render(<App />);
  const separator = await screen.findByRole("separator", { name: "Ширина проекта" });
  separator.setPointerCapture = vi.fn();
  separator.hasPointerCapture = () => true;
  separator.releasePointerCapture = vi.fn();
  fireEvent(separator, Object.assign(new Event("pointerdown", { bubbles: true }), { pointerId: 1, clientX: 260.25 }));
  fireEvent(separator, Object.assign(new Event("pointermove", { bubbles: true }), { pointerId: 1, clientX: 347.23828125 }));
  fireEvent.pointerUp(separator, { pointerId: 1 });
  fireEvent.lostPointerCapture(separator, { pointerId: 1 });
  await waitFor(() => expect(saved.view.sidebarWidth).toBe(347));
  expect(screen.queryByRole("alert")).toBeNull();
  first.unmount();
  render(<App />);
  expect((await screen.findByRole("separator", { name: "Ширина проекта" })).getAttribute("aria-valuenow")).toBe("347");
});

test("ошибка сохранения видна, выбранный контекст остаётся сохранённым", async () => {
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === "list_directory") return [];
    if (command === "list_file_drafts") return [];
    if (command === "snapshot") return fixture();
    throw new Error("диск недоступен");
  });
  render(<App />);
  await screen.findByRole("heading", { name: "Исправление" });
  chooseProject(/^Второй/);
  expect((await screen.findByRole("alert")).textContent).toContain("Расположение не сохранено");
  expect(screen.getByRole("heading", { name: "Первый" })).toBeTruthy();
  expect(screen.getByRole("status").textContent).toBe("Не сохранено");
});

test("запоздавшее открытие терминала сохраняет новый контекст, закрытые вкладки и ширину панели", async () => {
  const saved = fixture();
  let finishStart: ((value: { id: string }) => void) | undefined;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "list_directory") return [];
    if (command === "list_file_drafts") return [];
    if (command === "snapshot") return structuredClone(saved);
    if (command === "save_view") { saved.view = structuredClone((args as { view: View }).view); return; }
    if (command === "start_terminal") return new Promise<{ id: string }>(resolve => { finishStart = resolve; });
    throw new Error(`неожиданная команда: ${command}`);
  });
  render(<App />);
  await screen.findByRole("heading", { name: "Исправление" });
  fireEvent.click(screen.getByRole("button", { name: "Новая вкладка" }));
  fireEvent.click(screen.getByRole("menuitem", { name: /Терминал/ }));
  fireEvent.click(screen.getByRole("button", { name: "Закрыть вкладку Исправление" }));
  await screen.findByRole("heading", { name: "Выберите вкладку" });
  chooseProject(/^Второй/);
  await screen.findByRole("heading", { name: "Второй" });
  for (let i = 0; i < 3; i++) fireEvent.keyDown(screen.getByRole("separator", { name: "Ширина проекта" }), { key: "ArrowRight" });
  await waitFor(() => expect(saved.view.sidebarWidth).toBe(320));
  await act(async () => { finishStart!({ id: "t1" }); });
  await waitFor(() => expect(saved.view.tabs.some(tab => tab.id === "terminal:t1")).toBe(true));
  expect(saved.view).toMatchObject({ projectId: "p2", workspaceId: "w2", sidebarWidth: 320 });
  expect(saved.view.tabs.map(tab => tab.id)).toEqual(["overview:w2", "terminal:t1"]);
  expect(screen.getByRole("heading", { name: "Второй" })).toBeTruthy();
});

test("открытие терминала ждёт сохранения нового контекста и добавляет вкладку к нему", async () => {
  const saved = fixture();
  let finishStart: ((value: { id: string }) => void) | undefined;
  let finishSave: (() => void) | undefined;
  let writes = 0;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "list_directory") return [];
    if (command === "list_file_drafts") return [];
    if (command === "snapshot") return structuredClone(saved);
    if (command === "start_terminal") return new Promise<{ id: string }>(resolve => { finishStart = resolve; });
    if (command === "save_view") {
      if (++writes === 1) await new Promise<void>(resolve => { finishSave = resolve; });
      saved.view = structuredClone((args as { view: View }).view);
      return;
    }
    throw new Error(`неожиданная команда: ${command}`);
  });
  render(<App />);
  await screen.findByRole("heading", { name: "Исправление" });
  fireEvent.click(screen.getByRole("button", { name: "Новая вкладка" }));
  fireEvent.click(screen.getByRole("menuitem", { name: /Терминал/ }));
  chooseProject(/^Второй/);
  await waitFor(() => expect(finishSave).toBeDefined());
  await act(async () => { finishStart!({ id: "t1" }); });
  expect(writes).toBe(1);
  await act(async () => { finishSave!(); });
  await waitFor(() => expect(saved.view.tabs.some(tab => tab.id === "terminal:t1")).toBe(true));
  expect(saved.view).toMatchObject({ projectId: "p2", workspaceId: "w2" });
  expect(saved.view.tabs.map(tab => tab.id)).toEqual(["session:s1", "overview:w2", "terminal:t1"]);
  expect(screen.getByRole("heading", { name: "Второй" })).toBeTruthy();
});

test("ошибка добавления выбранной папки остаётся видимой", async () => {
  vi.mocked(open).mockResolvedValue("/missing/Репозиторий");
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === "list_directory") return [];
    if (command === "list_file_drafts") return [];
    if (command === "snapshot") return fixture();
    if (command === "register_folder") throw new Error("папка недоступна");
    return undefined;
  });
  render(<App />);
  await screen.findByRole("heading", { name: "Первый" });
  fireEvent.click(screen.getByRole("button", { name: "Добавить" }));
  fireEvent.click(screen.getByRole("button", { name: "Выбрать папку…" }));
  await screen.findByText("Репозиторий", { selector: "strong" });
  fireEvent.click(within(screen.getByRole("dialog", { name: "Добавить проект" })).getByRole("button", { name: "Добавить" }));
  expect((await screen.findByRole("alert")).textContent).toContain("папка недоступна");
  expect(invoke).toHaveBeenCalledWith("register_folder", { name: "Репозиторий", path: "/missing/Репозиторий", groupId: null });
  expect(screen.getByRole("heading", { name: "Первый" })).toBeTruthy();
});

test.each(["верхняя панель", "каталог", "карточка проекта"])("%s: создание пространства сразу открывает его и сохраняет прежние вкладки", async entry => {
  const saved = fixture();
  saved.projects[0].kind = "repository";
  const created = { ...saved.workspaces[0], id: "w3", name: "Задача", kind: "worktree", path: "/first-task", sourceRef: "main", gitRef: "feature" };
  let finish: (() => void) | undefined;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "project_branches") return ["main"];
    if (command === "list_directory") return [];
    if (command === "list_file_drafts") return [];
    if (command === "snapshot") return structuredClone(saved);
    if (command === "save_view") { saved.view = structuredClone((args as { view: View }).view); return; }
    if (command === "create_worktree") return new Promise<typeof created>(resolve => { finish = () => { saved.workspaces.push(created); resolve(created); }; });
    throw new Error(`неожиданная команда: ${command}`);
  });
  render(<App />);
  await screen.findByRole("heading", { name: "Первый" });
  if (entry === "верхняя панель") fireEvent.click(screen.getByRole("button", { name: "Создать пространство" }));
  else fireEvent.click(openProjects().getByRole("button", { name: entry === "каталог" ? "Новое пространство" : "Новое пространство проекта Первый" }));
  const dialog = within(screen.getByRole("dialog", { name: "Новое пространство" }));
  expect(dialog.getByText("Первый")).toBeTruthy();
  expect(screen.queryByRole("dialog", { name: "Управление пространствами" })).toBeNull();
  expect((dialog.getByRole("button", { name: "Создать пространство" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Название пространства"), { target: { value: "Задача" } });
  fireEvent.change(screen.getByLabelText("Исходная ветка или коммит"), { target: { value: "main" } });
  fireEvent.change(screen.getByLabelText(/Новая ветка/), { target: { value: "feature" } });
  fireEvent.click(dialog.getByRole("button", { name: "Создать пространство" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("create_worktree", {
    request: { projectId: "p1", name: "Задача", sourceRef: "main", branch: "feature" },
  }));
  expect((dialog.getByRole("button", { name: "Создание пространства…" }) as HTMLButtonElement).disabled).toBe(true);
  expect(saved.view.workspaceId).toBe("w1");
  await act(async () => finish!());
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Новое пространство" })).toBeNull());
  await waitFor(() => expect(saved.view.workspaceId).toBe(created.id));
  expect(saved.view.projectId).toBe(created.projectId);
  expect(saved.view.tabs).toEqual([
    { id: "session:s1", workspaceId: "w1", sessionId: "s1" },
    { id: "overview:w3", workspaceId: "w3", sessionId: null },
  ]);
  expect(saved.view.activeTabs).toEqual({ w1: "session:s1", w3: "overview:w3" });
  expect(await screen.findByRole("heading", { name: "Обзор пространства" })).toBeTruthy();
  expect(screen.getByText(created.path)).toBeTruthy();
  expect(invoke).toHaveBeenCalledWith("list_directory", expect.objectContaining({ workspaceId: created.id }));
  chooseProject(/^Второй/);
  await screen.findByRole("heading", { name: "Второй" });
  expect(saved.view.projectId).toBe("p2");
});

test("общая папка открывается без общей ветки и сохраняет собственный контекст", async () => {
  const saved = fixture();
  saved.groups[0].path = "/shared";
  saved.projects[0].path = "/shared/first";
  saved.projects[0].kind = "repository";
  const shared = { ...saved.workspaces[0], id: "shared", projectId: null, groupId: "g1", name: "Команда", path: "/shared" };
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "list_directory") return [];
    if (command === "list_file_drafts") return [];
    if (command === "snapshot") return structuredClone(saved);
    if (command === "open_group_folder") { saved.workspaces.push(shared); return shared; }
    if (command === "save_view") { saved.view = structuredClone((args as { view: View }).view); return; }
    throw new Error(`неожиданная команда: ${command}`);
  });
  render(<App />);
  await screen.findByRole("heading", { name: "Первый" });
  chooseProject("Открыть общую папку Команда");
  await screen.findByRole("region", { name: "Проекты общей папки" });
  expect(screen.getByText(/У вложенных репозиториев отдельные ветки/)).toBeTruthy();
  expect(saved.view.projectId).toBeNull();
  expect(saved.view.workspaceId).toBe("shared");
});

test.each(["верхняя панель", "каталог", "карточка проекта"])("%s сразу открывает создание пространства", async entry => {
  const saved = fixture();
  saved.projects[0].kind = "repository";
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === "project_branches") return ["main"];
    if (command === "snapshot") return structuredClone(saved);
    if (["list_directory", "list_file_drafts"].includes(command)) return [];
  });
  render(<App />);
  await screen.findByRole("heading", { name: "Первый" });
  if (entry === "верхняя панель") fireEvent.click(screen.getByRole("button", { name: "Создать пространство" }));
  else {
    const projects = openProjects();
    fireEvent.click(projects.getByRole("button", { name: entry === "каталог" ? "Новое пространство" : "Новое пространство проекта Первый" }));
  }
  const dialog = within(screen.getByRole("dialog", { name: "Новое пространство" }));
  expect(dialog.getByText("Первый")).toBeTruthy();
  expect(dialog.getByLabelText("Название пространства")).toBeTruthy();
  expect(screen.queryByRole("dialog", { name: "Управление пространствами" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Архивировать пространство" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Проверить удаление пространства" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Сохранить команду подготовки" })).toBeNull();
});

test("меню пространств показывает ветки текущего проекта и сохраняет вкладки при переключении", async () => {
  const saved = fixture();
  saved.sessions[0].state = "completed";
  saved.workspaces[0].gitRef = "main";
  saved.workspaces.push(
    { ...saved.workspaces[0], id: "w3", name: "Исправление доставки", gitRef: "fix/delivery", path: "/first-fix" },
    { ...saved.workspaces[0], id: "w4", name: "Архивное", archived: true },
    { ...saved.workspaces[0], id: "w5", name: "Удалённое", deleted: true },
  );
  vi.mocked(invoke).mockImplementation(async (command, args: any) => {
    if (command === "snapshot") return structuredClone(saved);
    if (["list_directory", "list_file_drafts", "executor_availability"].includes(command)) return [];
    if (command === "save_view") { saved.view = structuredClone(args.view); return; }
    throw new Error(command);
  });
  render(<App />);
  const trigger = await screen.findByRole("combobox", { name: "Пространство" });
  expect(trigger.textContent).toBe("Основное");
  expect(within(screen.getByRole("banner")).getByTitle("main").textContent).toBe("main");
  expect(within(screen.getByRole("button", { name: "Выбрать проект" })).getByText("2 пространства")).toBeTruthy();
  fireEvent.click(trigger);
  expect(screen.getByText("В текущем проекте")).toBeTruthy();
  const options = within(screen.getByRole("listbox", { name: "Пространство" }));
  expect(options.getAllByRole("option")).toHaveLength(2);
  const selected = options.getByRole("option", { name: "Основное main" });
  expect(selected.getAttribute("aria-selected")).toBe("true");
  expect(document.activeElement).toBe(selected);
  fireEvent.keyDown(selected, { key: "ArrowDown" });
  const next = options.getByRole("option", { name: "Исправление доставки fix/delivery" });
  expect(document.activeElement).toBe(next);
  fireEvent.click(next);
  await waitFor(() => expect(saved.view.workspaceId).toBe("w3"));
  expect(saved.view.tabs.map(tab => tab.id)).toEqual(["session:s1", "overview:w3"]);
  expect(trigger.textContent).toBe("Исправление доставки");
  expect(within(screen.getByRole("banner")).getByTitle("fix/delivery").textContent).toBe("fix/delivery");
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(document.activeElement).toBe(trigger);
  expect(within(screen.getByRole("banner")).getAllByText("Исправление доставки")).toHaveLength(1);
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole("option", { name: "Основное main" }));
  await screen.findByRole("heading", { name: "Исправление" });
  expect(saved.view.activeTabs.w1).toBe("session:s1");
  fireEvent.click(trigger);
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(document.activeElement).toBe(trigger);
  fireEvent.click(trigger);
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole("listbox")).toBeNull();
});

test.each([
  ["fix/delivery", "fix/delivery"],
  ["a".repeat(40), "Без ветки · aaaaaaaa"],
  ["b".repeat(64), "Без ветки · bbbbbbbb"],
  [null, ""],
])("шапка и меню пространства показывают ветку или короткий коммит: %s", async (gitRef, reference) => {
  const saved = fixture();
  saved.sessions = [];
  saved.workspaces[0] = { ...saved.workspaces[0], kind: "worktree", path: "/project/workspaces/fixes", gitRef };
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === "snapshot") return structuredClone(saved);
    if (["list_directory", "list_file_drafts", "executor_availability"].includes(command)) return [];
  });
  render(<App />);
  const trigger = await screen.findByRole("combobox", { name: "Пространство" });
  const badge = screen.getByRole("banner").querySelector(".ide-branch");
  if (gitRef) {
    expect(badge?.textContent).toBe(reference);
    expect(badge?.getAttribute("title")).toBe(gitRef);
  } else expect(badge).toBeNull();
  fireEvent.click(trigger);
  const option = screen.getByRole("option", { name: reference ? `Основное ${reference}` : "Основное" });
  if (gitRef) expect(within(option).getByTitle(gitRef)).toBeTruthy();
  expect(option.textContent).not.toContain("Worktree:");
  if (gitRef && gitRef !== reference) expect(option.textContent).not.toContain(gitRef);
});

function mockHeaderGit(remotes = ["origin"], upstream: string | null = "origin/main") {
  const saved = fixture();
  saved.sessions = [];
  saved.workspaces[0].gitRef = "main";
  let reference = "main";
  vi.mocked(invoke).mockImplementation(async (command, args: any) => {
    if (command === "snapshot") return structuredClone(saved);
    if (command === "save_view") { saved.view = args.view; return; }
    if (["list_directory", "list_file_drafts", "executor_availability", "git_stashes"].includes(command)) return [];
    if (command === "list_git_repositories") return ["", "nested"];
    if (command === "git_status") return { reference: args.target.repository ? "nested-branch" : reference, changes: [], remotes, upstream, ahead: 0, behind: 0, operation: null };
    if (command === "git_branches") return ["main", "feature/new"].map(name => ({ name, reference: `refs/heads/${name}`, kind: "local", current: reference === name, upstream: null }));
    if (command === "git_history") return { commits: [], hasMore: false };
    if (command === "git_action") { if (args.action.kind === "switch") reference = "feature/new"; return "Готово"; }
    throw new Error(command);
  });
}

async function headerGitAction(label: string) {
  const branch = await screen.findByRole("button", { name: "Git: main" });
  fireEvent.contextMenu(branch, { clientX: 300, clientY: 25 });
  fireEvent.click(screen.getByRole("menuitem", { name: label }));
}

test("клик по ветке в хедере открывает изменения, контекстное меню — историю текущей ветки", async () => {
  mockHeaderGit();
  render(<App />);
  const branch = await screen.findByRole("button", { name: "Git: main" });
  expect(invoke).not.toHaveBeenCalledWith("list_git_repositories", expect.anything());
  fireEvent.click(branch);
  await screen.findByRole("button", { name: "Посмотреть историю" });
  branch.focus();
  fireEvent.keyDown(branch, { key: "F10", shiftKey: true });
  fireEvent.click(screen.getByRole("menuitem", { name: "История ветки" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("git_history", { target: { workspaceId: "w1", repository: "" }, options: { reference: "refs/heads/main", query: "", author: "", offset: 0 } }));
  await headerGitAction("Изменения и коммит");
  await screen.findByRole("button", { name: "Посмотреть историю" });
});

test.each(["fetch", "pull", "push"] as const)("меню ветки в хедере выполняет %s в корневом репозитории после выбора вложенного", async kind => {
  mockHeaderGit();
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Изменения Git" }));
  fireEvent.click(await screen.findByRole("combobox", { name: "Репозиторий" }));
  fireEvent.click(screen.getByRole("option", { name: "nested" }));
  await waitFor(() => expect(screen.getByRole("combobox", { name: "Текущая ветка" }).textContent).toBe("main"));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("git_status", { target: { workspaceId: "w1", repository: "nested" } }));
  fireEvent.click(screen.getByRole("button", { name: "Проект" }));
  await headerGitAction({ fetch: "Получить изменения", pull: "Обновить ветку", push: "Отправить коммиты" }[kind]);
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("git_action", { target: { workspaceId: "w1", repository: "" }, action: { kind, ...(kind === "push" ? { remote: null, force: false } : {}) } }));
  expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "git_action")).toHaveLength(1);
});

test("переключение ветки из хедера обновляет название, создание использует существующий диалог", async () => {
  mockHeaderGit();
  render(<App />);
  await headerGitAction("Новая ветка…");
  const dialog = await screen.findByRole("dialog", { name: "Новая ветка" });
  expect((within(dialog).getByRole("checkbox", { name: "Переключиться на новую ветку" }) as HTMLInputElement).checked).toBe(true);
  fireEvent.click(within(dialog).getByRole("button", { name: "Отмена" }));
  expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "git_action")).toHaveLength(0);
  await headerGitAction("Переключить ветку…");
  fireEvent.click(await screen.findByRole("option", { name: "feature/new" }));
  await screen.findByRole("button", { name: "Git: feature/new" });
  expect(invoke).toHaveBeenCalledWith("git_action", { target: { workspaceId: "w1", repository: "" }, action: { kind: "switch", reference: "refs/heads/feature/new" } });
});

test("дерево восстанавливает раскрытые папки каждой ветки после переключения, обновления и перезапуска", async () => {
  const saved = fixture();
  saved.sessions = [];
  saved.workspaces[0].gitRef = "main";
  saved.workspaces[1].gitRef = "feature/new";
  vi.mocked(invoke).mockImplementation(async (command, args: any) => {
    const reference = saved.workspaces[0].gitRef;
    if (command === "snapshot") return structuredClone(saved);
    if (command === "save_view") { saved.view = args.view; return; }
    if (command === "list_directory") {
      if (args.path === "") return [{ path: "brief", name: "brief", directory: true }];
      if (args.path === "brief") return [{ path: "brief/rpc", name: "rpc", directory: true }];
      return [{ path: "brief/rpc/service.brief", name: "service.brief", directory: false }];
    }
    if (["list_file_drafts", "executor_availability", "git_stashes"].includes(command)) return [];
    if (command === "list_git_repositories") return [""];
    if (command === "git_status") return { reference, changes: [], remotes: [], upstream: null, ahead: 0, behind: 0, operation: null };
    if (command === "git_branches") return ["main", "feature/new"].map(name => ({ name, reference: `refs/heads/${name}`, kind: "local", current: reference === name, upstream: null }));
    if (command === "git_action" && args.action.kind === "switch") {
      saved.workspaces[0].gitRef = args.action.reference.replace(/^refs\/heads\//, "");
      return "Готово";
    }
    throw new Error(command);
  });
  const folder = (name: string) => screen.findByRole("button", { name: `${name}/` });
  const app = render(<App />);
  fireEvent.click(await folder("brief"));
  fireEvent.click(await folder("rpc"));
  await screen.findByRole("button", { name: "service.brief" });

  await headerGitAction("Переключить ветку…");
  fireEvent.click(await screen.findByRole("option", { name: "feature/new" }));
  await screen.findByRole("button", { name: "Git: feature/new" });
  fireEvent.click(screen.getByRole("button", { name: "Проект" }));
  expect((await folder("brief")).getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(await folder("brief"));
  fireEvent.click(screen.getByRole("button", { name: "Обновить дерево" }));
  expect((await folder("rpc")).getAttribute("aria-expanded")).toBe("false");

  saved.workspaces[0].gitRef = "main";
  fireEvent.click(screen.getByRole("button", { name: "Обновить дерево" }));
  await screen.findByRole("button", { name: "service.brief" });

  saved.workspaces[0].gitRef = "feature/new";
  fireEvent.focus(window);
  await screen.findByRole("button", { name: "Git: feature/new" });
  expect((await folder("rpc")).getAttribute("aria-expanded")).toBe("false");

  app.unmount();
  render(<App />);
  expect((await folder("brief")).getAttribute("aria-expanded")).toBe("true");
  expect((await folder("rpc")).getAttribute("aria-expanded")).toBe("false");
  chooseProject(/^Второй/);
  await waitFor(() => expect(screen.getByRole("button", { name: "Открыть список проектов" }).textContent).toBe("Второй"));
  expect((await folder("brief")).getAttribute("aria-expanded")).toBe("false");
});

test.each([
  [[], null, "Получить изменения", "Не настроен удалённый репозиторий."],
  [["origin"], null, "Обновить ветку", "Для текущей ветки не настроена отслеживаемая удалённая ветка."],
] as const)("сетевые действия из хедера объясняют отсутствие настроек: %s %s", async (remotes, upstream, action, message) => {
  mockHeaderGit([...remotes], upstream);
  render(<App />);
  await headerGitAction(action);
  await screen.findByText(message);
  expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "git_action")).toHaveLength(0);
});

test("отправка из хедера не наследует принудительную отправку в панели", async () => {
  mockHeaderGit();
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Изменения Git" }));
  fireEvent.click(await screen.findByRole("button", { name: "Действия Git" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Принудительная отправка" }));
  await headerGitAction("Отправить коммиты");
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("git_action", { target: { workspaceId: "w1", repository: "" }, action: { kind: "push", remote: null, force: false } }));
});

test.each(["", "nested"])("смена ветки обновляет пространство только для корневого репозитория: %s", async repository => {
  const saved = fixture();
  saved.sessions = [];
  saved.workspaces[0].gitRef = "main";
  let reference = "main";
  vi.mocked(invoke).mockImplementation(async (command, args: any) => {
    if (command === "snapshot") return structuredClone(saved);
    if (["list_directory", "list_file_drafts", "executor_availability", "git_stashes"].includes(command)) return [];
    if (command === "list_git_repositories") return [repository];
    if (command === "git_status") return { reference, changes: [], remotes: [], upstream: null, ahead: 0, behind: 0, operation: null };
    if (command === "git_branches") return ["main", "feature/new"].map(name => ({ name, reference: `refs/heads/${name}`, kind: "local", current: reference === name, upstream: null }));
    if (command === "git_action") { expect(args.target).toEqual({ workspaceId: "w1", repository }); reference = "feature/new"; return ""; }
    throw new Error(command);
  });
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Изменения Git" }));
  const branch = await screen.findByRole("combobox", { name: "Текущая ветка" });
  fireEvent.click(branch);
  fireEvent.click(screen.getByRole("option", { name: "feature/new" }));
  await waitFor(() => expect(branch.textContent).toBe("feature/new"));
  expect(within(screen.getByRole("banner")).getByTitle(repository ? "main" : "feature/new").textContent).toBe(repository ? "main" : "feature/new");
  fireEvent.click(screen.getByRole("button", { name: "Проект" }));
  const projects = openProjects();
  expect(projects.getByText(repository ? "main" : "feature/new", { selector: ".workspace-branch span" })).toBeTruthy();
});

test.each(["focus", "menu"])("ветки пространств перечитываются после внешнего переключения, сохраняя текущие вкладки: %s", async trigger => {
  const saved = fixture();
  saved.sessions[0].state = "completed";
  saved.workspaces[0].gitRef = "main";
  saved.workspaces[1].projectId = "p1";
  saved.workspaces[1].gitRef = "task";
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === "snapshot") return structuredClone(saved);
    if (["list_directory", "list_file_drafts", "executor_availability", "list_git_repositories"].includes(command)) return [];
    throw new Error(command);
  });
  const { container } = render(<App />);
  const spaces = await screen.findByRole("combobox", { name: "Пространство" });
  saved.workspaces[0].gitRef = "feature/external";
  saved.workspaces[1].gitRef = "fix/other";
  saved.view.workspaceId = "w2";
  if (trigger === "focus") {
    fireEvent.focus(window);
    await waitFor(() => expect(container.querySelector(".ide-status")?.textContent).toContain("feature/external"));
    fireEvent.click(spaces);
  } else fireEvent.keyDown(spaces, { key: "ArrowDown" });
  await screen.findByRole("option", { name: "Основное feature/external" });
  expect(screen.getByRole("banner").querySelector(".ide-branch")?.textContent).toBe("feature/external");
  expect(screen.getByRole("option", { name: "Другое fix/other" })).toBeTruthy();
  expect(spaces.textContent).toBe("Основное");
  expect(screen.getByRole("tab", { name: /^Исправление/ })).toBeTruthy();
});

test("обычная папка не предлагает создать Git worktree", async () => {
  const saved = fixture();
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === "snapshot") return structuredClone(saved);
    if (["list_directory", "list_file_drafts"].includes(command)) return [];
  });
  render(<App />);
  await screen.findByRole("heading", { name: "Первый" });
  expect((screen.getByRole("button", { name: "Создать пространство" }) as HTMLButtonElement).disabled).toBe(true);
  const projects = openProjects();
  expect(projects.queryByRole("button", { name: /Новое пространство/ })).toBeNull();
});

test("сохранённое архивное пространство скрыто в каталоге, его разговор остаётся в истории", async () => {
  const saved = fixture();
  saved.workspaces[0].archived = true;
  saved.sessions[0].state = "completed";
  saved.view.projectId = "p2";
  saved.view.workspaceId = "w2";
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === "snapshot") return structuredClone(saved);
    if (["list_directory", "list_file_drafts"].includes(command)) return [];
  });
  render(<App />);
  await screen.findByRole("heading", { name: "Второй" });
  const projects = openProjects();
  expect(projects.queryByRole("button", { name: "Основное" })).toBeNull();
  fireEvent.click(projects.getByRole("button", { name: "Закрыть Все проекты" }));
  fireEvent.click(screen.getByRole("button", { name: "История разговоров" }));
  expect(within(screen.getByRole("dialog", { name: "История разговоров" })).getByRole("button", { name: /Открыть историю «Исправление»/ })).toBeTruthy();
});

test("архивная общая папка не открывается из другого проекта", async () => {
  const saved = fixture();
  saved.groups[0].path = "/shared";
  const shared = { ...saved.workspaces[0], id: "shared", projectId: null, groupId: "g1", name: "Команда", path: "/shared", archived: true };
  saved.workspaces.push(shared);
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (["list_directory", "list_file_drafts"].includes(command)) return [];
    if (command === "snapshot") return structuredClone(saved);
    if (command === "open_group_folder") return structuredClone(shared);
    if (command === "save_view") { saved.view = structuredClone((args as { view: View }).view); return; }
    throw new Error(`неожиданная команда: ${command}`);
  });
  render(<App />);
  await screen.findByRole("heading", { name: "Первый" });
  chooseProject(/^Второй/);
  await screen.findByRole("heading", { name: "Второй" });
  chooseProject("Открыть общую папку Команда");
  expect((await screen.findByRole("alert")).textContent).toContain("Пространство в архиве");
  expect(saved.view.projectId).toBeNull();
  expect(saved.view.workspaceId).toBeNull();
});

test("одинаковые файлы двух пространств имеют отдельные вкладки и восстанавливают свой текст", async () => {
  const saved = fixture();
  const bodies: Record<string, string> = { w1: "первая копия", w2: "вторая копия" };
  const disks = { ...bodies };
  vi.mocked(invoke).mockImplementation(async (command, args: any) => {
    if (command === "snapshot") return structuredClone(saved);
    if (command === "save_view") { saved.view = structuredClone(args.view); return; }
    if (command === "list_directory") return [{ path: "file.ts", name: "file.ts", directory: false }];
    if (command === "list_file_drafts") return [];
    if (command === "open_file") return { path: args.path, body: bodies[args.workspaceId], base: disks[args.workspaceId], disk: disks[args.workspaceId] };
    if (command === "read_file_disk") return disks[args.workspaceId];
    if (command === "save_file_draft") { bodies[args.workspaceId] = args.body; return; }
    if (command === "save_file") {
      bodies[args.workspaceId] = disks[args.workspaceId] = args.document.body;
      return { ...args.document, base: args.document.body, disk: args.document.body };
    }
    throw new Error(`неожиданная команда: ${command}`);
  });
  const first = render(<App />);
  await screen.findByRole("heading", { name: "Первый" });
  fireEvent.click(await screen.findByRole("button", { name: "file.ts" }));
  const editor = await screen.findByRole("textbox", { name: "Код file.ts" });
  expect((editor as HTMLTextAreaElement).value).toBe("первая копия");
  fireEvent.change(editor, { target: { value: "черновик первой копии" } });
  await screen.findByRole("tab", { name: "file.ts · Несохранённые правки" });
  chooseProject(/^Второй/);
  await screen.findByRole("heading", { name: "Второй" });
  await waitFor(() => expect(disks.w1).toBe("черновик первой копии"));
  fireEvent.click(await screen.findByRole("button", { name: "file.ts" }));
  expect((await screen.findByRole("textbox", { name: "Код file.ts" }) as HTMLTextAreaElement).value).toBe("вторая копия");
  expect(saved.view.tabs.filter(t => t.id.startsWith("file:")).map(t => t.id)).toEqual(["file:w1:file.ts", "file:w2:file.ts"]);
  first.unmount();
  render(<App />);
  expect((await screen.findByRole("textbox", { name: "Код file.ts" }) as HTMLTextAreaElement).value).toBe("вторая копия");
  chooseProject(/^Первый/);
  await screen.findByRole("heading", { name: "Первый" });
  expect((await screen.findByRole("textbox", { name: "Код file.ts" }) as HTMLTextAreaElement).value).toBe("черновик первой копии");
  await screen.findByRole("tab", { name: "file.ts" });
  fireEvent.click(screen.getByRole("button", { name: "Закрыть вкладку file.ts" }));
  await waitFor(() => expect(saved.view.tabs.some(t => t.id === "file:w1:file.ts")).toBe(false));
  expect(bodies.w1).toBe("черновик первой копии");
  expect(saved.view.tabs.some(t => t.id === "file:w2:file.ts")).toBe(true);
});

test("закрытие файловой вкладки при ошибке сохранения черновика оставляет правки в редакторе", async () => {
  const saved = fixture();
  saved.view.tabs = [{ id: "file:w1:failed.ts", workspaceId: "w1", sessionId: null }];
  saved.view.activeTabs.w1 = "file:w1:failed.ts";
  vi.mocked(invoke).mockImplementation(async (command, args: any) => {
    if (command === "list_directory") return [];
    if (command === "list_file_drafts") return [];
    if (command === "snapshot") return structuredClone(saved);
    if (command === "save_view") { saved.view = structuredClone(args.view); return; }
    if (command === "open_file") return { path: "failed.ts", body: "исходник", base: "исходник", disk: "исходник" };
    if (command === "read_file_disk") return "исходник";
    if (command === "save_file_draft") throw new Error("база недоступна");
    throw new Error(`неожиданная команда: ${command}`);
  });
  render(<App />);
  fireEvent.change(await screen.findByRole("textbox", { name: "Код failed.ts" }), { target: { value: "сохранить правки" } });
  await screen.findByText(/Черновик не сохранён:.*база недоступна/);
  expect(screen.getByLabelText("Ошибка сохранения файла")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Закрыть вкладку failed.ts" }));
  await screen.findByText(/Вкладка оставлена открытой/);
  expect((screen.getByRole("textbox", { name: "Код failed.ts" }) as HTMLTextAreaElement).value).toBe("сохранить правки");
  expect(saved.view.tabs).toHaveLength(1);
});

test("черновик удалённого файла открывается из списка после закрытия вкладки и перезапуска", async () => {
  const saved = fixture();
  saved.sessions = [];
  saved.view.tabs = [{ id: "file:w1:deleted.ts", workspaceId: "w1", sessionId: null }];
  saved.view.activeTabs.w1 = "file:w1:deleted.ts";
  vi.mocked(invoke).mockImplementation(async (command, args: any) => {
    if (command === "snapshot") return structuredClone(saved);
    if (command === "save_view") { saved.view = structuredClone(args.view); return; }
    if (command === "list_directory") return [];
    if (command === "list_file_drafts") return ["deleted.ts"];
    if (command === "open_file") return { path: args.path, body: "ручные правки", base: "исходник", disk: null };
    if (command === "read_file_disk") return null;
    throw new Error(`неожиданная команда: ${command}`);
  });
  const first = render(<App />);
  await screen.findByRole("textbox", { name: "Код deleted.ts" });
  fireEvent.click(screen.getByRole("button", { name: "Закрыть вкладку deleted.ts" }));
  await waitFor(() => expect(saved.view.tabs).toHaveLength(0));
  fireEvent.click(await screen.findByRole("button", { name: "deleted.ts" }));
  expect((await screen.findByRole("textbox", { name: "Код deleted.ts" }) as HTMLTextAreaElement).value).toBe("ручные правки");
  await screen.findByText(/Конфликт: файл удалён снаружи/);
  fireEvent.click(screen.getByRole("button", { name: "Закрыть вкладку deleted.ts" }));
  await waitFor(() => expect(saved.view.tabs).toHaveLength(0));
  first.unmount();
  render(<App />);
  await screen.findByRole("heading", { name: "Выберите вкладку" });
  fireEvent.click(await screen.findByRole("button", { name: "deleted.ts" }));
  expect((await screen.findByRole("textbox", { name: "Код deleted.ts" }) as HTMLTextAreaElement).value).toBe("ручные правки");
  await screen.findByText(/Конфликт: файл удалён снаружи/);
  expect(invoke).toHaveBeenCalledWith("list_file_drafts", { workspaceId: "w1" });
});


test("общие вкладки переключают файл, разговор и терминал без потери состояния", async () => {
  const saved = fixture();
  saved.view.tabs.push({ id: "file:w1:main.ts", workspaceId: "w1", sessionId: null }, { id: "terminal:t1", workspaceId: "w1", sessionId: null });
  vi.mocked(invoke).mockImplementation(async (command, args: any) => {
    if (command === "snapshot") return structuredClone(saved);
    if (command === "save_view") { saved.view = structuredClone(args.view); return; }
    if (["list_directory", "list_file_drafts"].includes(command)) return [];
    if (command === "open_file") return { path: "main.ts", body: "исходник", base: "исходник", disk: "исходник" };
    if (command === "read_file_disk") return "исходник";
    if (command === "save_file_draft") return;
    throw new Error(command);
  });
  render(<App />);
  const conversation = await screen.findByRole("heading", { name: "Исправление" });
  const tabs = within(screen.getByRole("tablist", { name: "Вкладки пространства" }));
  expect(tabs.getByRole("tab", { name: /^Исправление/ })).toBeTruthy();
  expect(tabs.getByRole("tab", { name: "Терминал t1" })).toBeTruthy();
  expect(screen.queryByRole("tabpanel", { name: "Оболочка t1" })).toBeNull();
  fireEvent.click(tabs.getByRole("tab", { name: "main.ts" }));
  const editor = await screen.findByRole("textbox", { name: "Код main.ts" });
  expect(screen.queryByRole("button", { name: "Сравнение версий" })).toBeNull();
  expect(screen.queryByRole("heading", { name: "Исправление" })).toBeNull();
  expect(conversation.isConnected).toBe(true);
  fireEvent.change(editor, { target: { value: "ручная правка" } });
  fireEvent.click(tabs.getByRole("tab", { name: /^Исправление/ }));
  await screen.findByRole("heading", { name: "Исправление" });
  expect(screen.queryByRole("textbox", { name: "Код main.ts" })).toBeNull();
  expect(editor.isConnected).toBe(true);
  fireEvent.click(tabs.getByRole("tab", { name: "Терминал t1" }));
  const terminal = await screen.findByRole("tabpanel", { name: "Оболочка t1" });
  await waitFor(() => expect(saved.view.activeTabs.w1).toBe("terminal:t1"));
  expect(screen.queryByRole("heading", { name: "Исправление" })).toBeNull();
  expect(screen.queryByRole("textbox", { name: "Код main.ts" })).toBeNull();
  fireEvent.keyDown(screen.getByRole("tablist", { name: "Вкладки пространства" }), { key: "Home" });
  expect(await screen.findByRole("heading", { name: "Исправление" })).toBe(conversation);
  expect(screen.queryByRole("tabpanel", { name: "Оболочка t1" })).toBeNull();
  expect(terminal.isConnected).toBe(true);
  fireEvent.keyDown(window, { key: "F12", altKey: true });
  expect(await screen.findByRole("tabpanel", { name: "Оболочка t1" })).toBe(terminal);
  fireEvent.click(tabs.getByRole("tab", { name: /^main.ts/ }));
  expect(await screen.findByRole("textbox", { name: "Код main.ts" })).toBe(editor);
  expect((editor as HTMLTextAreaElement).value).toBe("ручная правка");
  fireEvent.click(screen.getByRole("button", { name: "Закрыть вкладку Терминал t1" }));
  await waitFor(() => expect(saved.view.tabs.some(tab => tab.id === "terminal:t1")).toBe(false));
  expect(screen.queryByRole("tab", { name: "Терминал t1" })).toBeNull();
  expect(vi.mocked(invoke).mock.calls.some(([command]) => command.startsWith("start_") || command.startsWith("stop_") || command.startsWith("interrupt_"))).toBe(false);
});

test.each(["project", "git", null])("состояние мониторинга и боковой панели %s сохраняется между запусками", async left => {
  const saved = fixture();
  saved.sessions = [];
  localStorage.setItem("yade.ide.layout", JSON.stringify({ left, selected: {} }));
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === "snapshot") return structuredClone(saved);
    if (["list_directory", "list_file_drafts", "list_git_repositories", "executor_availability"].includes(command)) return [];
    throw new Error(command);
  });
  const first = render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Обзор проектов" }));
  first.unmount();

  const second = render(<App />);
  const overview = await screen.findByRole("button", { name: "Обзор проектов" });
  expect(overview.getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByRole("complementary", { name: "Обзор проектов" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Проект" }).getAttribute("aria-pressed")).toBe(String(left === "project"));
  expect(screen.getByRole("button", { name: "Изменения Git" }).getAttribute("aria-pressed")).toBe(String(left === "git"));
  fireEvent.click(overview);
  second.unmount();

  render(<App />);
  expect((await screen.findByRole("button", { name: "Обзор проектов" })).getAttribute("aria-pressed")).toBe("false");
  expect(screen.queryByRole("complementary", { name: "Обзор проектов" })).toBeNull();
  expect(JSON.parse(localStorage.getItem("yade.ide.layout")!)).toMatchObject({ left, overviewOpen: false });
});

test("выбранная боковая панель восстанавливается со старым расположением терминала; повреждённое расположение заменяется штатным", async () => {
  const saved = fixture();
  saved.sessions = [];
  saved.view.tabs = [];
  saved.view.activeTabs = {};
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === "snapshot") return structuredClone(saved);
    if (["list_directory", "list_file_drafts"].includes(command)) return [];
    throw new Error(command);
  });
  localStorage.setItem("yade.ide.layout", JSON.stringify({ left: null, terminalOpen: true, terminalHeight: 260, selected: {} }));
  const first = render(<App />);
  await screen.findByRole("heading", { name: "Выберите вкладку" });
  expect(screen.queryByRole("complementary", { name: "Проекты" })).toBeNull();
  expect(screen.queryByRole("region", { name: "Нижняя панель", hidden: true })).toBeNull();
  first.unmount();
  const second = render(<App />);
  await screen.findByRole("heading", { name: "Выберите вкладку" });
  expect(screen.queryByRole("complementary", { name: "Проекты" })).toBeNull();
  second.unmount();
  localStorage.setItem("yade.ide.layout", JSON.stringify({ left: "invalid", rightWidth: -10 }));
  render(<App />);
  expect(await screen.findByRole("complementary", { name: "Проекты" })).toBeTruthy();
});


test("системный выбор папки заполняет путь и название, проект добавляется только по сохранению", async () => {
  vi.mocked(open).mockResolvedValue("/Users/test/Новый проект");
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === "snapshot") return fixture();
    if (["list_directory", "list_file_drafts"].includes(command)) return [];
    if (command === "register_folder") return;
    throw new Error(command);
  });
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Добавить" }));
  const dialog = await screen.findByRole("dialog", { name: "Добавить проект" });
  expect(screen.queryByText("Управление проектами")).toBeNull();
  expect(screen.queryByRole("button", { name: "Ввести путь вручную" })).toBeNull();
  expect(screen.queryByText("Новая группа")).toBeNull();
  expect(dialog.textContent).toContain("Папка не выбрана");
  expect((within(dialog).getByRole("button", { name: "Добавить" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(within(dialog).getByRole("button", { name: "Выбрать папку…" }));
  await within(dialog).findByText("Новый проект");
  expect(open).toHaveBeenCalledWith({ directory: true, multiple: false, title: "Выберите папку проекта", defaultPath: undefined });
  expect(dialog.textContent).toContain("/Users/test/Новый проект");
  expect(vi.mocked(invoke).mock.calls.some(([command]) => command === "register_folder")).toBe(false);
  fireEvent.click(within(dialog).getByRole("button", { name: "Добавить" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("register_folder", { name: "Новый проект", path: "/Users/test/Новый проект", groupId: null }));
});

test("отмена и ошибка выбора сохраняют папку, повторный выбор обновляет путь и название", async () => {
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === "snapshot") return fixture();
    if (["list_directory", "list_file_drafts"].includes(command)) return [];
    throw new Error(command);
  });
  vi.mocked(open).mockResolvedValueOnce("/Users/test/original").mockResolvedValueOnce(null)
    .mockRejectedValueOnce(new Error("окно недоступно")).mockResolvedValueOnce("/Users/test/other");
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Добавить" }));
  const choose = screen.getByRole("button", { name: "Выбрать папку…" });
  fireEvent.click(choose);
  await screen.findByText("/Users/test/original");
  fireEvent.click(choose);
  await waitFor(() => expect((choose as HTMLButtonElement).disabled).toBe(false));
  expect(screen.getByText("/Users/test/original")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  fireEvent.click(choose);
  expect((await screen.findByRole("alert")).textContent).toContain("окно недоступно");
  expect(screen.getByText("/Users/test/original")).toBeTruthy();
  fireEvent.click(choose);
  await screen.findByText("/Users/test/other");
  expect(screen.getByText("other", { selector: "strong" })).toBeTruthy();
  expect(open).toHaveBeenLastCalledWith({ directory: true, multiple: false, title: "Выберите папку проекта", defaultPath: "/Users/test/original" });
  expect(vi.mocked(invoke).mock.calls.some(([command]) => command === "register_folder")).toBe(false);
});

test("каталог ищет пространства и ветки, фильтрует активные проекты и сохраняет избранное", async () => {
  const saved = fixture();
  saved.workspaces[1].gitRef = "feature/design";
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === "snapshot") return structuredClone(saved);
    if (["list_directory", "list_file_drafts"].includes(command)) return [];
    throw new Error(command);
  });
  const first = render(<App />);
  await screen.findByRole("heading", { name: "Первый" });
  fireEvent.keyDown(window, { key: "k", metaKey: true });
  const search = await screen.findByRole("textbox", { name: "Найти проект или рабочее пространство" });
  await waitFor(() => expect(document.activeElement).toBe(search));
  fireEvent.change(search, { target: { value: "FEATURE/DESIGN" } });
  expect(screen.queryByRole("button", { name: /^Первый/ })).toBeNull();
  expect(screen.getByRole("button", { name: /^Второй/ })).toBeTruthy();
  fireEvent.change(search, { target: { value: "Основное" } });
  expect(screen.getByRole("button", { name: /^Первый/ })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /^Второй/ })).toBeNull();
  fireEvent.change(search, { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: /^Активные/ }));
  expect(screen.queryByRole("button", { name: /^Второй/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /^Все\d/ }));
  fireEvent.click(screen.getByRole("button", { name: "Избранное: Второй" }));
  fireEvent.click(screen.getByRole("button", { name: /^Избранные/ }));
  expect(screen.queryByRole("button", { name: /^Первый/ })).toBeNull();
  expect(screen.getByRole("button", { name: /^Второй/ })).toBeTruthy();
  first.unmount();
  render(<App />);
  await screen.findByRole("heading", { name: "Первый" });
  openProjects();
  expect((await screen.findByRole("button", { name: "Избранное: Второй" })).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Пространства: Первый" }));
  expect(screen.queryByRole("button", { name: "Основное" })).toBeNull();
});

test.each([true, false])("флажок открытия нового проекта: %s", async openAfter => {
  const saved = fixture();
  vi.mocked(open).mockResolvedValue("/new-project");
  vi.mocked(invoke).mockImplementation(async (command, args: any) => {
    if (command === "snapshot") return structuredClone(saved);
    if (["list_directory", "list_file_drafts"].includes(command)) return [];
    if (command === "save_view") { saved.view = structuredClone(args.view); return; }
    if (command === "register_folder") {
      saved.projects.push({ ...saved.projects[0], id: "p3", name: "new-project", path: "/new-project" });
      saved.workspaces.push({ ...saved.workspaces[0], id: "w3", projectId: "p3", path: "/new-project" });
      return;
    }
    throw new Error(command);
  });
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Добавить" }));
  const dialog = within(screen.getByRole("dialog", { name: "Добавить проект" }));
  fireEvent.click(dialog.getByRole("button", { name: "Выбрать папку…" }));
  await dialog.findByText("new-project");
  if (!openAfter) fireEvent.click(dialog.getByRole("checkbox", { name: "Открыть после добавления" }));
  fireEvent.click(dialog.getByRole("button", { name: "Добавить" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Добавить проект" })).toBeNull());
  expect(saved.view.projectId).toBe(openAfter ? "p3" : "p1");
  expect(saved.view.workspaceId).toBe(openAfter ? "w3" : "w1");
  expect(saved.view.tabs.some(tab => tab.id === "session:s1")).toBe(true);
});
