// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import Conversation, { ConversationControls } from "./Conversations";
import App from "./App";
import type { ConversationData, RunEvent, Snapshot, View, Workspace } from "./types";
import { defaults } from "./ExecutorSettings";

HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };

const listeners = vi.hoisted(() => ({ events: new Set<(event: { payload: RunEvent }) => void>(), drop: null as ((event: any) => void) | null }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("./Lifecycle", () => ({ default: () => null }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (_name, callback) => {
  listeners.events.add(callback); return () => listeners.events.delete(callback);
}) }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async (callback: any) => {
  listeners.drop = callback; return () => { listeners.drop = null; };
} }) }));
vi.mock("./Terminal", () => ({ TerminalControls: () => null, TerminalPanel: () => null, terminalTitle: (id: string) => id }));
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.unstubAllGlobals(); listeners.events.clear(); listeners.drop = null; localStorage.clear(); });

const workspace: Workspace = { id: "w", projectId: "p", groupId: null, name: "Основное", path: "/project", kind: "folder", archived: false, deleted: false,
  sourceRef: null, sourceCommit: null, gitRef: null, operationState: "ready", operationError: null, preparationCommand: null, preparationState: "skipped", preparationOutput: "" };
const quiet = async () => {};
const availability = ["codex", "claude"].map(executor => ({ executor, state: "ready", path: `/bin/${executor}`, version: "проверена", reason: "Вход найден", action: "" }));
function conversation(id = "a", executor = "codex"): ConversationData {
  return { session: { id, executor, workspaceId: "w", title: `Разговор ${id}`, state: "ready", externalId: null },
    context: { workspaceId: "w", sessionId: id, runId: `run-${id}` }, canStop: false, messages: [], messageEvents: {}, events: [], requests: [], olderMessages: false, olderEvents: false, draft: "" };
}
function request(data: ConversationData, method: string, params: Record<string, unknown> = {}) {
  data.session.state = "waiting";
  data.requests = [{ sequence: 1, context: data.context!, kind: "request", payload: { requestId: "same", method, params } }];
}
function mockRead(data: ConversationData[], other?: (command: string, args: any) => unknown) {
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "read_conversation") return structuredClone(data.find(d => d.session.id === (args as any).sessionId));
    if (command === "save_conversation_draft") return;
    if (command === "load_executor_settings") return defaults;
    if (command === "inspect_executor_settings") return { models: [], workModes: [{ value: "plan", label: "План" }], approvalPolicies: [], sandboxes: [], permissionModes: [], warnings: [] };
    if (other) return other(command, args);
    throw new Error(`неожиданная команда: ${command}`);
  });
}
function panel(data: ConversationData, w = workspace) {
  return <Conversation session={data.session} workspace={w} changed={quiet} deleted={quiet} />;
}

test("переход к сообщению ждёт загрузки разговора и не перехватывает фокус при обновлениях", async () => {
  const data = conversation(); mockRead([data]);
  render(<><input aria-label="Другой ввод" /><Conversation focused session={data.session} workspace={workspace} changed={quiet} deleted={quiet} /></>);
  const input = await screen.findByRole("textbox", { name: "Сообщение" });
  await waitFor(() => expect(document.activeElement).toBe(input));
  const other = screen.getByRole("textbox", { name: "Другой ввод" });
  act(() => other.focus());
  const reads = vi.mocked(invoke).mock.calls.filter(([command]) => command === "read_conversation").length;
  data.session.title = "Обновлённое название";
  act(() => { for (const listener of listeners.events) listener({ payload: { sequence: 1, context: data.context!, kind: "session_title", payload: {} } }); });
  await screen.findByText("Обновлённое название");
  await waitFor(() => expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "read_conversation").length).toBeGreaterThan(reads));
  expect(document.activeElement).toBe(other);
});

function scrollingBody() {
  const element = screen.getByRole("tabpanel").querySelector<HTMLDivElement>(".conversation-body")!;
  let height = 1000, top = 0;
  Object.defineProperties(element, {
    clientHeight: { configurable: true, value: 200 },
    scrollHeight: { configurable: true, get: () => height },
    scrollTop: { configurable: true, get: () => top, set: (value: number) => { top = Math.max(0, Math.min(value, height - 200)); } },
  });
  return { element, grow: (value: number) => { height = value; } };
}

test("отправка сообщения ждёт сохранения параметров текущего разговора", async () => {
  const data = conversation(); data.draft = "Проверить проект";
  let finish: () => void;
  mockRead([data], async command => {
    if (command === "save_executor_settings") return new Promise<void>(resolve => { finish = resolve; });
    if (command === "prepare_conversation_input") return [{ type: "text", text: data.draft }];
    if (command === "start_codex_turn") return data.context;
    throw new Error(command);
  });
  render(panel(data));
  fireEvent.click(await screen.findByRole("button", { name: "Параметры диалога" }));
  await screen.findByLabelText("Модель");
  await waitFor(() => expect((screen.getByLabelText("Модель") as HTMLSelectElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "План" }));
  expect((screen.getByRole("button", { name: "Отправить сообщение" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.keyDown(screen.getByLabelText("Сообщение"), { key: "Enter" });
  expect(vi.mocked(invoke).mock.calls.some(([command]) => command === "start_codex_turn")).toBe(false);
  await act(async () => finish());
  fireEvent.click(screen.getByRole("button", { name: "Отправить сообщение" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("start_codex_turn", expect.objectContaining({ sessionId: data.session.id })));
});

test("шаг Codex обновляется на месте между сообщениями и сохраняет вывод без повторов", async () => {
  const data = conversation(); data.session.state = "running";
  data.messages = [
    { sequence: 100, sessionId: "a", runId: "run-a", role: "user", body: "Какие файлы в проекте?" },
    { sequence: 101, sessionId: "a", runId: "run-a", role: "assistant", body: "Посмотрю структуру." },
  ];
  data.messageEvents = { 100: 10, 101: 12 };
  data.events = [
    { sequence: 13, context: data.context!, kind: "action_started", payload: { id: "cmd", type: "commandExecution", command: "ls -a", status: "inProgress" } },
    { sequence: 14, context: data.context!, kind: "action_output", payload: { method: "item/commandExecution/outputDelta", params: { itemId: "cmd", delta: "README.md\n" } } },
  ];
  mockRead([data]); render(panel(data));
  const step = await screen.findByLabelText("Команда: Выполняется");
  expect(step.textContent).toContain("ls -a");
  expect(step.textContent).not.toContain("README.md");
  fireEvent.click(within(step).getByRole("button", { name: "Развернуть полный вывод" }));
  expect(step.textContent).toContain("README.md");
  data.events.push({ sequence: 15, context: data.context!, kind: "action_completed", payload: { id: "cmd", type: "commandExecution", aggregatedOutput: "README.md\n", exitCode: 0, status: "completed" } });
  data.messages.push({ sequence: 102, sessionId: "a", runId: "run-a", role: "assistant", body: "В проекте есть README.md." });
  data.messageEvents[102] = 17; data.session.state = "completed";
  await screen.findByLabelText("Команда: Завершено");
  expect(screen.getAllByText("README.md", { exact: true })).toHaveLength(1);
  expect([...screen.getByLabelText("Сообщения разговора").children].map(node => node.textContent)).toEqual([
    "ВыКакие файлы в проекте?", "CodexПосмотрю структуру.", "✓КомандаЗавершеноls -aREADME.md\n", "CodexВ проекте есть README.md.",
  ]);
  expect(screen.queryByText("Действия и события")).toBeNull();
});

test("Claude Code показывает текстовые шаги и результат инструмента без служебных блоков", async () => {
  const data = conversation("a", "claude"); data.session.state = "completed";
  data.events = [
    { sequence: 1, context: data.context!, kind: "action_output", payload: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "Проверю " } } },
    { sequence: 2, context: data.context!, kind: "action_output", payload: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "файл." } } },
    { sequence: 3, context: data.context!, kind: "action_output", payload: { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "скрытая подпись" } } },
    { sequence: 4, context: data.context!, kind: "action_output", payload: { type: "content_block_stop", index: 0 } },
    { sequence: 5, context: data.context!, kind: "action_started", payload: { type: "tool_use", id: "tool", name: "Read", input: {} } },
    { sequence: 6, context: data.context!, kind: "action_output", payload: { type: "tool_use", id: "tool", name: "Read", input: { file_path: "README.md" } } },
    { sequence: 7, context: data.context!, kind: "action_completed", payload: { type: "tool_result", tool_use_id: "tool", content: [{ type: "text", text: "Файл не найден" }], is_error: true } },
  ];
  mockRead([data]); render(panel(data));
  const step = await screen.findByLabelText("Read: Ошибка");
  fireEvent.click(within(step).getByRole("button", { name: "Развернуть полный вывод" }));
  expect(step.textContent).toContain("README.mdФайл не найден");
  expect(screen.getByLabelText("Размышление: Завершено").textContent).toContain("Проверю файл.");
  expect(screen.queryByText(/скрытая подпись|content_block_stop|tool_result/)).toBeNull();
});

test("планы, файлы и MCP выводятся как шаги, одинаковые идентификаторы разных запусков независимы", async () => {
  const data = conversation(); data.session.state = "completed";
  const old = { ...data.context!, runId: "old" };
  data.events = [
    { sequence: 1, context: old, kind: "action_started", payload: { id: "cmd", type: "commandExecution", command: "sleep 100" } },
    { sequence: 2, context: data.context!, kind: "action_completed", payload: { id: "cmd", type: "commandExecution", command: "false", exitCode: 1 } },
    { sequence: 3, context: data.context!, kind: "action_output", payload: { method: "turn/plan/updated", params: { turnId: "t", plan: [{ step: "Проверить", status: "inProgress" }] } } },
    { sequence: 4, context: data.context!, kind: "action_output", payload: { method: "turn/plan/updated", params: { turnId: "t", plan: [{ step: "Проверить", status: "completed" }] } } },
    { sequence: 5, context: data.context!, kind: "action_completed", payload: { id: "file", type: "fileChange", status: "completed", changes: [{ path: "main.ts", diff: "+const ready = true;" }] } },
    { sequence: 6, context: data.context!, kind: "action_completed", payload: { id: "mcp", type: "mcpToolCall", server: "docs", tool: "search", arguments: { query: "test" }, result: { content: [{ type: "text", text: "Найден документ" }] } } },
  ];
  mockRead([data]); render(panel(data));
  await screen.findByLabelText("Команда: Ошибка");
  expect(screen.getByLabelText("Команда: Прервано").textContent).toContain("sleep 100");
  expect(screen.getAllByLabelText("План: Завершено")).toHaveLength(1);
  for (const label of ["Изменение файлов: Завершено", "docs · search: Завершено"]) {
    fireEvent.click(within(screen.getByLabelText(label)).getByRole("button", { name: "Развернуть полный вывод" }));
  }
  expect(screen.getByLabelText("Изменение файлов: Завершено").textContent).toContain("main.ts\n+const ready = true;");
  expect(screen.getByLabelText("docs · search: Завершено").textContent).toContain("Найден документ");
});

test("история дочитывает шаги со старых страниц событий в пределах страницы сообщений", async () => {
  const data = conversation();
  data.messages = [{ sequence: 100, sessionId: "a", runId: "run-a", role: "assistant", body: "Старая страница" }];
  data.messageEvents = { 100: 10, 101: 200 }; data.olderEvents = true;
  const event = (sequence: number, command: string) => ({ sequence, context: data.context!, kind: "action_completed", payload: { id: command, type: "commandExecution", command } });
  data.events = [event(150, "последняя команда страницы"), event(210, "команда следующей страницы")];
  vi.mocked(invoke).mockImplementation(async (command, args: any) => {
    if (command === "load_executor_settings") return defaults;
    if (command === "inspect_executor_settings") return { models: [], workModes: [], approvalPolicies: [], sandboxes: [], permissionModes: [], warnings: [] };
    if (args.beforeMessage === null) return { ...data, olderMessages: true, messages: [{ ...data.messages[0], sequence: 101, body: "Последние сообщения" }], messageEvents: { 101: 200 }, events: [event(210, "команда следующей страницы")], olderEvents: false };
    if (args.beforeEvent === 150) return { ...data, olderEvents: false, events: [event(5, "команда предыдущей страницы"), event(15, "первая команда страницы")] };
    return structuredClone(data);
  });
  const view = render(panel(data));
  await screen.findByText("Последние сообщения");
  fireEvent.click(screen.getByRole("button", { name: "Предыдущие сообщения" }));
  await screen.findByText("первая команда страницы");
  expect(screen.getByText("последняя команда страницы")).toBeTruthy();
  expect(screen.queryByText("команда предыдущей страницы")).toBeNull();
  expect(screen.queryByText("команда следующей страницы")).toBeNull();
  expect(invoke).toHaveBeenCalledWith("read_conversation", { sessionId: "a", beforeMessage: 101, beforeEvent: 150 });
  view.unmount();
});

test.each(["codex", "claude"].flatMap(executor => ["enter", "blur"].map(save => [executor, save])))("название %s редактируется на месте и сохраняется по %s", async (executor, save) => {
  const data = conversation("rename", executor); data.session.state = "running";
  const changed = vi.fn(quiet);
  mockRead([data], (command, args) => {
    if (command === "rename_conversation") { data.session.title = args.title; return; }
    throw new Error(command);
  });
  render(<Conversation session={data.session} workspace={workspace} changed={changed} deleted={quiet} />);
  await screen.findByLabelText("Сообщение");
  fireEvent.click(screen.getByRole("button", { name: data.session.title }));
  const input = screen.getByRole("textbox", { name: "Название разговора" }) as HTMLInputElement;
  expect(document.activeElement).toBe(input);
  expect(input.selectionEnd).toBe(data.session.title.length);
  fireEvent.change(input, { target: { value: "  Моё название  " } });
  if (save === "enter") fireEvent.keyDown(input, { key: "Enter" });
  else act(() => screen.getByRole("textbox", { name: "Сообщение" }).focus());
  const renamed = await screen.findByRole("button", { name: "Моё название" });
  expect(invoke).toHaveBeenCalledWith("rename_conversation", { sessionId: "rename", title: "Моё название" });
  expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "rename_conversation")).toHaveLength(1);
  expect(changed).toHaveBeenCalledOnce();
  expect(document.activeElement).toBe(save === "enter" ? renamed : screen.getByRole("textbox", { name: "Сообщение" }));
  expect(screen.getByRole("button", { name: "Прервать ответ" })).toBeTruthy();
});

test.each(["escape", "empty", "unchanged"])("отмена и пустое или прежнее название не меняют разговор: %s", async mode => {
  const data = conversation(); mockRead([data]); render(panel(data));
  await screen.findByLabelText("Сообщение");
  fireEvent.click(screen.getByRole("button", { name: data.session.title }));
  const input = screen.getByRole("textbox", { name: "Название разговора" });
  if (mode !== "unchanged") fireEvent.change(input, { target: { value: mode === "empty" ? "  " : "Отменённое название" } });
  if (mode === "escape") fireEvent.keyDown(input, { key: "Escape" });
  else act(() => screen.getByRole("textbox", { name: "Сообщение" }).focus());
  expect(screen.queryByRole("textbox", { name: "Название разговора" })).toBeNull();
  expect(screen.getByRole("heading", { name: data.session.title })).toBeTruthy();
  expect(document.activeElement).toBe(mode === "escape" ? screen.getByRole("button", { name: data.session.title }) : screen.getByRole("textbox", { name: "Сообщение" }));
  expect(vi.mocked(invoke).mock.calls.some(([command]) => command === "rename_conversation")).toBe(false);
});

test("ошибка переименования сохраняет введённое название для повторной попытки", async () => {
  const data = conversation(); let failed = false;
  mockRead([data], (command, args) => {
    if (command === "rename_conversation") {
      if (!failed) { failed = true; throw new Error("Диск недоступен"); }
      data.session.title = args.title; return;
    }
    throw new Error(command);
  });
  render(panel(data)); await screen.findByLabelText("Сообщение");
  fireEvent.click(screen.getByRole("button", { name: data.session.title }));
  const input = screen.getByRole("textbox", { name: "Название разговора" }) as HTMLInputElement;
  fireEvent.change(input, { target: { value: "Моё название" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect((await screen.findByRole("alert")).textContent).toContain("Название не сохранено");
  expect(input.value).toBe("Моё название");
  await waitFor(() => expect(input.disabled).toBe(false));
  act(() => input.focus());
  fireEvent.keyDown(input, { key: "Enter" });
  await screen.findByRole("heading", { name: "Моё название" });
  expect(screen.queryByRole("alert")).toBeNull();
});

test("заголовок получает штатное название из обновлённой истории без повторного открытия", async () => {
  const data = conversation(); data.session.title = "Новый чат"; data.session.state = "running";
  mockRead([data]);
  render(panel(data));
  await screen.findByRole("button", { name: "Прервать ответ" });
  data.session.title = "Восстановление вкладок"; data.session.state = "completed";
  await screen.findByRole("heading", { name: "Восстановление вкладок" });
  expect(screen.getByRole("tabpanel", { name: "Разговор Восстановление вкладок" })).toBeTruthy();
});

test("название обновляется по фоновому событию после завершения ответа", async () => {
  const data = conversation(); data.session.title = "Новый чат"; data.session.state = "completed";
  const changed = vi.fn(quiet);
  mockRead([data]);
  render(<Conversation session={data.session} workspace={workspace} changed={changed} deleted={quiet} />);
  await screen.findByRole("heading", { name: "Новый чат" });
  const event: RunEvent = { sequence: 10, context: data.context!, kind: "session_title", payload: { title: "Восстановление вкладок" } };
  await act(async () => { for (const listener of listeners.events) listener({ payload: { ...event, context: { ...data.context!, sessionId: "other" } } }); });
  expect(changed).not.toHaveBeenCalled();
  data.session.title = "Восстановление вкладок";
  await act(async () => { for (const listener of listeners.events) listener({ payload: event }); });
  await screen.findByRole("heading", { name: "Восстановление вкладок" });
  expect(changed).not.toHaveBeenCalled();
});

test("поток виден до завершения, ошибка сохраняет текст, закрытие и повторное открытие не запускают команды", async () => {
  const data = conversation(); data.session.state = "running";
  data.messages = [{ sequence: 1, sessionId: "a", runId: "run-a", role: "assistant", body: "Частичный ответ" }];
  mockRead([data]);
  const first = render(panel(data));
  await screen.findByText("Частичный ответ");
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.getByRole("heading", { name: data.session.title }).closest("header")?.querySelector(".ide-space-dot")).toBeNull();
  expect(screen.getByRole("button", { name: "Прервать ответ" })).toBeTruthy();
  data.session.state = "error";
  data.events = [{ sequence: 2, context: data.context!, kind: "state", payload: { state: "error", detail: { message: "Соединение потеряно" } } }];
  await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Соединение потеряно"));
  first.unmount();
  render(panel(data));
  await screen.findByText("Частичный ответ");
  expect(vi.mocked(invoke).mock.calls.every(([command]) => ["read_conversation", "load_executor_settings", "inspect_executor_settings"].includes(command))).toBe(true);
});

test("страницы истории заменяются порциями и возвращаются к последним сообщениям без запуска сессии", async () => {
  const data = conversation(); data.olderMessages = true;
  data.messages = Array.from({ length: 100 }, (_, i) => ({ sequence: i + 101, sessionId: "a", runId: "run-a", role: "assistant", body: `Текст ${i + 101}` }));
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "load_executor_settings") return defaults;
    if (command === "inspect_executor_settings") return { models: [], workModes: [], approvalPolicies: [], sandboxes: [], permissionModes: [], warnings: [] };
    if ((args as any).beforeMessage === 101) return { ...data, olderMessages: false, messages: [{ ...data.messages[0], sequence: 100, body: "Старая страница" }] };
    return structuredClone(data);
  });
  render(panel(data));
  const { element } = scrollingBody();
  await screen.findByText("Текст 200");
  expect(element.scrollTop).toBe(800);
  element.scrollTop = 200; fireEvent.scroll(element);
  expect(within(screen.getByLabelText("Сообщения разговора")).getAllByRole("article")).toHaveLength(100);
  fireEvent.click(screen.getByRole("button", { name: "Предыдущие сообщения" }));
  await screen.findByText("Старая страница");
  expect(element.scrollTop).toBe(200);
  expect(screen.queryByText("Текст 200")).toBeNull();
  expect(invoke).toHaveBeenCalledWith("read_conversation", { sessionId: "a", beforeMessage: 101, beforeEvent: null });
  fireEvent.click(screen.getByRole("button", { name: "К последним сообщениям" }));
  await screen.findByText("Текст 200");
  expect(element.scrollTop).toBe(800);
});

test.each(["codex", "claude"])("диалог %s следует за ответом только до ручной прокрутки вверх и после возврата вниз", async executor => {
  const data = conversation("scroll", executor); data.session.state = "running";
  data.messages = [{ sequence: 1, sessionId: data.session.id, runId: data.context!.runId, role: "assistant", body: "Начало ответа" }];
  mockRead([data]);
  render(panel(data));
  const { element, grow } = scrollingBody();
  await screen.findByText("Начало ответа");
  expect(element.scrollTop).toBe(800);

  grow(1200); data.messages[0].body = "Продолжение ответа";
  await screen.findByText("Продолжение ответа");
  expect(element.scrollTop).toBe(1000);

  element.scrollTop = 400; fireEvent.scroll(element);
  grow(1400); data.messages[0].body = "Ответ растёт, читаем историю";
  await screen.findByText("Ответ растёт, читаем историю");
  expect(element.scrollTop).toBe(400);

  element.scrollTop = element.scrollHeight - element.clientHeight; fireEvent.scroll(element);
  grow(1600); data.messages[0].body = "Вернулись к последнему ответу";
  await screen.findByText("Вернулись к последнему ответу");
  expect(element.scrollTop).toBe(1400);
});

test("изменение размеров сообщений и окна сохраняет прокрутку только при нахождении внизу", async () => {
  let resize: () => void;
  const disconnect = vi.fn();
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { resize = callback; }
    observe = vi.fn();
    disconnect = disconnect;
  });
  const data = conversation();
  data.messages = [{ sequence: 1, sessionId: "a", runId: "run-a", role: "assistant", body: "Ответ с изменяемой высотой" }];
  mockRead([data]);
  const view = render(panel(data));
  const { element, grow } = scrollingBody();
  await screen.findByText("Ответ с изменяемой высотой");
  grow(1200); act(() => resize());
  expect(element.scrollTop).toBe(1000);
  element.scrollTop = 300; fireEvent.scroll(element);
  grow(1400); act(() => resize());
  expect(element.scrollTop).toBe(300);
  view.unmount();
  expect(disconnect).toHaveBeenCalledOnce();
});

test("два ожидающих исполнителя получают решение только своего запроса", async () => {
  const a = conversation(); const b = conversation("b", "claude");
  request(a, "item/commandExecution/requestApproval", { command: "pwd", cwd: "/project" });
  request(b, "permission", { tool: "Bash", input: { command: "true" } });
  mockRead([a, b], (command, args) => {
    if (command.startsWith("reply_")) { (args.context.sessionId === "a" ? a : b).requests = []; return; }
    throw new Error(command);
  });
  render(<>{panel(a)}{panel(b)}</>);
  const first = within(await screen.findByRole("tabpanel", { name: "Разговор Разговор a" }));
  const second = within(screen.getByRole("tabpanel", { name: "Разговор Разговор b" }));
  await first.findByText("pwd"); await second.findByText("Bash");
  fireEvent.click(first.getByRole("button", { name: "Разрешить один раз" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("reply_codex_request", { context: a.context, requestId: "same", result: { decision: "accept" } }));
  expect(second.getByRole("button", { name: "Разрешить один раз" })).toBeTruthy();
  expect(vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd.startsWith("reply_"))).toHaveLength(1);
  fireEvent.click(second.getByRole("button", { name: "Отклонить запрос" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("reply_claude_request", { context: b.context, requestId: "same", result: { behavior: "deny" } }));
});

test.each(["codex", "claude"])("вопросы %s сохраняют исходные ключи и пользовательский ответ", async executor => {
  const data = conversation("a", executor);
  const q = { id: "q", question: "Как продолжить?", options: [{ label: "Проверить", description: "Проверка файлов" }] };
  request(data, executor === "claude" ? "question" : "item/tool/requestUserInput", executor === "claude" ? { input: { questions: [q] } } : { questions: [q] });
  mockRead([data], command => { if (!command.startsWith("reply_")) throw new Error(command); });
  render(panel(data));
  fireEvent.change(await screen.findByLabelText("Свой ответ: Как продолжить?"), { target: { value: "Проверить оба проекта" } });
  fireEvent.click(screen.getByRole("button", { name: "Отправить ответ" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith(`reply_${executor}_request`, { context: data.context, requestId: "same",
    result: executor === "claude" ? { behavior: "allow", answers: { "Как продолжить?": "Проверить оба проекта" } } : { answers: { q: { answers: ["Проверить оба проекта"] } } },
  }));
});

test("асинхронные вопросы Codex показывают форму после завершения и отправляют ответ следующим сообщением", async () => {
  const data = conversation(); data.session.state = "completed";
  data.draft = JSON.stringify({ text: "Мой черновик", paths: ["/project/notes.txt"] });
  data.messages = [{ sequence: 1, sessionId: "a", runId: "run-a", role: "assistant", body: "Что хочешь сделать дальше?" }];
  data.messageEvents = { 1: 1 };
  data.events = [{ sequence: 1, context: data.context!, kind: "message_completed", payload: { sequence: 1, itemId: "question-1",
    questions: [{ title: "Что хочешь сделать дальше?", options: null }, { title: "Как проверить?", options: ["Тесты", "Вручную"] }],
  } }];
  const input = [{ type: "text", text: "Что хочешь сделать дальше?\nИсправить ошибку\n\nКак проверить?\nТесты" }];
  mockRead([data], (command, args) => {
    if (command === "start_codex_turn") {
      data.messages.push({ sequence: 2, sessionId: "a", runId: "next-run", role: "user", body: args.input[0].text });
      data.messageEvents[2] = 2;
      return { ...data.context, runId: "next-run" };
    }
    throw new Error(command);
  });
  const view = render(panel(data));
  await screen.findByLabelText("Свой ответ: Что хочешь сделать дальше?");
  view.unmount();
  render(panel(data));
  fireEvent.change(await screen.findByLabelText("Свой ответ: Что хочешь сделать дальше?"), { target: { value: "Исправить ошибку" } });
  expect((screen.getByRole("button", { name: "Отправить ответ" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByLabelText("Тесты"));
  fireEvent.click(screen.getByRole("button", { name: "Отправить ответ" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("start_codex_turn", { workspaceId: "w", sessionId: "a", input, draft: null }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Отправить ответ" })).toBeNull());
  expect((screen.getByLabelText("Сообщение") as HTMLTextAreaElement).value).toBe("Мой черновик");
  expect(vi.mocked(invoke).mock.calls.some(([command]) => command === "reply_codex_request")).toBe(false);
});

test("ответ на асинхронный вопрос ждёт завершения, а при ошибке сохраняет введённый текст", async () => {
  const data = conversation(); data.session.state = "running"; data.canStop = true;
  data.messages = [{ sequence: 1, sessionId: "a", runId: "run-a", role: "assistant", body: "Что дальше?" }];
  data.messageEvents = { 1: 1 };
  data.events = [{ sequence: 1, context: data.context!, kind: "message_completed", payload: { sequence: 1,
    questions: [{ title: "Что дальше?", options: null }],
  } }];
  mockRead([data], command => { throw new Error(command === "start_codex_turn" ? "не удалось запустить" : command); });
  render(panel(data));
  const answer = await screen.findByLabelText("Свой ответ: Что дальше?") as HTMLInputElement;
  fireEvent.change(answer, { target: { value: "Проверить проект" } });
  const submit = screen.getByRole("button", { name: "Отправить ответ" }) as HTMLButtonElement;
  expect(submit.disabled).toBe(true);
  expect(screen.getByText("Ответ можно отправить после завершения текущего выполнения.")).toBeTruthy();
  fireEvent.submit(submit.closest("form")!);
  expect(vi.mocked(invoke).mock.calls.some(([command]) => command === "start_codex_turn")).toBe(false);
  data.session.state = "completed"; data.canStop = false;
  await waitFor(() => expect(submit.disabled).toBe(false));
  fireEvent.click(submit);
  await screen.findByText("Ответ не принят: Error: не удалось запустить");
  expect(answer.value).toBe("Проверить проект");
  expect(submit.disabled).toBe(false);
});

test("устаревший запрос показывает причину и не применяется к новому запуску", async () => {
  const data = conversation(); request(data, "item/fileChange/requestApproval", { changes: ["file.txt"] });
  mockRead([data], command => {
    if (command === "reply_codex_request") { data.requests = []; data.context = { ...data.context!, runId: "new" }; throw new Error("запрос больше не актуален"); }
    throw new Error(command);
  });
  render(panel(data));
  fireEvent.click(await screen.findByRole("button", { name: "Разрешить один раз" }));
  await waitFor(() => expect(screen.getAllByRole("alert").some(p => p.textContent?.includes("запрос больше не актуален"))).toBe(true));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Разрешить один раз" })).toBeNull());
  expect(vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === "reply_codex_request")).toHaveLength(1);
});

test("MCP получает типизированный ответ по своей схеме", async () => {
  const data = conversation("a", "claude");
  request(data, "elicitation", { request: { serverName: "Каталог", message: "Укажите параметры", requestedSchema: {
    type: "object", required: ["name", "count"], properties: { name: { type: "string", title: "Название" }, count: { type: "integer", title: "Количество" }, enabled: { type: "boolean", title: "Включить" } },
  } } });
  mockRead([data], command => { if (command !== "reply_claude_request") throw new Error(command); });
  render(panel(data));
  fireEvent.change(await screen.findByLabelText("Название"), { target: { value: "Проект" } });
  fireEvent.change(screen.getByLabelText("Количество"), { target: { value: "2" } });
  fireEvent.click(screen.getByRole("combobox", { name: "Включить" }));
  fireEvent.click(screen.getByRole("option", { name: "Нет" }));
  fireEvent.click(screen.getByRole("button", { name: "Отправить ответ" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("reply_claude_request", { context: data.context, requestId: "same", result: { action: "accept", content: { name: "Проект", count: 2, enabled: false } } }));
});

test("команда с вложениями отправляется явно, а черновик очищается после сохранения сообщения", async () => {
  const data = conversation("a", "claude"); data.session.externalId = "native";
  data.draft = JSON.stringify({ text: "/compatibility-probe", paths: ["/project/fixture.txt"] });
  const input = [{ type: "image", source: { type: "base64", data: "png" } }, { type: "text", text: "/compatibility-probe\n@fixture.txt" }];
  mockRead([data], (command, args) => {
    if (command === "prepare_conversation_input") return input;
    if (command === "start_claude_turn") {
      data.session.state = "running";
      data.messages = [{ sequence: 1, sessionId: "a", runId: "run-a", role: "user", body: args.input[1].text }];
      data.draft = "";
      return data.context;
    }
    throw new Error(command);
  });
  const first = render(panel(data));
  const composer = await screen.findByRole("textbox", { name: "Сообщение" });
  expect((composer as HTMLTextAreaElement).value).toBe("/compatibility-probe");
  expect(vi.mocked(invoke).mock.calls.every(([cmd]) => ["read_conversation", "load_executor_settings", "inspect_executor_settings"].includes(cmd))).toBe(true);
  act(() => listeners.drop!({ payload: { type: "drop", paths: ["/project/image.png"] } }));
  fireEvent.keyDown(composer, { key: "Enter", shiftKey: true });
  fireEvent.keyDown(composer, { key: "Enter", isComposing: true });
  expect(vi.mocked(invoke).mock.calls.some(([cmd]) => cmd === "prepare_conversation_input")).toBe(false);
  fireEvent.keyDown(composer, { key: "Enter" });
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("prepare_conversation_input", { sessionId: "a", text: "/compatibility-probe", paths: ["/project/fixture.txt", "/project/image.png"] }));
  expect(invoke).toHaveBeenCalledWith("start_claude_turn", { workspaceId: "w", sessionId: "a", input,
    draft: JSON.stringify({ text: "/compatibility-probe", paths: ["/project/fixture.txt", "/project/image.png"] }) });
  await waitFor(() => expect((screen.getByLabelText("Сообщение") as HTMLTextAreaElement).value).toBe(""));
  first.unmount();
  expect(vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === "start_claude_turn")).toHaveLength(1);
});

test("сохранение черновика сохраняет порядок после закрытия и повторного открытия", async () => {
  const data = conversation("draft-order");
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const saved: string[] = [];
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "read_conversation") return structuredClone(data);
    if (command === "save_conversation_draft") {
      const body = (args as { body: string }).body;
      const text = JSON.parse(body).text;
      if (text === "Первый текст") await pending;
      data.draft = body; saved.push(text); return;
    }
    throw new Error(command);
  });
  const first = render(panel(data));
  fireEvent.change(await screen.findByLabelText("Сообщение"), { target: { value: "Первый текст" } });
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("save_conversation_draft", {
    sessionId: data.session.id, body: JSON.stringify({ text: "Первый текст", paths: [] }),
  }));
  fireEvent.change(screen.getByLabelText("Сообщение"), { target: { value: "Старый текст" } });
  first.unmount();
  const second = render(panel(data));
  fireEvent.change(await screen.findByLabelText("Сообщение"), { target: { value: "Новый текст" } });
  await act(async () => {});
  await act(async () => finish());
  await waitFor(() => expect(saved).toHaveLength(3));
  expect(saved).toEqual(["Первый текст", "Старый текст", "Новый текст"]);
  second.unmount();
  render(panel(data));
  expect((await screen.findByLabelText("Сообщение") as HTMLTextAreaElement).value).toBe("Новый текст");
});

test("ошибка передачи сохраняет черновик и не запускает исполнителя", async () => {
  const data = conversation();
  mockRead([data], command => { if (command === "prepare_conversation_input") throw new Error("вложение недоступно"); throw new Error(command); });
  render(panel(data));
  fireEvent.change(await screen.findByLabelText("Сообщение"), { target: { value: "Текст" } });
  fireEvent.click(screen.getByRole("button", { name: "Отправить сообщение" }));
  expect((await screen.findByRole("alert")).textContent).toContain("вложение недоступно");
  expect((screen.getByLabelText("Сообщение") as HTMLTextAreaElement).value).toBe("Текст");
  expect(vi.mocked(invoke).mock.calls.some(([cmd]) => cmd.startsWith("start_"))).toBe(false);
});

test.each(["codex", "claude"])("%s очищает набранный с нуля черновик при быстром подтверждении", async executor => {
  const data = conversation(`quick-${executor}`, executor);
  vi.mocked(invoke).mockImplementation(async (command, args: any) => {
    if (command === "read_conversation") return structuredClone(data);
    if (command === "save_conversation_draft") { data.draft = args.body; return; }
    if (command === "prepare_conversation_input") return [{ type: "text", text: args.text }];
    if (command === `start_${executor}_turn`) {
      expect(args.draft).toBe(JSON.stringify({ text: "Выполнить команду", paths: [] }));
      data.draft = "";
      data.messages = [{ sequence: 1, sessionId: data.session.id, runId: data.context!.runId, role: "user", body: "Выполнить команду" }];
      return data.context;
    }
    throw new Error(command);
  });
  render(panel(data));
  fireEvent.change(await screen.findByLabelText("Сообщение"), { target: { value: "Выполнить команду" } });
  fireEvent.click(screen.getByRole("button", { name: "Отправить сообщение" }));
  await waitFor(() => expect((screen.getByLabelText("Сообщение") as HTMLTextAreaElement).value).toBe(""));
  expect(vi.mocked(invoke).mock.calls.filter(([command, args]) => command === "save_conversation_draft" && (args as any).body === JSON.stringify({ text: "", paths: [] }))).toHaveLength(0);
});

test.each(["codex", "claude"])("%s сохраняет новые правки при закрытии во время сохранения перед отправкой", async executor => {
  const data = conversation(`saving-${executor}`, executor);
  let releaseSave: (() => void) | undefined;
  let sentDraft = "";
  const saved: string[] = [];
  vi.mocked(invoke).mockImplementation(async (command, args: any) => {
    if (command === "read_conversation") return structuredClone(data);
    if (command === "save_conversation_draft") {
      if (!releaseSave) await new Promise<void>(resolve => { releaseSave = resolve; });
      data.draft = args.body; saved.push(JSON.parse(args.body).text); return;
    }
    if (command === "prepare_conversation_input") return [{ type: "text", text: args.text }];
    if (command === `start_${executor}_turn`) { sentDraft = args.draft; data.session.state = "running"; return data.context; }
    throw new Error(command);
  });
  const first = render(panel(data));
  fireEvent.change(await screen.findByLabelText("Сообщение"), { target: { value: "Отправленная команда" } });
  await waitFor(() => expect(releaseSave).toBeTypeOf("function"));
  fireEvent.click(screen.getByRole("button", { name: "Отправить сообщение" }));
  first.unmount();
  const second = render(panel(data));
  fireEvent.change(await screen.findByLabelText("Сообщение"), { target: { value: "Новый черновик" } });
  await act(async () => { releaseSave!(); });
  await waitFor(() => expect(sentDraft).toBe(JSON.stringify({ text: "Отправленная команда", paths: [] })));
  await waitFor(() => expect(saved).toEqual(["Отправленная команда", "Отправленная команда", "Новый черновик"]));
  if (data.draft === sentDraft) data.draft = "";
  second.unmount();
  render(panel(data));
  expect((await screen.findByLabelText("Сообщение") as HTMLTextAreaElement).value).toBe("Новый черновик");
});

test.each(["codex", "claude"].flatMap(executor => ["closed", "reopened", "edited"].map(timing => [executor, timing]))) (
  "%s сохраняет очистку отправленного черновика после закрытия: %s", async (executor, timing) => {
    const data = conversation(`sent-${executor}-${timing}`, executor);
    data.draft = "Отправленная команда";
    let sentDraft = "";
    let releaseSave: (() => void) | undefined;
    vi.mocked(invoke).mockImplementation(async (command, args: any) => {
      if (command === "read_conversation") return structuredClone(data);
      if (command === "save_conversation_draft") {
        if (JSON.parse(args.body).text === "Новый черновик") await new Promise<void>(resolve => { releaseSave = resolve; });
        data.draft = args.body; return;
      }
      if (command === "prepare_conversation_input") return [{ type: "text", text: args.text }];
      if (command === `start_${executor}_turn`) { sentDraft = args.draft; data.session.state = "running"; return data.context; }
      throw new Error(command);
    });
    const first = render(panel(data));
    await screen.findByLabelText("Сообщение");
    fireEvent.click(screen.getByRole("button", { name: "Отправить сообщение" }));
    await waitFor(() => expect(sentDraft).toBe(JSON.stringify({ text: "Отправленная команда", paths: [] })));
    first.unmount();
    let reopened: ReturnType<typeof render> | undefined;
    if (timing !== "closed") {
      reopened = render(panel(data));
      expect((await screen.findByLabelText("Сообщение") as HTMLTextAreaElement).value).toBe("Отправленная команда");
      if (timing === "edited") {
        fireEvent.change(screen.getByLabelText("Сообщение"), { target: { value: "Новый черновик" } });
        await waitFor(() => expect(releaseSave).toBeTypeOf("function"));
      }
    }
    data.messages = [{ sequence: 1, sessionId: data.session.id, runId: data.context!.runId, role: "user", body: "Отправленная команда" }];
    if (data.draft === sentDraft) data.draft = "";
    if (timing === "closed") reopened = render(panel(data));
    await screen.findByText("Отправленная команда", { selector: ".messages p, .messages pre" });
    const expected = timing === "edited" ? "Новый черновик" : "";
    await waitFor(() => expect((screen.getByLabelText("Сообщение") as HTMLTextAreaElement).value).toBe(expected));
    if (releaseSave) await act(async () => { releaseSave!(); });
    reopened!.unmount();
    render(panel(data));
    expect((await screen.findByLabelText("Сообщение") as HTMLTextAreaElement).value).toBe(expected);
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === `start_${executor}_turn`)).toHaveLength(1);
  },
);

test("остановка ждёт подтверждения, а ошибка записи итога остаётся видимой", async () => {
  const data = conversation(); data.session.state = "running";
  mockRead([data], command => { if (command === "interrupt_codex_turn") { data.session.state = "stopping"; return; } throw new Error(command); });
  render(panel(data));
  fireEvent.click(await screen.findByRole("button", { name: "Остановить выполнение" }));
  await screen.findByTitle("Ожидает остановки");
  expect(invoke).toHaveBeenCalledWith("interrupt_codex_turn", { context: data.context });
  act(() => listeners.events.forEach(callback => callback({ payload: { sequence: 0, context: data.context!, kind: "save_error", payload: { message: "диск недоступен" } } })));
  expect(screen.getByRole("alert").textContent).toContain("Результат не сохранён");
  fireEvent.change(screen.getByLabelText("Сообщение"), { target: { value: "Следующее сообщение" } });
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("save_conversation_draft", { sessionId: "a", body: JSON.stringify({ text: "Следующее сообщение", paths: [] }) }));
  expect(screen.getByRole("alert").textContent).toContain("Результат не сохранён");
  data.session.state = "interrupted";
  await screen.findByRole("button", { name: "Отправить сообщение" });
});

test.each(["codex", "claude"])("кнопка прерывания %s видна в поле отправки и ждёт подтверждения остановки", async executor => {
  const data = conversation("active-chat", executor); data.session.state = "running";
  let finish: () => void;
  mockRead([data], command => {
    if (command === `interrupt_${executor}_turn`) return new Promise<void>(resolve => { finish = () => { data.session.state = "stopping"; resolve(); }; });
    throw new Error(command);
  });
  render(panel(data));
  const stop = await screen.findByRole("button", { name: "Прервать ответ" }) as HTMLButtonElement;
  expect(stop.closest("form")?.className).toBe("conversation-composer");
  expect(stop.type).toBe("button");
  expect(stop.disabled).toBe(false);
  expect(screen.queryByRole("button", { name: "Отправить сообщение" })).toBeNull();
  fireEvent.click(stop);
  expect(invoke).toHaveBeenCalledWith(`interrupt_${executor}_turn`, { context: data.context });
  expect(stop.disabled).toBe(true);
  fireEvent.click(stop);
  expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === `interrupt_${executor}_turn`)).toHaveLength(1);
  await act(async () => finish());
  await screen.findByTitle("Ожидает остановки");
  expect((screen.getByRole("button", { name: "Прервать ответ" }) as HTMLButtonElement).disabled).toBe(true);
  data.session.state = "interrupted";
  await screen.findByRole("button", { name: "Отправить сообщение" });
  expect(screen.queryByRole("button", { name: "Прервать ответ" })).toBeNull();
  expect(vi.mocked(invoke).mock.calls.some(([command]) => command.startsWith("start_") || command.startsWith("stop_"))).toBe(false);
});

test("ошибка прерывания возвращает доступную кнопку для повторной попытки", async () => {
  const data = conversation(); data.session.state = "running";
  mockRead([data], command => { if (command === "interrupt_codex_turn") throw new Error("нет ответа"); throw new Error(command); });
  render(panel(data));
  fireEvent.click(await screen.findByRole("button", { name: "Прервать ответ" }));
  expect((await screen.findByRole("alert")).textContent).toContain("Остановка не подтверждена");
  expect((screen.getByRole("button", { name: "Прервать ответ" }) as HTMLButtonElement).disabled).toBe(false);
});

test("история удалённого пространства читается без выполнения и удаляется отдельным подтверждением", async () => {
  const data = conversation(); data.session.externalId = "native";
  data.messages = [{ sequence: 1, sessionId: "a", runId: "run-a", role: "assistant", body: "Сохранённая работа" }];
  mockRead([data], command => { if (command !== "delete_conversation") throw new Error(command); });
  render(panel(data, { ...workspace, deleted: true }));
  await screen.findByText("Сохранённая работа");
  expect((screen.getByRole("button", { name: "Продолжить разговор" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Удалить историю разговора" }));
  expect(vi.mocked(invoke).mock.calls.every(([cmd]) => cmd === "read_conversation")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Отменить удаление истории" }));
  expect(screen.queryByRole("button", { name: "Подтвердить удаление истории" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Удалить историю разговора" }));
  fireEvent.click(screen.getByRole("button", { name: "Подтвердить удаление истории" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("delete_conversation", { sessionId: "a", confirmed: true }));
});

test.each(["codex", "claude"])("незавершённая очистка %s допускает повторную остановку после закрытия вкладки", async executor => {
  const data = conversation("cleanup", executor); data.session.state = "error"; data.canStop = true;
  data.draft = JSON.stringify({ text: "Следующее сообщение", paths: [] });
  let attempts = 0;
  mockRead([data], command => {
    if (command === `stop_${executor}_process`) {
      if (++attempts === 1) throw new Error("запись процесса запрещена");
      data.canStop = false; data.session.state = "completed"; return;
    }
    throw new Error(command);
  });
  const first = render(panel(data));
  fireEvent.click(await screen.findByRole("button", { name: "Завершить процесс" }));
  await screen.findByText(/Остановка не подтверждена/);
  expect((screen.getByRole("button", { name: "Завершить процесс" }) as HTMLButtonElement).disabled).toBe(false);
  first.unmount();
  render(panel(data));
  const stop = await screen.findByRole("button", { name: "Завершить процесс" });
  expect((stop as HTMLButtonElement).disabled).toBe(false);
  expect((screen.getByRole("button", { name: "Отправить сообщение" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Удалить историю разговора" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(stop);
  await waitFor(() => expect((screen.getByRole("button", { name: "Завершить процесс" }) as HTMLButtonElement).disabled).toBe(true));
  expect((screen.getByRole("button", { name: "Отправить сообщение" }) as HTMLButtonElement).disabled).toBe(false);
  expect((screen.getByRole("button", { name: "Удалить историю разговора" }) as HTMLButtonElement).disabled).toBe(false);
  expect(attempts).toBe(2);
});

test.each([["codex", ""], ["claude", "   "]])("новый чат %s получает название по умолчанию для пустого ввода", async (executor, title) => {
  const next = conversation("new", executor).session;
  const opened = vi.fn(async () => {});
  const close = vi.fn();
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === "executor_availability") return availability;
    if (command === `create_${executor}_session`) return next;
    throw new Error(command);
  });
  render(<ConversationControls workspace={workspace} sessions={[]} open={opened} close={close} />);
  await screen.findByText("Готов");
  expect(screen.getByText("Активных чатов: 0")).toBeTruthy();
  fireEvent.click(screen.getByRole("combobox", { name: "Агент" }));
  fireEvent.click(screen.getByRole("option", { name: executor === "claude" ? "Claude Code" : "Codex" }));
  fireEvent.change(screen.getByLabelText(/Название чата/), { target: { value: title } });
  fireEvent.click(screen.getByRole("button", { name: "Создать чат" }));
  await waitFor(() => expect(opened).toHaveBeenCalledWith(next));
  expect(invoke).toHaveBeenCalledWith(`create_${executor}_session`, { workspaceId: workspace.id, title: "Новый чат" });
  expect(close).not.toHaveBeenCalled();
});

test("выбор исполнителя показывает его доступность, отмена не создаёт чат", async () => {
  const close = vi.fn();
  vi.mocked(invoke).mockResolvedValue([availability[0], { ...availability[1], state: "loginRequired", reason: "Требуется вход" }]);
  render(<ConversationControls workspace={workspace} sessions={[]} open={quiet} close={close} />);
  expect(screen.getByText("Проверка…")).toBeTruthy();
  await screen.findByText("Готов");
  fireEvent.click(screen.getByRole("combobox", { name: "Агент" }));
  fireEvent.click(screen.getByRole("option", { name: "Claude Code" }));
  expect(screen.getByText("Нужен вход")).toBeTruthy();
  expect(screen.queryByText("Готов")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
  expect(close).toHaveBeenCalledOnce();
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual(["executor_availability"]);
});

test("ошибка создания оставляет название чата и позволяет повторить попытку", async () => {
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === "executor_availability") throw new Error("Проверка недоступна");
    throw new Error("Не удалось сохранить");
  });
  const opened = vi.fn();
  render(<ConversationControls workspace={workspace} sessions={[]} open={opened} close={quiet} />);
  await screen.findByText("Не проверен");
  fireEvent.change(screen.getByLabelText(/Название чата/), { target: { value: "Разбор авторизации" } });
  fireEvent.click(screen.getByRole("button", { name: "Создать чат" }));
  expect((await screen.findByRole("alert")).textContent).toContain("Не удалось сохранить");
  expect((screen.getByLabelText(/Название чата/) as HTMLInputElement).value).toBe("Разбор авторизации");
  expect((screen.getByRole("button", { name: "Создать чат" }) as HTMLButtonElement).disabled).toBe(false);
  expect(opened).not.toHaveBeenCalled();
});

test("разговоры обоих исполнителей открываются вкладками и продолжаются после закрытия представления", async () => {
  const a = conversation(); const b = conversation("b", "claude");
  const data: Snapshot = { groups: [], projects: [{ id: "p", name: "Проект", path: "/project", kind: "folder", groupId: null, preparationCommand: null }],
    workspaces: [workspace], sessions: [], view: { projectId: "p", workspaceId: "w", tabs: [], activeTabs: {}, sidebarWidth: 260 } };
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (["list_directory", "list_file_drafts", "list_terminals"].includes(command)) return [];
    if (command === "executor_availability") return availability;
    if (command === "snapshot") return structuredClone(data);
    if (command === "save_view") { data.view = structuredClone((args as { view: View }).view); return; }
    if (command.startsWith("create_")) {
      const next = command === "create_codex_session" ? a : b;
      next.session.title = (args as any).title; data.sessions.push(next.session); return structuredClone(next.session);
    }
    if (command === "read_conversation") return structuredClone((args as any).sessionId === "a" ? a : b);
    if (command === "save_conversation_draft") return;
    if (command === "prepare_conversation_input") return [{ type: "text", text: (args as any).text }];
    if (command.startsWith("start_")) {
      const next = command === "start_codex_turn" ? a : b;
      next.session.state = "running"; return next.context;
    }
    throw new Error(command);
  });
  render(<App />);
  await screen.findByRole("heading", { name: "Проект" });
  for (const executor of ["Codex", "Claude Code"]) {
    fireEvent.click(screen.getByRole("button", { name: "Новая вкладка" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: new RegExp(`^${executor}\\s*Новый разговор`) }));
    await screen.findByRole("heading", { name: "Новый чат" });
    fireEvent.change(await screen.findByLabelText("Сообщение"), { target: { value: "Проверить проект" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить сообщение" }));
    await waitFor(() => expect(screen.getByRole("tab", { name: new RegExp(`Новый чат.*${executor}.*Выполняется`) })).toBeTruthy());
  }
  expect(data.sessions.filter(session => session.state === "running")).toHaveLength(2);
  const codexTab = screen.getByRole("tab", { name: /Новый чат.*Codex/ });
  fireEvent.click(within(codexTab.parentElement!).getByRole("button", { name: "Закрыть вкладку Новый чат" }));
  await waitFor(() => expect(screen.queryByRole("tab", { name: /Новый чат.*Codex/ })).toBeNull());
  expect(a.session.state).toBe("running");
  expect(vi.mocked(invoke).mock.calls.some(([cmd]) => cmd.startsWith("stop_") || cmd.startsWith("interrupt_"))).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "История разговоров" }));
  fireEvent.click(screen.getByRole("button", { name: /Открыть историю «Новый чат».*Codex/ }));
  await screen.findByRole("heading", { name: "Новый чат" });
  expect(vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd.startsWith("start_"))).toHaveLength(2);
});

test("позднее создание разговора сохраняет выбранный проект и расположение", async () => {
  const next = conversation();
  const data: Snapshot = { groups: [], projects: [
    { id: "p", name: "Первый", path: "/project", kind: "folder", groupId: null, preparationCommand: null },
    { id: "p2", name: "Второй", path: "/other", kind: "folder", groupId: null, preparationCommand: null },
  ], workspaces: [workspace, { ...workspace, id: "w2", projectId: "p2", path: "/other" }], sessions: [],
  view: { projectId: "p", workspaceId: "w", tabs: [], activeTabs: {}, sidebarWidth: 260 } };
  let finish: () => void;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (["list_directory", "list_file_drafts", "list_terminals"].includes(command)) return [];
    if (command === "executor_availability") return availability;
    if (command === "snapshot") return structuredClone(data);
    if (command === "save_view") { data.view = structuredClone((args as { view: View }).view); return; }
    if (command === "create_codex_session") return new Promise(resolve => { finish = () => { data.sessions.push(next.session); resolve(next.session); }; });
    if (command === "read_conversation") return structuredClone(next);
    throw new Error(command);
  });
  render(<App />);
  fireEvent.click((await screen.findAllByRole("button", { name: "Новый разговор" }))[0]);
  fireEvent.change(await screen.findByLabelText(/Название чата/), { target: { value: "Разговор a" } });
  fireEvent.click(within(screen.getByRole("dialog", { name: "Новый чат" })).getByRole("button", { name: "Создать чат" }));
  await waitFor(() => expect(finish).toBeDefined());
  fireEvent.click(screen.getByRole("button", { name: "Закрыть Новый чат" }));
  fireEvent.click(screen.getByRole("button", { name: "Все проекты" }));
  fireEvent.click(screen.getByRole("button", { name: /^Второй/ }));
  await screen.findByRole("heading", { name: "Второй" });
  for (let i = 0; i < 3; i++) fireEvent.keyDown(screen.getByRole("separator", { name: "Ширина проекта" }), { key: "ArrowRight" });
  await waitFor(() => expect(data.view.sidebarWidth).toBe(320));
  act(() => finish());
  await waitFor(() => expect(data.view.tabs.some(tab => tab.sessionId === "a")).toBe(true));
  expect(data.view).toMatchObject({ projectId: "p2", workspaceId: "w2", sidebarWidth: 320 });
  expect(screen.getByRole("heading", { name: "Второй" })).toBeTruthy();
});

test("боковая история открывает удалённое пространство без сохранения вкладки и запуска", async () => {
  const saved = conversation();
  saved.messages = [{ sequence: 1, sessionId: "a", runId: "run-a", role: "assistant", body: "История удалённого пространства" }];
  const data: Snapshot = { groups: [], projects: [{ id: "p", name: "Проект", path: "/project", kind: "folder", groupId: null, preparationCommand: null }],
    workspaces: [{ ...workspace, deleted: true }], sessions: [saved.session], view: { projectId: "p", workspaceId: null, tabs: [], activeTabs: {}, sidebarWidth: 260 } };
  vi.mocked(invoke).mockImplementation(async command => {
    if (["list_directory", "list_file_drafts", "list_terminals"].includes(command)) return [];
    if (command === "snapshot") return structuredClone(data);
    if (command === "read_conversation") return structuredClone(saved);
    throw new Error(command);
  });
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "История разговоров" }));
  const open = await screen.findByRole("button", { name: /Открыть историю «Разговор a»/ });
  fireEvent.click(open);
  await screen.findByText("История удалённого пространства");
  expect((screen.getByLabelText("Сообщение") as HTMLTextAreaElement).disabled).toBe(true);
  expect(vi.mocked(invoke).mock.calls.every(([cmd]) => ["snapshot", "read_conversation"].includes(cmd))).toBe(true);
});
