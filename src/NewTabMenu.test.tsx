// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import NewTabMenu from "./NewTabMenu";
import type { Availability } from "./ExecutorSettings";
import type { Workspace } from "./types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const workspace: Workspace = { id: "w1", projectId: "p1", groupId: null, name: "Основное", path: "/project", kind: "folder",
  archived: false, deleted: false, sourceRef: null, sourceCommit: null, gitRef: null, operationState: "ready", operationError: null,
  preparationCommand: null, preparationState: "skipped", preparationOutput: "" };
const ready: Availability = { executor: "codex", path: "/bin/codex", version: "1.0", state: "ready", reason: "Готов", action: "" };
const discover = () => invoke<Availability[]>("executor_availability");

test.each([
  ["1", "start_terminal"],
  ["2", "create_codex_session"],
  ["3", "create_claude_session"],
])("цифра %s выбирает соответствующий пункт меню", async (key, command) => {
  const openSession = vi.fn().mockResolvedValue(undefined);
  const openTerminal = vi.fn().mockResolvedValue(undefined);
  const session = { id: "s1" };
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === "executor_availability") return [ready, { ...ready, executor: "claude" }];
    if (command === "start_terminal") return { id: "t1" };
    return session;
  });
  render(<NewTabMenu workspace={workspace} disabled={false} discover={discover} openSession={openSession} openTerminal={openTerminal} />);
  const trigger = screen.getByRole("button", { name: "Новая вкладка" });
  fireEvent.click(trigger);
  await screen.findByRole("menuitem", { name: /^Codex\s*Новый разговор/ });
  expect(screen.getAllByRole("menuitem").map(item => item.querySelector("kbd")?.textContent)).toEqual(["1", "2", "3"]);
  fireEvent.keyDown(trigger, { key, code: `Digit${key}` });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  const terminal = command === "start_terminal";
  expect(invoke).toHaveBeenLastCalledWith(command,
    terminal ? { workspaceId: "w1", cols: 80, rows: 24 } : { workspaceId: "w1", title: "Новый чат" });
  expect(terminal ? openTerminal : openSession).toHaveBeenCalledWith(terminal ? "t1" : session);
});

test("цифры не запускают недоступный пункт, сочетание с модификатором или повтор клавиши", async () => {
  vi.mocked(invoke).mockResolvedValue([ready, { ...ready, executor: "claude", state: "loginRequired" }]);
  render(<NewTabMenu workspace={workspace} disabled={false} discover={discover} openSession={vi.fn()} openTerminal={vi.fn()} />);
  const trigger = screen.getByRole("button", { name: "Новая вкладка" });
  fireEvent.keyDown(trigger, { key: "1" });
  expect(invoke).not.toHaveBeenCalled();
  fireEvent.click(trigger);
  const codex = await screen.findByRole("menuitem", { name: /^Codex\s*Новый разговор/ });
  for (const event of [{ key: "3" }, { key: "9" }, ...["metaKey", "ctrlKey", "altKey", "shiftKey", "repeat", "isComposing"].map(modifier => ({ key: "1", [modifier]: true }))]) {
    fireEvent.keyDown(codex, event);
  }
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("menuitem", { name: /^Терминал/ }).querySelector("kbd")?.textContent).toBe("1");
});

test.each(["codex", "claude"])("найденный %s создаёт разговор в текущем пространстве", async executor => {
  const session = { id: "s1", workspaceId: "w1", executor, title: "Новый чат", state: "ready" };
  const openSession = vi.fn().mockResolvedValue(undefined);
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === "executor_availability") return [{ ...ready, executor }, { ...ready, executor: executor === "codex" ? "claude" : "codex", state: "missing", path: null }];
    if (command === `create_${executor}_session`) return session;
    throw new Error(command);
  });
  render(<NewTabMenu workspace={workspace} disabled={false} discover={discover} openSession={openSession} openTerminal={vi.fn()} />);
  expect(invoke).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Новая вкладка" }));
  const item = await screen.findByRole("menuitem", { name: new RegExp(`^${executor === "codex" ? "Codex" : "Claude Code"}\\s*Новый разговор`) });
  expect(screen.getAllByRole("menuitem")).toHaveLength(2);
  fireEvent.click(item);
  await waitFor(() => expect(openSession).toHaveBeenCalledWith(session));
  expect(invoke).toHaveBeenCalledWith(`create_${executor}_session`, { workspaceId: "w1", title: "Новый чат" });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
});

test("терминал создаётся без исполнителей, повторное открытие получает список через переданный поиск", async () => {
  const openTerminal = vi.fn().mockResolvedValue(undefined);
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === "executor_availability") return [];
    if (command === "start_terminal") return { id: "t1" };
    throw new Error(command);
  });
  render(<NewTabMenu workspace={workspace} disabled={false} discover={discover} openSession={vi.fn()} openTerminal={openTerminal} />);
  const trigger = screen.getByRole("button", { name: "Новая вкладка" });
  fireEvent.click(trigger);
  await screen.findByText(/Исполнители не найдены/);
  fireEvent.click(screen.getByRole("menuitem", { name: /Терминал/ }));
  await waitFor(() => expect(openTerminal).toHaveBeenCalledWith("t1"));
  expect(invoke).toHaveBeenCalledWith("start_terminal", { workspaceId: "w1", cols: 80, rows: 24 });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  fireEvent.click(trigger);
  await waitFor(() => expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "executor_availability")).toHaveLength(2));
});

test("терминал открывается одним пунктом без отдельных запусков исполнителей", async () => {
  const openTerminal = vi.fn().mockResolvedValue(undefined);
  const openSession = vi.fn();
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === "executor_availability") return [ready, { ...ready, executor: "claude" }];
    if (command === "start_terminal") return { id: "monitored" };
    throw new Error(command);
  });
  render(<NewTabMenu workspace={workspace} disabled={false} discover={discover} openSession={openSession} openTerminal={openTerminal} />);
  fireEvent.click(screen.getByRole("button", { name: "Новая вкладка" }));
  await screen.findByRole("menuitem", { name: /^Codex\s*Новый разговор/ });
  expect(screen.queryByRole("menuitem", { name: /в терминале/ })).toBeNull();
  fireEvent.click(screen.getByRole("menuitem", { name: /^Терминал/ }));
  await waitFor(() => expect(openTerminal).toHaveBeenCalledWith("monitored"));
  expect(invoke).toHaveBeenCalledWith("start_terminal", { workspaceId: "w1", cols: 80, rows: 24 });
  expect(openSession).not.toHaveBeenCalled();
  expect(screen.queryByRole("menu")).toBeNull();
});

test.each(["Терминал", "Codex"])("выбор %s с потерей фокуса без новой цели создаёт вкладку", async name => {
  const session = { id: "s1", workspaceId: "w1", executor: "codex", title: "Новый чат", state: "ready" };
  const openSession = vi.fn().mockResolvedValue(undefined);
  const openTerminal = vi.fn().mockResolvedValue(undefined);
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === "executor_availability") return [ready];
    if (command === "start_terminal") return { id: "t1" };
    if (command === "create_codex_session") return session;
    throw new Error(command);
  });
  render(<NewTabMenu workspace={workspace} disabled={false} discover={discover} openSession={openSession} openTerminal={openTerminal} />);
  fireEvent.click(screen.getByRole("button", { name: "Новая вкладка" }));
  const focused = await screen.findByRole("menuitem", { name: /^Codex\s*Новый разговор/ });
  act(() => focused.focus());
  const item = screen.getByRole("menuitem", { name: name === "Codex" ? /^Codex\s*Новый разговор/ : new RegExp(name) });
  fireEvent.pointerDown(item);
  fireEvent.mouseDown(item);
  fireEvent.blur(focused, { relatedTarget: null });
  fireEvent.mouseUp(item);
  fireEvent.click(item);
  await waitFor(() => expect(name === "Терминал" ? openTerminal : openSession).toHaveBeenCalledWith(name === "Терминал" ? "t1" : session));
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
});

test("исполнитель без входа недоступен, ошибка поиска не мешает создать терминал", async () => {
  vi.mocked(invoke).mockResolvedValue([{ ...ready, state: "loginRequired", reason: "Требуется вход", action: "Выполните codex login в терминале." }]);
  render(<NewTabMenu workspace={workspace} disabled={false} discover={discover} openSession={vi.fn()} openTerminal={vi.fn()} />);
  const trigger = screen.getByRole("button", { name: "Новая вкладка" });
  fireEvent.click(trigger);
  const codex = await screen.findByRole("menuitem", { name: /^Codex(?! в терминале)/ });
  expect((codex as HTMLButtonElement).disabled).toBe(true);
  expect(codex.textContent).toContain("Выполните codex login");
  fireEvent.click(codex);
  expect(invoke).toHaveBeenCalledTimes(1);
  fireEvent.click(trigger);
  vi.mocked(invoke).mockRejectedValue(new Error("Проверка недоступна"));
  fireEvent.click(trigger);
  expect((await screen.findByRole("alert")).textContent).toContain("Проверка недоступна");
  expect((screen.getByRole("menuitem", { name: /Терминал/ }) as HTMLButtonElement).disabled).toBe(false);
});

test("во время поиска можно создать терминал, запоздавший результат закрытого меню игнорируется", async () => {
  let finish!: (value: Availability[]) => void;
  const openTerminal = vi.fn().mockResolvedValue(undefined);
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === "executor_availability") return new Promise(resolve => { finish = resolve; });
    if (command === "start_terminal") return { id: "t1" };
    throw new Error(command);
  });
  render(<NewTabMenu workspace={workspace} disabled={false} discover={discover} openSession={vi.fn()} openTerminal={openTerminal} />);
  const trigger = screen.getByRole("button", { name: "Новая вкладка" });
  fireEvent.click(trigger);
  expect(screen.getByRole("status").textContent).toContain("Поиск");
  fireEvent.keyDown(trigger, { key: "1" });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  await act(async () => finish([ready]));
  expect(screen.queryByRole("menu")).toBeNull();
  expect(openTerminal).toHaveBeenCalledWith("t1");
});

test("ошибка запуска видна, повторное нажатие во время создания не запускает второй терминал", async () => {
  let fail!: (error: Error) => void;
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === "executor_availability") return [];
    if (command === "start_terminal") return new Promise((_, reject) => { fail = reject; });
    throw new Error(command);
  });
  render(<NewTabMenu workspace={workspace} disabled={false} discover={discover} openSession={vi.fn()} openTerminal={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Новая вкладка" }));
  const terminal = screen.getByRole("menuitem", { name: /Терминал/ });
  fireEvent.click(terminal);
  fireEvent.click(terminal);
  expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "start_terminal")).toHaveLength(1);
  await act(async () => fail(new Error("Оболочка недоступна")));
  expect(screen.getByRole("alert").textContent).toContain("Терминал не открыт: Error: Оболочка недоступна");
  expect((terminal as HTMLButtonElement).disabled).toBe(false);
});

test("меню управляется клавиатурой и закрывается по Escape, уходу фокуса и нажатию снаружи", async () => {
  vi.mocked(invoke).mockResolvedValue([ready, { ...ready, executor: "claude", state: "error", action: "Проверьте CLI" }]);
  render(<><NewTabMenu workspace={workspace} disabled={false} discover={discover} openSession={vi.fn()} openTerminal={vi.fn()} /><button>Снаружи</button></>);
  const trigger = screen.getByRole("button", { name: "Новая вкладка" });
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  const codex = await screen.findByRole("menuitem", { name: /^Codex\s*Новый разговор/ });
  const terminal = screen.getByRole("menuitem", { name: /Терминал/ });
  await waitFor(() => expect(document.activeElement).toBe(terminal));
  fireEvent.keyDown(terminal, { key: "ArrowDown" });
  expect(document.activeElement).toBe(codex);
  fireEvent.keyDown(codex, { key: "ArrowUp" });
  expect(document.activeElement).toBe(terminal);
  fireEvent.keyDown(terminal, { key: "Escape" });
  expect(screen.queryByRole("menu")).toBeNull();
  expect(document.activeElement).toBe(trigger);
  fireEvent.click(trigger);
  act(() => screen.getByRole("button", { name: "Снаружи" }).focus());
  expect(screen.queryByRole("menu")).toBeNull();
  fireEvent.click(trigger);
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole("menu")).toBeNull();
});

test.each([undefined, { ...workspace, archived: true }, { ...workspace, operationState: "creating" }, { ...workspace, deleted: true }])("создание недоступно без активного пространства", workspace => {
  render(<NewTabMenu workspace={workspace} disabled={false} discover={discover} openSession={vi.fn()} openTerminal={vi.fn()} />);
  const trigger = screen.getByRole("button", { name: "Новая вкладка" });
  expect((trigger as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(trigger);
  expect(invoke).not.toHaveBeenCalled();
});
