// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import ProjectOverview from "./ProjectOverview";
import type { Snapshot, Workspace } from "./types";

vi.mock("./Terminal", () => ({ terminalTitle: (id: string, title?: string | null) => title || `Терминал ${id.slice(0, 8)}` }));

afterEach(cleanup);

function fixture(): Snapshot {
  const workspace: Workspace = { id: "w1", projectId: "p1", groupId: null, name: "Основное", path: "/first", kind: "folder",
    archived: false, deleted: false, sourceRef: null, sourceCommit: null, gitRef: "main", operationState: "ready", operationError: null,
    preparationCommand: null, preparationState: "skipped", preparationOutput: "" };
  return {
    groups: [],
    projects: [{ id: "p1", groupId: null, name: "Первый", path: "/first", kind: "repository", preparationCommand: null },
      { id: "p2", groupId: null, name: "Второй", path: "/second", kind: "folder", preparationCommand: null }],
    workspaces: [workspace, { ...workspace, id: "w2", projectId: "p2", name: "Другое", path: "/second", gitRef: null }],
    sessions: [{ id: "s1", workspaceId: "w1", title: "Проверка", executor: "codex", state: "running" }],
    view: { projectId: "p1", workspaceId: "w1", tabs: [], activeTabs: {}, sidebarWidth: 260 },
  };
}

function overviewActions() {
  return { selectProject: vi.fn(), selectWorkspace: vi.fn(), openSession: vi.fn(), openTerminal: vi.fn(), removeEntry: vi.fn(), add: vi.fn() };
}

function overview(data: Snapshot, busy = false) {
  const actions = overviewActions();
  render(<ProjectOverview data={data} busy={busy} {...actions} />);
  return actions;
}

test("выделение текущего проекта следует за выбором и исчезает без выбранного проекта", () => {
  const data = fixture();
  const actions = overviewActions();
  const view = render(<ProjectOverview data={data} busy={false} {...actions} />);
  const current = () => view.container.querySelectorAll('.overview-project-link[aria-current="true"]');
  expect(current()).toHaveLength(1);
  expect(current()[0].textContent).toContain("Первый");
  view.rerender(<ProjectOverview data={{ ...data, view: { ...data.view, projectId: "p2", workspaceId: "w2" } }} busy={false} {...actions} />);
  expect(current()).toHaveLength(1);
  expect(current()[0].textContent).toContain("Второй");
  view.rerender(<ProjectOverview data={{ ...data, view: { ...data.view, projectId: null, workspaceId: null } }} busy={false} {...actions} />);
  expect(current()).toHaveLength(0);
});

test("обзор показывает сгенерированное название завершённой команды в терминале", () => {
  const data = fixture();
  data.terminals = [{ id: "t1", workspaceId: "w1", state: "running", exitCode: null, error: null,
    execution: { executor: "codex", state: "completed", title: "Восстановление вкладок" } }];
  const actions = overview(data);
  fireEvent.click(screen.getByRole("button", { name: /^Восстановление вкладок/ }));
  expect(actions.openTerminal).toHaveBeenCalledWith(data.terminals[0]);
  expect(screen.queryByText("Терминал t1")).toBeNull();
});

test("обзор сохраняет порядок проектов и показывает переходы к проекту, пространству и разговору", () => {
  const data = fixture();
  data.sessions.push({ id: "s2", workspaceId: "w2", title: "Нужен ответ", executor: "claude", state: "waiting" });
  const actions = overview(data);
  expect(screen.getAllByRole("article").map(element => element.getAttribute("aria-label"))).toEqual(["Проект Первый", "Проект Второй"]);
  const first = within(screen.getByRole("article", { name: "Проект Первый" }));
  expect(first.getByText("Работает")).toBeTruthy();
  expect(first.getByText("Codex · Выполняет задачу")).toBeTruthy();
  expect(first.getByText("main")).toBeTruthy();
  const second = within(screen.getByRole("article", { name: "Проект Второй" }));
  expect(second.getByText("Ждёт ответа")).toBeTruthy();
  expect(second.getByText("Claude · Нужен ответ для продолжения")).toBeTruthy();
  fireEvent.click(second.getByRole("button", { name: /Второй/ }));
  expect(actions.selectProject).toHaveBeenCalledWith(data.projects[1]);
  fireEvent.click(second.getByRole("button", { name: "Другое" }));
  expect(actions.selectWorkspace).toHaveBeenCalledWith(data.workspaces[1]);
  fireEvent.click(second.getByRole("button", { name: /^Нужен ответ/ }));
  expect(actions.openSession).toHaveBeenCalledWith(data.sessions[1]);
});

test("поиск в мониторинге находит проекты, пространства, разговоры и терминалы", () => {
  const data = fixture();
  data.sessions.push(...Array.from({ length: 3 }, (_, index) => ({
    ...data.sessions[0], id: `new${index}`, title: `Свежий разговор ${index}`, lastActivityAt: index + 1,
  })));
  data.terminals = [{ id: "t2", workspaceId: "w2", state: "running", exitCode: null, error: null,
    execution: { executor: "codex", state: "completed", title: "Сборка приложения" } }];
  const actions = overview(data);
  expect(screen.queryByRole("button", { name: /^Проверка/ })).toBeNull();
  const toggle = screen.getByRole("button", { name: "Свернуть или развернуть пространство Основное" });
  fireEvent.click(toggle);
  const search = (value: string) => fireEvent.change(screen.getByRole("searchbox", { name: "Поиск в мониторинге" }), { target: { value } });

  search("  ПРОВЕРКА  ");
  expect(screen.getAllByRole("article")).toEqual([screen.getByRole("article", { name: "Проект Первый" })]);
  expect(screen.queryByRole("button", { name: /^Свежий разговор/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /^Проверка/ }));
  expect(actions.openSession).toHaveBeenCalledWith(data.sessions[0]);

  search("сборка");
  fireEvent.click(screen.getByRole("button", { name: /^Сборка приложения/ }));
  expect(actions.openTerminal).toHaveBeenCalledWith(data.terminals[0]);

  search("main");
  expect(screen.getByRole("region", { name: "Пространство Основное" })).toBeTruthy();
  expect(screen.queryByRole("article", { name: "Проект Второй" })).toBeNull();

  search("второй");
  expect(screen.getAllByRole("article")).toEqual([screen.getByRole("article", { name: "Проект Второй" })]);
  expect(screen.getByRole("region", { name: "Пространство Другое" })).toBeTruthy();

  search("без совпадений");
  expect(screen.getByRole("status").textContent).toBe("Ничего не найдено");

  search("");
  expect(screen.getAllByRole("article")).toHaveLength(2);
  expect(screen.getByRole("button", { name: "Свернуть или развернуть пространство Основное" }).getAttribute("aria-expanded")).toBe("false");
});

test("проекты отсортированы по последней работе, при равных и неизвестных датах сохраняется исходный порядок", () => {
  const data = fixture();
  data.projects[0].lastActivityAt = 1000;
  data.projects[1].lastActivityAt = 3000;
  data.projects.push({ ...data.projects[0], id: "p3", name: "Третий", lastActivityAt: 3000 },
    { ...data.projects[0], id: "p4", name: "Без истории", lastActivityAt: undefined });
  const original = data.projects.map(project => project.id);
  overview(data);
  expect(screen.getAllByRole("article").map(element => element.getAttribute("aria-label"))).toEqual([
    "Проект Второй", "Проект Третий", "Проект Первый", "Проект Без истории",
  ]);
  expect(data.projects.map(project => project.id)).toEqual(original);
});

test("фоновая активность и выбор проекта обновляют мониторинг без перестановки проектов", () => {
  const data = fixture();
  data.projects[0].lastActivityAt = 1000;
  data.projects[1].lastActivityAt = 3000;
  const actions = overviewActions();
  const view = render(<ProjectOverview data={data} busy={false} {...actions} />);
  const order = () => screen.getAllByRole("article").map(element => element.getAttribute("aria-label"));
  expect(order()).toEqual(["Проект Второй", "Проект Первый"]);
  const updated = { ...data, projects: data.projects.map(project => ({ ...project, lastActivityAt: project.id === "p1" ? 5000 : 3000 })),
    sessions: data.sessions.map(session => ({ ...session, state: "waiting" })),
    view: { ...data.view, projectId: "p2", workspaceId: "w2" } };
  view.rerender(<ProjectOverview data={updated} busy={false} {...actions} />);
  expect(order()).toEqual(["Проект Второй", "Проект Первый"]);
  expect(within(screen.getByRole("article", { name: "Проект Первый" })).getByText("Ждёт ответа")).toBeTruthy();
  expect(screen.getByRole("button", { name: /Второй/ }).getAttribute("aria-current")).toBe("true");
  const added = { ...data.projects[0], id: "p3", name: "Новый", lastActivityAt: 6000 };
  view.rerender(<ProjectOverview data={{ ...updated, projects: [...updated.projects, added] }} busy={false} {...actions} />);
  expect(order()).toEqual(["Проект Новый", "Проект Второй", "Проект Первый"]);
  view.rerender(<ProjectOverview data={{ ...updated, projects: [updated.projects[0], added] }} busy={false} {...actions} />);
  expect(order()).toEqual(["Проект Новый", "Проект Первый"]);
  view.unmount();
  overview(updated);
  expect(order()).toEqual(["Проект Первый", "Проект Второй"]);
});

test("в каждом пространстве показаны три последних чата, Еще добавляет следующие три независимо от соседних пространств", () => {
  const data = fixture();
  data.sessions = Array.from({ length: 8 }, (_, index) => ({
    ...data.sessions[0], id: `s${index}`, title: `Чат ${index}`, lastActivityAt: index * 1000,
  }));
  data.sessions.push(...Array.from({ length: 5 }, (_, index) => ({
    ...data.sessions[0], id: `other${index}`, workspaceId: "w2", title: `Соседний ${index}`, lastActivityAt: index * 1000,
  })));
  const original = data.sessions.map(session => session.id);
  overview(data);
  const first = within(screen.getByRole("region", { name: "Пространство Основное" }));
  const second = within(screen.getByRole("region", { name: "Пространство Другое" }));
  const names = () => first.getAllByRole("button", { name: /^Чат/ }).map(button => button.textContent?.match(/^Чат \d+/)?.[0]);
  expect(names()).toEqual(["Чат 7", "Чат 6", "Чат 5"]);
  expect(second.getAllByRole("button", { name: /^Соседний/ })).toHaveLength(3);
  expect(screen.getByText("1 пространство · 8 агентов")).toBeTruthy();
  fireEvent.click(first.getByRole("button", { name: "Еще" }));
  expect(names()).toEqual(["Чат 7", "Чат 6", "Чат 5", "Чат 4", "Чат 3", "Чат 2"]);
  expect(second.getAllByRole("button", { name: /^Соседний/ })).toHaveLength(3);
  fireEvent.click(first.getByRole("button", { name: "Еще" }));
  expect(names()).toEqual(["Чат 7", "Чат 6", "Чат 5", "Чат 4", "Чат 3", "Чат 2", "Чат 1", "Чат 0"]);
  expect(first.queryByRole("button", { name: "Еще" })).toBeNull();
  expect(second.getByRole("button", { name: "Еще" })).toBeTruthy();
  expect(data.sessions.map(session => session.id)).toEqual(original);
});

test("обновление времени использования поднимает чат в первые три, при равных и неизвестных датах порядок устойчив", () => {
  const data = fixture();
  data.sessions = [
    { ...data.sessions[0], id: "old", title: "Старый", lastActivityAt: 1000 },
    { ...data.sessions[0], id: "latest", title: "Свежий", lastActivityAt: 3000 },
    { ...data.sessions[0], id: "equal", title: "Та же дата", lastActivityAt: 3000 },
    { ...data.sessions[0], id: "unknown", title: "Без даты" },
  ];
  const actions = overviewActions();
  const view = render(<ProjectOverview data={data} busy={false} {...actions} />);
  const rows = () => [...view.container.querySelectorAll(".overview-session strong")].map(element => element.textContent);
  expect(rows()).toEqual(["Свежий", "Та же дата", "Старый"]);
  view.rerender(<ProjectOverview data={{ ...data, sessions: data.sessions.map(session => session.id === "unknown" ? { ...session, lastActivityAt: 4000 } : session) }} busy={false} {...actions} />);
  expect(rows()).toEqual(["Без даты", "Свежий", "Та же дата"]);
  fireEvent.click(screen.getByRole("button", { name: "Еще" }));
  expect(rows()).toEqual(["Без даты", "Свежий", "Та же дата", "Старый"]);
  expect(screen.queryByRole("button", { name: "Еще" })).toBeNull();
});

test("терминалы и разговоры входят в общие три последних элемента и Еще, закрытая вкладка не скрывает терминал", () => {
  const data = fixture();
  data.sessions[0].lastActivityAt = 3000;
  data.sessions.push({ ...data.sessions[0], id: "old", title: "Старый разговор", lastActivityAt: 1000 });
  data.terminals = [
    { id: "t1", workspaceId: "w1", state: "running", exitCode: null, error: null, lastActivityAt: 4000 },
    { id: "t2", workspaceId: "w1", state: "completed", exitCode: 0, error: null, lastActivityAt: 2000 },
    { id: "foreign", workspaceId: "archived", state: "running", exitCode: null, error: null, lastActivityAt: 9000 },
  ];
  data.workspaces.push({ ...data.workspaces[0], id: "archived", archived: true });
  const actions = overview(data);
  const first = within(screen.getByRole("region", { name: "Пространство Основное" }));
  const names = () => first.getAllByRole("button").filter(button => button.classList.contains("overview-session"))
    .map(button => button.querySelector("strong")?.textContent);
  expect(names()).toEqual(["Терминал t1", "Проверка", "Терминал t2"]);
  expect(first.getByText("Открыт")).toBeTruthy();
  expect(first.getByText("Завершён")).toBeTruthy();
  expect(screen.getByText("1 пространство · 2 агента · 2 терминала")).toBeTruthy();
  expect(within(screen.getByLabelText("Сводка статусов")).getByText("2 работают")).toBeTruthy();
  fireEvent.click(first.getByRole("button", { name: /^Терминал t1/ }));
  expect(actions.openTerminal).toHaveBeenCalledWith(data.terminals[0]);
  expect(actions.openSession).not.toHaveBeenCalled();
  fireEvent.click(first.getByRole("button", { name: "Еще" }));
  expect(names()).toEqual(["Терминал t1", "Проверка", "Терминал t2", "Старый разговор"]);
  expect(first.queryByRole("button", { name: "Еще" })).toBeNull();
  expect(screen.queryByRole("button", { name: /^Терминал foreign/ })).toBeNull();
});

test.each([
  ["running", null, "Открыт"], ["completed", null, "Завершён"], ["stopped", null, "Остановлен"],
  ["failed", null, "Ошибка"], ["running", "Ошибка PTY", "Ошибка"], ["unknown", null, "Нужна проверка"],
])("состояние терминала %s с ошибкой %s отображается отдельно от состояния разговора", (state, error, label) => {
  const data = fixture();
  data.sessions = [];
  data.terminals = [{ id: "t1", workspaceId: "w1", state, exitCode: null, error, lastActivityAt: 1000 }];
  overview(data);
  const first = within(screen.getByRole("region", { name: "Пространство Основное" }));
  expect(first.getByText(label)).toBeTruthy();
  expect(first.getByRole("button", { name: /^Терминал t1/ })).toBeTruthy();
  expect(first.queryByText("Разговоров и терминалов пока нет")).toBeNull();
});

test("сводка считает разговоры с разными статусами внутри одного проекта", () => {
  const data = fixture();
  data.sessions.push({ ...data.sessions[0], id: "s2", state: "starting" },
    { ...data.sessions[0], id: "s3", state: "waiting" }, { ...data.sessions[0], id: "s4", state: "failed" });
  overview(data);
  const summary = within(screen.getByLabelText("Сводка статусов"));
  expect(summary.getByText("2 работают")).toBeTruthy();
  expect(summary.getByText("1 ждёт ответа")).toBeTruthy();
  expect(summary.getByText("1 ошибка")).toBeTruthy();
  expect(screen.getByText("1 пространство · 4 агента")).toBeTruthy();
  expect(screen.queryByLabelText("Обозначения статусов")).toBeNull();
});

test.each([
  ["unknown", "Статус неизвестен", "1 требует проверки"], ["running", "Работает", "2 работают"],
  ["waiting", "Ждёт ответа", "1 ждёт ответа"], ["ready", "Готов", "0 ждут ответа"], ["failed", "Ошибка", "1 ошибка"],
])("состояние %s внутри терминала учитывается в строке и сводке, открытая оболочка не считается работой", (state, label, summary) => {
  const data = fixture();
  data.terminals = [
    { id: "monitored", workspaceId: "w1", state: "running", exitCode: null, error: null, execution: { executor: "codex", state } },
    { id: "plain", workspaceId: "w2", state: "running", exitCode: null, error: null },
  ];
  const actions = overview(data);
  const row = screen.getByRole("button", { name: /^Терминал monitore/ });
  expect(within(row).getByText(label)).toBeTruthy();
  expect(row.textContent).toContain("Codex ·");
  if (state === "unknown") expect(row.textContent).toContain("Статус не удалось определить по экрану терминала");
  expect(within(screen.getByLabelText("Сводка статусов")).getByText(summary)).toBeTruthy();
  expect(screen.getByText("1 пространство · 2 агента · 1 терминал")).toBeTruthy();
  fireEvent.click(row);
  expect(actions.openTerminal).toHaveBeenCalledWith(data.terminals[0]);
});

test.each(["failed", "error", "needs_reconciliation", "unknown"])("ошибка и непроверенный запуск %s различаются в сводке", state => {
  const data = fixture();
  data.sessions[0].state = state;
  overview(data);
  const error = ["failed", "error"].includes(state);
  const first = within(screen.getByRole("article", { name: "Проект Первый" }));
  expect(first.getByText(error ? "Ошибка" : "Нужна проверка")).toBeTruthy();
  const summary = within(screen.getByLabelText("Сводка статусов"));
  expect(summary.getByText(error ? "1 ошибка" : "0 ошибок")).toBeTruthy();
  if (!error) expect(summary.getByText("1 требует проверки")).toBeTruthy();
});

test.each([
  ["creating", "skipped", "Создание пространства…"],
  ["ready", "pending", "Подготовка в очереди"],
  ["ready", "running", "Подготовка пространства…"],
  ["error", "skipped", "Операция не завершена"],
  ["ready", "failed", "Ошибка подготовки"],
  ["ready", "needs_reconciliation", "Подготовка требует проверки"],
])("состояние пространства %s и подготовки %s остаётся видимым без разговоров", (operationState, preparationState, note) => {
  const data = fixture();
  data.sessions = [];
  Object.assign(data.workspaces[1], { operationState, preparationState });
  overview(data);
  expect(within(screen.getByRole("article", { name: "Проект Второй" })).getByText(note)).toBeTruthy();
  expect(within(screen.getByLabelText("Сводка статусов")).getByText("0 работают")).toBeTruthy();
});

test("архивные, удалённые и общие пространства не попадают в сводку проектов, готовые разговоры видны", () => {
  const data = fixture();
  data.sessions[0].state = "completed";
  data.workspaces.push({ ...data.workspaces[0], id: "archived", name: "Архив", archived: true },
    { ...data.workspaces[0], id: "deleted", name: "Удалено", deleted: true },
    { ...data.workspaces[0], id: "group", projectId: null, name: "Общая папка" });
  data.sessions.push({ ...data.sessions[0], id: "s2", workspaceId: "archived", state: "waiting" },
    { ...data.sessions[0], id: "s3", workspaceId: "deleted", state: "failed" },
    { ...data.sessions[0], id: "s4", workspaceId: "group", state: "running" });
  overview(data);
  const first = within(screen.getByRole("article", { name: "Проект Первый" }));
  expect(first.getByText("Готов")).toBeTruthy();
  expect(first.getByText("1 пространство · 1 агент")).toBeTruthy();
  expect(first.getByRole("button", { name: /Проверка.*Выполнение завершено/ })).toBeTruthy();
  expect(screen.queryByText("Архив")).toBeNull();
  expect(screen.queryByText("Удалено")).toBeNull();
  expect(screen.queryByText("Общая папка")).toBeNull();
  const summary = within(screen.getByLabelText("Сводка статусов"));
  for (const text of ["0 работают", "0 ждут ответа", "0 ошибок"]) expect(summary.getByText(text)).toBeTruthy();
});

test("сворачивание пространства скрывает его содержимое, сохраняя общие счётчики", () => {
  const data = fixture();
  overview(data);
  const toggle = screen.getByRole("button", { name: "Свернуть или развернуть пространство Основное" });
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("button", { name: /^Проверка/ })).toBeNull();
  expect(within(screen.getByLabelText("Сводка статусов")).getByText("1 работает")).toBeTruthy();
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByRole("button", { name: /^Проверка/ })).toBeTruthy();
});

test("пустой обзор позволяет добавить проект, переходы заблокированы при сохранении", () => {
  const data = fixture();
  data.projects = []; data.workspaces = []; data.sessions = [];
  const actions = overview(data);
  expect(screen.getByRole("heading", { name: "Проектов пока нет" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Добавить проект" }));
  expect(actions.add).toHaveBeenCalledOnce();
  cleanup();
  overview(fixture(), true);
  const actionsDisabled = screen.getAllByRole("button").filter(button => !button.hasAttribute("aria-expanded"));
  expect(actionsDisabled.every(button => (button as HTMLButtonElement).disabled)).toBe(true);
});
