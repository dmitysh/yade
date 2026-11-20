// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import ExecutorSettings, { defaults, type Catalog } from "./ExecutorSettings";
import type { Workspace } from "./types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const workspace = { id: "w1", name: "Задача", path: "/one", archived: false, operationState: "ready" } as Workspace;
const catalog: Catalog = {
  models: [{ value: "chosen", label: "Доступная модель", reasoningEfforts: ["low", "high"], supportsFastMode: true }],
  workModes: [{ value: "default", label: "Выполнение" }, { value: "plan", label: "План" }],
  approvalPolicies: [{ value: "on-request", label: "По запросу" }],
  sandboxes: [{ value: "read-only", label: "Только чтение" }],
  permissionModes: [], warnings: ["Проектные настройки отключены: нет доверия"],
};
const availability = ["codex", "claude"].map(executor => ({ executor, state: "ready", version: "проверена", path: `/bin/${executor}`, reason: "Штатный вход найден", action: "" }));

function mockCommands(save = async () => {}) {
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === "executor_availability") return availability;
    if (command === "load_executor_settings") return defaults;
    if (command === "inspect_executor_settings") return catalog;
    if (command === "save_executor_settings") return save();
    throw new Error(`неожиданная команда: ${command}`);
  });
}

function choose(label: string, option: string) {
  fireEvent.click(screen.getByRole("combobox", { name: label }));
  fireEvent.click(screen.getByRole("option", { name: option }));
}

test("штатные параметры не подменяются, выбор направляется только выбранной сессии", async () => {
  mockCommands();
  render(<ExecutorSettings workspace={workspace} session={{ id: "s1", workspaceId: "w1", executor: "codex", title: "Исправление", state: "ready" }} />);
  await screen.findByLabelText("Модель");
  expect(screen.getByLabelText("Модель").textContent).toBe("Выберите модель");
  expect(screen.getByText(/нет доверия/)).toBeTruthy();
  choose("Модель", "Доступная модель");
  choose("Запросы разрешений", "По запросу");
  fireEvent.click(screen.getByRole("button", { name: "Проверить и сохранить параметры" }));
  await screen.findByText("Параметры проверены и сохранены для следующего запуска.");
  expect(invoke).toHaveBeenCalledWith("save_executor_settings", {
    target: { workspaceId: "w1", sessionId: "s1", executor: "codex" },
    settings: { ...defaults, model: "chosen", approvalPolicy: "on-request" },
  });
});

test("параметры по умолчанию из каталога сразу выбраны в общих настройках", async () => {
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === "executor_availability") return availability;
    if (command === "load_executor_settings") return defaults;
    if (command === "inspect_executor_settings") return { ...catalog, defaultModel: "chosen", defaultReasoningEffort: "high" };
    throw new Error(`неожиданная команда: ${command}`);
  });
  render(<ExecutorSettings workspace={workspace} />);
  await screen.findByLabelText("Усилия рассуждения");
  expect(screen.getByLabelText("Модель").textContent).toBe("Доступная модель");
  expect(screen.getByLabelText("Усилия рассуждения").textContent).toBe("Высокие");
  expect(vi.mocked(invoke).mock.calls.some(([command]) => command === "save_executor_settings")).toBe(false);
});

test("отказ исполнителя виден и не показывается как успешное применение", async () => {
  mockCommands(async () => { throw new Error("модель отклонена"); });
  render(<ExecutorSettings workspace={workspace} />);
  await screen.findByLabelText("Модель");
  choose("Модель", "Доступная модель");
  fireEvent.click(screen.getByRole("button", { name: "Проверить и сохранить параметры" }));
  expect((await screen.findByRole("alert")).textContent).toContain("не применены и не сохранены");
  expect(screen.queryByText("Параметры проверены и сохранены для следующего запуска.")).toBeNull();
});

test("отсутствие одного CLI не мешает настройке другого", async () => {
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === "executor_availability") return [{ ...availability[0], state: "missing", reason: "Codex не найден", action: "Установите Codex" }, availability[1]];
    if (command === "load_executor_settings") return defaults;
    if (command === "inspect_executor_settings") return { ...catalog, approvalPolicies: [], sandboxes: [], permissionModes: [{ value: "plan", label: "Планирование" }] };
    if (command === "save_executor_settings") return;
    throw new Error(`неожиданная команда: ${command}`);
  });
  render(<ExecutorSettings workspace={workspace} />);
  await screen.findByText("Установите Codex");
  expect(screen.queryByLabelText("Модель")).toBeNull();
  choose("Исполнитель", "Claude Code");
  await screen.findByLabelText("Режим разрешений");
  choose("Режим разрешений", "Планирование");
  fireEvent.click(screen.getByRole("button", { name: "Проверить и сохранить параметры" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("save_executor_settings", {
    target: { workspaceId: "w1", sessionId: null, executor: "claude" }, settings: { ...defaults, permissionMode: "plan", workMode: "plan" },
  }));
  expect(screen.queryByLabelText("Запросы разрешений")).toBeNull();
});

test("параметры выполняющейся сессии доступны только для чтения", async () => {
  mockCommands();
  render(<ExecutorSettings workspace={workspace} session={{ id: "running", workspaceId: "w1", executor: "codex", title: "Задача", state: "running" }} />);
  await screen.findByLabelText("Модель");
  expect((screen.getByRole("button", { name: "Проверить и сохранить параметры" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/сначала остановите выбранную сессию/)).toBeTruthy();
});

test("новые элементы режима и ускорения сохраняют явные значения и возврат к настройкам исполнителя", async () => {
  mockCommands();
  render(<ExecutorSettings workspace={workspace} />);
  await screen.findByLabelText("Модель");
  choose("Модель", "Доступная модель");
  fireEvent.click(screen.getByRole("button", { name: "План" }));
  choose("Усилия рассуждения", "Высокие");
  fireEvent.click(screen.getByRole("switch", { name: "Быстрый режим" }));
  fireEvent.click(screen.getByRole("button", { name: "Проверить и сохранить параметры" }));
  await screen.findByText("Параметры проверены и сохранены для следующего запуска.");
  expect(invoke).toHaveBeenLastCalledWith("save_executor_settings", {
    target: { workspaceId: "w1", sessionId: null, executor: "codex" },
    settings: { ...defaults, model: "chosen", workMode: "plan", reasoningEffort: "high", fastMode: true },
  });
  fireEvent.click(screen.getByRole("switch", { name: "Быстрый режим" }));
  expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false");
  fireEvent.click(within(screen.getByRole("group", { name: "Режим работы" })).getByRole("button", { name: "По умолчанию" }));
  fireEvent.click(within(screen.getByRole("switch").closest<HTMLElement>(".conversation-settings-fast")!).getByRole("button", { name: "По умолчанию" }));
  choose("Усилия рассуждения", "Низкие");
  fireEvent.click(screen.getByRole("button", { name: "Проверить и сохранить параметры" }));
  await screen.findByText("Параметры проверены и сохранены для следующего запуска.");
  expect(invoke).toHaveBeenLastCalledWith("save_executor_settings", {
    target: { workspaceId: "w1", sessionId: null, executor: "codex" }, settings: { ...defaults, model: "chosen", reasoningEffort: "low" },
  });
});

test("списки модели и усилий содержат только явные значения", async () => {
  mockCommands();
  render(<ExecutorSettings workspace={workspace} />);
  await screen.findByLabelText("Модель");
  fireEvent.click(screen.getByLabelText("Модель"));
  expect(within(screen.getByRole("listbox", { name: "Модель" })).getAllByRole("option").map(item => item.textContent)).toEqual(["Доступная модель"]);
  fireEvent.click(screen.getByRole("option", { name: "Доступная модель" }));
  fireEvent.click(screen.getByLabelText("Усилия рассуждения"));
  expect(within(screen.getByRole("listbox", { name: "Усилия рассуждения" })).getAllByRole("option").map(item => item.textContent)).toEqual(["Низкие", "Высокие"]);
});
