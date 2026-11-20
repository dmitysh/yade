// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import ConversationSettings from "./ConversationSettings";
import { defaults, type Catalog, type Settings } from "./ExecutorSettings";
import type { Session, Workspace } from "./types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const workspace = { id: "w", name: "Основное", path: "/project", operationState: "ready" } as Workspace;
const session: Session = { id: "s", workspaceId: "w", executor: "codex", title: "Чат", state: "ready" };
const catalog: Catalog = {
  models: [{ value: "chosen", label: "Модель", reasoningEfforts: ["low", "high"], supportsFastMode: true },
    { value: "other", label: "Другая модель", reasoningEfforts: ["low"] }],
  workModes: [{ value: "default", label: "Выполнение" }, { value: "plan", label: "План" }],
  approvalPolicies: [{ value: "on-request", label: "По запросу" }], sandboxes: [{ value: "read-only", label: "Только чтение" }],
  permissionModes: [], warnings: [],
};
const claudeCatalog: Catalog = { models: [{ value: "sonnet", label: "Sonnet", reasoningEfforts: ["medium"], supportsAutoMode: true }],
  workModes: catalog.workModes, approvalPolicies: [], sandboxes: [],
  permissionModes: [{ value: "default", label: "Стандартный" }, { value: "plan", label: "Планирование" }, { value: "auto", label: "Автоматическая проверка" }], warnings: [] };
function commands(initial: Settings = { ...defaults, model: "chosen" }, save?: (value: Settings) => Promise<void>, choices = catalog) {
  const stored = new Map<string, Settings>();
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    const { target, settings } = args as { target: { sessionId: string }; settings: Settings };
    if (command === "load_executor_settings") return stored.get(target.sessionId) ?? initial;
    if (command === "inspect_executor_settings") return choices;
    if (command === "save_executor_settings") { await save?.(settings); stored.set(target.sessionId, settings); return; }
    throw new Error(command);
  });
  return stored;
}
async function open() {
  fireEvent.click(screen.getByRole("button", { name: "Параметры диалога" }));
  await screen.findByLabelText("Модель");
  await waitFor(() => expect((screen.getByLabelText("Модель") as HTMLSelectElement).disabled).toBe(false));
}
async function saved() { await screen.findByText("Настройки сохранены для этого чата"); }
function choose(label: string, option: string) {
  fireEvent.click(screen.getByRole("combobox", { name: label }));
  fireEvent.click(screen.getByRole("option", { name: option }));
}

test("параметры сохраняются только в текущем разговоре и восстанавливаются после открытия", async () => {
  const stored = commands();
  const props = { workspace, session, disabled: false, saving: vi.fn() };
  const { unmount } = render(<ConversationSettings {...props} />);
  await open();
  fireEvent.click(screen.getByRole("button", { name: "План" })); await saved();
  choose("Усилия рассуждения", "Высокие"); await saved();
  fireEvent.click(screen.getByRole("switch", { name: "Быстрый режим" })); await saved();
  fireEvent.click(screen.getByText("Доступы", { exact: true }));
  choose("Запросы разрешений", "По запросу"); await saved();
  const expected = { ...defaults, model: "chosen", workMode: "plan", reasoningEffort: "high", fastMode: true, approvalPolicy: "on-request" };
  expect(invoke).toHaveBeenLastCalledWith("save_executor_settings", { target: { workspaceId: "w", sessionId: "s", executor: "codex" }, settings: expected });
  expect(stored.size).toBe(1);
  unmount(); render(<ConversationSettings {...props} />); await open();
  expect(screen.getByRole("switch", { name: "Быстрый режим" }).getAttribute("aria-checked")).toBe("true");
  expect(screen.getByLabelText("Усилия рассуждения").textContent).toBe("Высокие");
  fireEvent.click(screen.getByRole("button", { name: "Закрыть параметры диалога" }));
  fireEvent.click(screen.getByRole("button", { name: "Быстрый режим" }));
  await waitFor(() => expect(stored.get(session.id)?.fastMode).toBe(false));
});

test("смена модели сбрасывает несовместимые параметры и запрещает недоступное ускорение", async () => {
  commands({ ...defaults, model: "chosen", reasoningEffort: "high", fastMode: true });
  render(<ConversationSettings workspace={workspace} session={session} disabled={false} saving={vi.fn()} />);
  await open();
  choose("Модель", "Другая модель"); await saved();
  expect(invoke).toHaveBeenLastCalledWith("save_executor_settings", { target: { workspaceId: "w", sessionId: "s", executor: "codex" },
    settings: { ...defaults, model: "other" } });
  fireEvent.click(screen.getByLabelText("Усилия рассуждения"));
  expect(screen.queryByRole("option", { name: "Высокие" })).toBeNull();
  fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
  expect(screen.queryByRole("switch", { name: "Быстрый режим" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Быстрый режим" })).toBeNull();
});

test("ошибка сохранения возвращает прежнее значение, ожидание передаётся форме", async () => {
  let reject: (reason: Error) => void;
  commands(undefined, () => new Promise((_, fail) => { reject = fail; }));
  const saving = vi.fn();
  render(<ConversationSettings workspace={workspace} session={session} disabled={false} saving={saving} />);
  await open();
  choose("Усилия рассуждения", "Высокие");
  expect(saving).toHaveBeenLastCalledWith(true);
  expect((screen.getByLabelText("Модель") as HTMLSelectElement).disabled).toBe(true);
  await act(async () => reject(new Error("Модель отклонила параметры")));
  expect((await screen.findByRole("alert")).textContent).toContain("Параметры не сохранены");
  expect(screen.getByLabelText("Усилия рассуждения").textContent).toBe("По настройкам исполнителя");
  expect(screen.queryByText("Настройки сохранены для этого чата")).toBeNull();
  expect(saving).toHaveBeenLastCalledWith(false);
});

test("выполняющийся разговор не позволяет изменять настройки, Escape возвращает фокус", async () => {
  commands();
  render(<ConversationSettings workspace={workspace} session={{ ...session, state: "running" }} disabled saving={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Параметры диалога" }));
  await screen.findByLabelText("Модель");
  expect((screen.getByLabelText("Модель") as HTMLSelectElement).disabled).toBe(true);
  expect(screen.getByRole("button", { name: "План" }).closest("fieldset")?.disabled).toBe(true);
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Параметры диалога" }));
  expect(vi.mocked(invoke).mock.calls.some(([command]) => command === "save_executor_settings")).toBe(false);
});

test("Claude Code может выйти из унаследованного режима планирования", async () => {
  commands({ ...defaults, permissionMode: "plan" }, undefined, claudeCatalog);
  render(<ConversationSettings workspace={workspace} session={{ ...session, executor: "claude" }} disabled={false} saving={vi.fn()} />);
  await open();
  expect(screen.getByRole("button", { name: "План" }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Выполнение" })); await saved();
  expect(invoke).toHaveBeenLastCalledWith("save_executor_settings", { target: { workspaceId: "w", sessionId: "s", executor: "claude" },
    settings: { ...defaults, workMode: "default" } });
});

test("Escape сначала закрывает список и оставляет панель диалога открытой", async () => {
  commands();
  render(<ConversationSettings workspace={workspace} session={session} disabled={false} saving={vi.fn()} />);
  await open();
  fireEvent.click(screen.getByLabelText("Усилия рассуждения"));
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(screen.getByRole("dialog", { name: "Параметры диалога" })).toBeTruthy();
  expect(document.activeElement).toBe(screen.getByLabelText("Усилия рассуждения"));
  expect(vi.mocked(invoke).mock.calls.some(([command]) => command === "save_executor_settings")).toBe(false);
});

test("в выборе модели и усилий нет пустых вариантов, доступы сохраняют наследование", async () => {
  commands();
  render(<ConversationSettings workspace={workspace} session={session} disabled={false} saving={vi.fn()} />);
  await open();
  fireEvent.click(screen.getByLabelText("Модель"));
  expect(screen.getAllByRole("option").map(item => item.textContent)).toEqual(["Модель", "Другая модель"]);
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  fireEvent.click(screen.getByLabelText("Усилия рассуждения"));
  expect(screen.getAllByRole("option").map(item => item.textContent)).toEqual(["Низкие", "Высокие"]);
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  fireEvent.click(screen.getByText("Доступы", { exact: true }));
  fireEvent.click(screen.getByLabelText("Доступ к файлам"));
  expect(screen.getByRole("option", { name: "По настройкам исполнителя" })).toBeTruthy();
  expect(vi.mocked(invoke).mock.calls.some(([command]) => command === "save_executor_settings")).toBe(false);
});

test("каталог загружается при открытии разговора и не запрашивается при открытии панели", async () => {
  commands();
  render(<ConversationSettings workspace={workspace} session={session} disabled={false} saving={vi.fn()} />);
  await screen.findByRole("button", { name: "Модель" });
  expect(screen.queryByRole("button", { name: /^Усилия:/ })).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(invoke).toHaveBeenCalledWith("inspect_executor_settings", { target: { workspaceId: "w", sessionId: "s", executor: "codex" } });
  await open();
  fireEvent.click(screen.getByRole("button", { name: "Закрыть параметры диалога" }));
  await open();
  expect(vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === "inspect_executor_settings")).toHaveLength(1);
  expect(vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === "load_executor_settings")).toHaveLength(1);
  expect(screen.queryByText("Вопрос", { exact: true })).toBeNull();
  expect(screen.queryByText("Инструменты", { exact: true })).toBeNull();
  expect(screen.queryByText("Контекст", { exact: true })).toBeNull();
});

test("новый чат выбирает фактические параметры исполнителя без автоматического сохранения", async () => {
  commands(defaults, undefined, { ...catalog, defaultModel: "chosen", defaultReasoningEffort: "high" });
  render(<ConversationSettings workspace={workspace} session={session} disabled={false} saving={vi.fn()} />);
  await screen.findByRole("button", { name: "Модель" });
  await open();
  expect(screen.getByLabelText("Модель").textContent).toBe("Модель");
  expect(screen.getByLabelText("Усилия рассуждения").textContent).toBe("Высокие");
  expect(vi.mocked(invoke).mock.calls.some(([command]) => command === "save_executor_settings")).toBe(false);
  fireEvent.click(screen.getByRole("switch", { name: "Быстрый режим" })); await saved();
  expect(invoke).toHaveBeenLastCalledWith("save_executor_settings", {
    target: { workspaceId: "w", sessionId: "s", executor: "codex" },
    settings: { ...defaults, model: "chosen", reasoningEffort: "high", fastMode: true },
  });
});

test("явный выбор сохраняется, смена модели выбирает её собственные усилия по умолчанию", async () => {
  commands({ ...defaults, model: "other", reasoningEffort: "low" }, undefined, {
    ...catalog, defaultModel: "chosen", defaultReasoningEffort: "high",
    models: catalog.models.map(model => ({ ...model, defaultReasoningEffort: "low" })),
  });
  render(<ConversationSettings workspace={workspace} session={session} disabled={false} saving={vi.fn()} />);
  await open();
  expect(screen.getByLabelText("Модель").textContent).toBe("Другая модель");
  expect(screen.getByLabelText("Усилия рассуждения").textContent).toBe("Низкие");
  choose("Модель", "Модель"); await saved();
  expect(screen.getByLabelText("Усилия рассуждения").textContent).toBe("Высокие");
  choose("Модель", "Другая модель"); await saved();
  expect(screen.getByLabelText("Усилия рассуждения").textContent).toBe("Низкие");
});

test("Claude выбирает штатную модель и наследует нераскрытые исполнителем усилия", async () => {
  commands(defaults, undefined, { ...claudeCatalog, defaultModel: "default",
    models: [{ value: "default", label: "Штатная модель", reasoningEfforts: ["medium", "high"] }] });
  render(<ConversationSettings workspace={workspace} session={{ ...session, executor: "claude" }} disabled={false} saving={vi.fn()} />);
  await open();
  expect(screen.getByLabelText("Модель").textContent).toBe("Штатная модель");
  expect(screen.getByLabelText("Усилия рассуждения").textContent).toBe("По настройкам исполнителя");
  expect(vi.mocked(invoke).mock.calls.some(([command]) => command === "save_executor_settings")).toBe(false);
});

test("открытие панели во время предзагрузки использует тот же запрос", async () => {
  let finish: (value: Catalog) => void;
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === "load_executor_settings") return { ...defaults, model: "chosen" };
    if (command === "inspect_executor_settings") return new Promise<Catalog>(resolve => { finish = resolve; });
    throw new Error(command);
  });
  render(<ConversationSettings workspace={workspace} session={session} disabled={false} saving={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Параметры диалога" }));
  expect(screen.getByText("Загрузка параметров…")).toBeTruthy();
  await act(async () => finish(catalog));
  expect((screen.getByLabelText("Модель") as HTMLButtonElement).disabled).toBe(false);
  expect(vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === "inspect_executor_settings")).toHaveLength(1);
});

test("ошибка предзагрузки повторяется только по явной проверке", async () => {
  let attempts = 0;
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === "load_executor_settings") return defaults;
    if (command === "inspect_executor_settings") { if (++attempts === 1) throw new Error("CLI недоступен"); return catalog; }
    throw new Error(command);
  });
  render(<ConversationSettings workspace={workspace} session={session} disabled={false} saving={vi.fn()} />);
  await waitFor(() => expect(attempts).toBe(1));
  fireEvent.click(screen.getByRole("button", { name: "Параметры диалога" }));
  expect((await screen.findByRole("alert")).textContent).toContain("CLI недоступен");
  fireEvent.click(screen.getByRole("button", { name: "Повторить проверку" }));
  await screen.findByLabelText("Модель");
  expect(attempts).toBe(2);
});

test("поздний ответ другого исполнителя не подменяет каталог и выбранные параметры", async () => {
  let finish: (value: Catalog) => void;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    const { target } = args as { target: { executor: string } };
    if (command === "load_executor_settings") return { ...defaults, model: target.executor === "codex" ? "chosen" : "sonnet" };
    if (command === "inspect_executor_settings") return target.executor === "codex" ? new Promise<Catalog>(resolve => { finish = resolve; }) : claudeCatalog;
    if (command === "save_executor_settings") return;
    throw new Error(command);
  });
  const props = { workspace, session, disabled: false, saving: vi.fn() };
  const { rerender } = render(<ConversationSettings {...props} />);
  rerender(<ConversationSettings {...props} session={{ ...session, id: "claude-chat", executor: "claude" }} />);
  await open();
  await act(async () => finish(catalog));
  expect(screen.getByLabelText("Модель").textContent).toBe("Sonnet");
  choose("Модель", "Sonnet");
  await saved();
  fireEvent.click(screen.getByLabelText("Усилия рассуждения"));
  expect(screen.getAllByRole("option").map(option => option.textContent)).toEqual(["Средние"]);
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(screen.queryByRole("switch", { name: "Быстрый режим" })).toBeNull();
  fireEvent.click(screen.getByText("Доступы", { exact: true }));
  expect(screen.queryByLabelText("Запросы разрешений")).toBeNull();
  expect(screen.queryByLabelText("Доступ к файлам")).toBeNull();
  expect(screen.getByLabelText("Режим разрешений")).toBeTruthy();
});

test("модель без дополнительных возможностей не показывает усилия и ускорение", async () => {
  commands({ ...defaults, model: "plain" }, undefined, { ...claudeCatalog, models: [{ value: "plain", label: "Обычная модель" }], workModes: [] });
  render(<ConversationSettings workspace={workspace} session={{ ...session, executor: "claude" }} disabled={false} saving={vi.fn()} />);
  await open();
  expect(screen.queryByLabelText("Усилия рассуждения")).toBeNull();
  expect(screen.queryByRole("group", { name: "Режим работы" })).toBeNull();
  expect(screen.queryByRole("switch")).toBeNull();
  fireEvent.click(screen.getByText("Доступы", { exact: true }));
  fireEvent.click(screen.getByLabelText("Режим разрешений"));
  expect(screen.queryByRole("option", { name: "Автоматическая проверка" })).toBeNull();
});

test("смена модели сбрасывает автоматические разрешения, если новая модель их не поддерживает", async () => {
  commands({ ...defaults, model: "sonnet", permissionMode: "auto" }, undefined,
    { ...claudeCatalog, models: [...claudeCatalog.models, { value: "plain", label: "Обычная модель" }] });
  render(<ConversationSettings workspace={workspace} session={{ ...session, executor: "claude" }} disabled={false} saving={vi.fn()} />);
  await open();
  choose("Модель", "Обычная модель");
  await saved();
  expect(invoke).toHaveBeenLastCalledWith("save_executor_settings", {
    target: { workspaceId: "w", sessionId: "s", executor: "claude" }, settings: { ...defaults, model: "plain" },
  });
});
