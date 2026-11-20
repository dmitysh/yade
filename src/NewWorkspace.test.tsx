// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import NewWorkspace from "./NewWorkspace";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
beforeEach(() => {
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === "project_branches") return ["main", "feature/payment", "origin/release"];
  });
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });
HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };

const project = { id: "p", groupId: null, name: "service-delivery-oms-frontend-global", path: "/project", kind: "repository", preparationCommand: null };

test("пустое название блокирует создание, новая ветка получает название пространства", async () => {
  const close = vi.fn(), refresh = vi.fn().mockResolvedValue(undefined);
  render(<NewWorkspace project={project} close={close} refresh={refresh} />);
  expect(document.activeElement).toBe(screen.getByLabelText("Название пространства"));
  await waitFor(() => expect((screen.getByLabelText("Исходная ветка или коммит") as HTMLInputElement).value).toBe("main"));
  expect((screen.getByRole("button", { name: "Создать пространство" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Название пространства"), { target: { value: "   " } });
  expect((screen.getByRole("button", { name: "Создать пространство" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Название пространства"), { target: { value: " delivery-fix " } });
  fireEvent.click(screen.getByRole("button", { name: "Создать пространство" }));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(invoke).toHaveBeenCalledWith("create_worktree", { request: { projectId: "p", name: "delivery-fix", sourceRef: "main", branch: "delivery-fix" } });
  expect(refresh).toHaveBeenCalledOnce();
});

test("имя ветки следует за названием пространства до ручного изменения", async () => {
  render(<NewWorkspace project={project} close={vi.fn()} refresh={vi.fn()} />);
  await waitFor(() => expect((screen.getByLabelText("Исходная ветка или коммит") as HTMLInputElement).value).toBe("main"));
  const name = screen.getByLabelText("Название пространства");
  const branch = screen.getByLabelText("Новая ветка") as HTMLInputElement;
  const hint = document.getElementById(branch.getAttribute("aria-describedby")!)!;
  expect(branch.required).toBe(true);
  expect(hint.textContent).toContain("Укажите имя новой ветки.");
  fireEvent.change(name, { target: { value: "delivery-fix" } });
  expect(branch.value).toBe("delivery-fix");
  expect(hint.textContent).toContain("С новой веткой delivery-fix от main.");
  fireEvent.change(name, { target: { value: "payment-fix" } });
  expect(branch.value).toBe("payment-fix");
  fireEvent.change(screen.getByLabelText("Исходная ветка или коммит"), { target: { value: "master" } });
  fireEvent.change(branch, { target: { value: " fix/delivery " } });
  fireEvent.change(name, { target: { value: "another-fix" } });
  expect(branch.value).toBe(" fix/delivery ");
  expect(hint.textContent).toContain("С новой веткой fix/delivery от master.");
  expect(hint.textContent).not.toContain("detached HEAD");
});

test.each(["", "   "])("пустая новая ветка блокирует создание: %s", async value => {
  render(<NewWorkspace project={project} close={vi.fn()} refresh={vi.fn()} />);
  await waitFor(() => expect((screen.getByLabelText("Исходная ветка или коммит") as HTMLInputElement).value).toBe("main"));
  fireEvent.change(screen.getByLabelText("Название пространства"), { target: { value: "delivery-fix" } });
  const branch = screen.getByLabelText("Новая ветка");
  fireEvent.change(branch, { target: { value } });
  const submit = screen.getByRole("button", { name: "Создать пространство" }) as HTMLButtonElement;
  expect(submit.disabled).toBe(true);
  expect(document.getElementById(branch.getAttribute("aria-describedby")!)!.textContent).toContain("Укажите имя новой ветки.");
  fireEvent.submit(submit.closest("form")!);
  expect(vi.mocked(invoke).mock.calls.some(([command]) => command === "create_worktree")).toBe(false);
  fireEvent.change(branch, { target: { value: "fix/delivery" } });
  expect(submit.disabled).toBe(false);
});

test.each([
  "Git: ветка уже существует",
  "Это расположение уже используется рабочим пространством. Укажите другое название пространства.",
])("ошибка создания сохраняет заполненную форму для исправления: %s", async message => {
  const close = vi.fn();
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === "project_branches") return [];
    throw new Error(message);
  });
  render(<NewWorkspace project={project} close={close} refresh={vi.fn().mockResolvedValue(undefined)} />);
  fireEvent.change(screen.getByLabelText("Название пространства"), { target: { value: "delivery-fix" } });
  fireEvent.change(screen.getByLabelText("Исходная ветка или коммит"), { target: { value: "main" } });
  fireEvent.change(screen.getByLabelText(/Новая ветка/), { target: { value: "fix/delivery" } });
  fireEvent.click(screen.getByRole("button", { name: "Создать пространство" }));
  expect((await screen.findByRole("alert")).textContent).toContain(message);
  expect((screen.getByLabelText("Название пространства") as HTMLInputElement).value).toBe("delivery-fix");
  expect((screen.getByLabelText(/Новая ветка/) as HTMLInputElement).value).toBe("fix/delivery");
  expect(close).not.toHaveBeenCalled();
  expect((screen.getByRole("button", { name: "Создать пространство" }) as HTMLButtonElement).disabled).toBe(false);
});

test.each(["Отмена", "Закрыть Новое пространство"])("%s закрывает окно без создания", button => {
  const close = vi.fn();
  render(<NewWorkspace project={project} close={close} refresh={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: button }));
  expect(close).toHaveBeenCalledOnce();
  expect(vi.mocked(invoke).mock.calls.some(([command]) => command === "create_worktree")).toBe(false);
});

test("ветки загружаются из проекта, поиск и выбор передают исходную точку при создании", async () => {
  render(<NewWorkspace project={project} close={vi.fn()} refresh={vi.fn().mockResolvedValue(undefined)} />);
  const picker = screen.getByRole("combobox", { name: "Выбрать исходную ветку" });
  await waitFor(() => expect((picker as HTMLButtonElement).disabled).toBe(false));
  expect(invoke).toHaveBeenCalledWith("project_branches", { projectId: "p" });
  fireEvent.click(picker);
  expect(screen.queryByRole("option", { name: /HEAD/ })).toBeNull();
  expect(screen.getByRole("option", { name: "main" }).getAttribute("aria-selected")).toBe("true");
  fireEvent.change(screen.getByRole("textbox", { name: "Найти ветку" }), { target: { value: "release" } });
  expect(screen.queryByRole("option", { name: "main" })).toBeNull();
  fireEvent.click(screen.getByRole("option", { name: "origin/release" }));
  expect((screen.getByLabelText("Исходная ветка или коммит") as HTMLInputElement).value).toBe("origin/release");
  fireEvent.click(picker);
  expect(screen.getByRole("option", { name: "origin/release" }).getAttribute("aria-selected")).toBe("true");
  fireEvent.keyDown(screen.getByRole("textbox", { name: "Найти ветку" }), { key: "Escape" });
  fireEvent.change(screen.getByLabelText("Название пространства"), { target: { value: "release-fix" } });
  fireEvent.click(screen.getByRole("button", { name: "Создать пространство" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("create_worktree", { request: { projectId: "p", name: "release-fix", sourceRef: "origin/release", branch: "release-fix" } }));
});

test.each([
  {
    branches: ["TASK-12345", "feature/payment", "main", "master", "origin/main", "origin/release", "upstream/main"],
    expected: ["master", "main", "TASK-12345", "feature/payment", "origin/main", "origin/release", "upstream/main"],
  },
  { branches: ["feature/payment", "main", "origin/main"], expected: ["main", "feature/payment", "origin/main"] },
  { branches: ["feature/payment", "origin/master"], expected: ["feature/payment", "origin/master"] },
  { branches: ["origin/main", "origin/release"], expected: ["origin/main", "origin/release"] },
])("главные ветки идут первыми, локальные перед удалёнными: $branches", async ({ branches, expected }) => {
  vi.mocked(invoke).mockResolvedValue(branches);
  render(<NewWorkspace project={project} close={vi.fn()} refresh={vi.fn()} />);
  const picker = screen.getByRole("combobox", { name: "Выбрать исходную ветку" });
  await waitFor(() => expect((picker as HTMLButtonElement).disabled).toBe(false));
  expect((screen.getByLabelText("Исходная ветка или коммит") as HTMLInputElement).value).toBe(expected[0]);
  fireEvent.click(picker);
  expect(screen.getAllByRole("option").map(option => option.textContent)).toEqual(expected);
});

test("пустой список не подставляет HEAD, ручной ввод HEAD не позволяет создать пространство", async () => {
  vi.mocked(invoke).mockResolvedValue([]);
  render(<NewWorkspace project={project} close={vi.fn()} refresh={vi.fn()} />);
  const picker = screen.getByRole("combobox", { name: "Выбрать исходную ветку" });
  await waitFor(() => expect((picker as HTMLButtonElement).disabled).toBe(false));
  const source = screen.getByLabelText("Исходная ветка или коммит") as HTMLInputElement;
  expect(source.value).toBe("");
  fireEvent.change(screen.getByLabelText("Название пространства"), { target: { value: "delivery-fix" } });
  const submit = screen.getByRole("button", { name: "Создать пространство" }) as HTMLButtonElement;
  expect(submit.disabled).toBe(true);
  fireEvent.change(source, { target: { value: " HEAD " } });
  expect(submit.disabled).toBe(true);
  expect(screen.getByRole("alert").textContent).toContain("вместо HEAD");
  fireEvent.submit(submit.closest("form")!);
  expect(vi.mocked(invoke).mock.calls.some(([command]) => command === "create_worktree")).toBe(false);
  fireEvent.change(source, { target: { value: "abc123" } });
  expect(submit.disabled).toBe(false);
});

test("ошибка загрузки веток не блокирует ручной ввод коммита", async () => {
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === "project_branches") throw new Error("папка недоступна");
  });
  render(<NewWorkspace project={project} close={vi.fn()} refresh={vi.fn().mockResolvedValue(undefined)} />);
  expect((await screen.findByRole("alert")).textContent).toContain("Не удалось загрузить ветки");
  fireEvent.change(screen.getByLabelText("Название пространства"), { target: { value: "commit-fix" } });
  fireEvent.change(screen.getByLabelText("Исходная ветка или коммит"), { target: { value: "abc123" } });
  fireEvent.click(screen.getByRole("button", { name: "Создать пространство" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("create_worktree", { request: { projectId: "p", name: "commit-fix", sourceRef: "abc123", branch: "commit-fix" } }));
});
