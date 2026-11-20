// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import ShortcutSettings from "./ShortcutSettings";
import { defaultShortcuts, ShortcutProvider, shortcutsKey, useShortcutHandlers, useShortcuts } from "./shortcuts";

afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });

function Commands({ run }: { run: () => void }) {
  useShortcutHandlers({ projects: run });
  const { hint } = useShortcuts();
  return <input aria-label="Ввод терминала" title={hint("projects")} />;
}

function edit(command: string, key: string, code: string, modifiers = { metaKey: true }) {
  fireEvent.click(screen.getByRole("button", { name: `Изменить сочетание: ${command}` }));
  fireEvent.keyDown(screen.getByRole("textbox", { name: `Новое сочетание: ${command}` }), { key, code, ...modifiers });
}

test("назначение применяется сразу, переживает перезапуск и возвращается к исходному", () => {
  const run = vi.fn();
  const panel = () => <ShortcutProvider><ShortcutSettings /><Commands run={run} /></ShortcutProvider>;
  let view = render(panel());
  edit("Найти проект или пространство", "е", "KeyE");
  const terminal = screen.getByRole("textbox", { name: "Ввод терминала" });
  fireEvent.keyDown(terminal, { key: "k", code: "KeyK", metaKey: true });
  expect(run).not.toHaveBeenCalled();
  fireEvent.keyDown(terminal, { key: "у", code: "KeyE", metaKey: true });
  expect(run).toHaveBeenCalledOnce();
  expect(terminal.title).toContain("⌘E");
  view.unmount();
  view = render(panel());
  expect(screen.getByRole("textbox", { name: "Ввод терминала" }).title).toContain("⌘E");
  fireEvent.click(screen.getByRole("button", { name: "Вернуть по умолчанию: Найти проект или пространство" }));
  expect(JSON.parse(localStorage.getItem(shortcutsKey)!).projects).toBe("Meta+KeyK");
  fireEvent.keyDown(screen.getByRole("textbox", { name: "Ввод терминала" }), { key: "л", code: "KeyK", metaKey: true });
  expect(run).toHaveBeenCalledTimes(2);
});

test("конфликт меняет прежнюю команду только после явного переназначения; сброс также учитывает конфликт", () => {
  render(<ShortcutProvider><ShortcutSettings /></ShortcutProvider>);
  edit("Открыть настройки", "k", "KeyK");
  expect(screen.getByRole("alert").textContent).toContain("Найти проект или пространство");
  expect(JSON.parse(localStorage.getItem(shortcutsKey)!).projects).toBe("Meta+KeyK");
  fireEvent.click(screen.getByRole("button", { name: "Переназначить" }));
  expect(JSON.parse(localStorage.getItem(shortcutsKey)!)).toMatchObject({ projects: null, settings: "Meta+KeyK" });
  fireEvent.click(screen.getByRole("button", { name: "Вернуть по умолчанию: Найти проект или пространство" }));
  expect(screen.getByRole("alert").textContent).toContain("Открыть настройки");
  fireEvent.click(screen.getByRole("button", { name: "Переназначить" }));
  expect(JSON.parse(localStorage.getItem(shortcutsKey)!)).toMatchObject({ projects: "Meta+KeyK", settings: null });
  fireEvent.click(screen.getByRole("button", { name: "Сбросить все" }));
  expect(JSON.parse(localStorage.getItem(shortcutsKey)!)).toEqual(defaultShortcuts);
});

test("отключение, отмена записи, поиск по названию и нажатию сочетания", () => {
  render(<ShortcutProvider><ShortcutSettings /></ShortcutProvider>);
  fireEvent.click(screen.getByRole("button", { name: "Отключить сочетание: Открыть настройки" }));
  expect(within(screen.getByRole("region", { name: "Открыть настройки" })).getByText("Не назначено")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Изменить сочетание: Открыть настройки" }));
  fireEvent.keyDown(screen.getByRole("textbox", { name: "Новое сочетание: Открыть настройки" }), { key: "Escape" });
  expect(JSON.parse(localStorage.getItem(shortcutsKey)!).settings).toBeNull();
  const query = screen.getByRole("textbox", { name: "Найти команду или сочетание" });
  fireEvent.change(query, { target: { value: "Найти файл" } });
  expect(screen.getAllByRole("region")).toHaveLength(1);
  fireEvent.keyDown(query, { key: "л", code: "KeyK", metaKey: true });
  expect(screen.getByRole("region", { name: "Найти проект или пространство" })).toBeTruthy();
});

test("дополнительные модификаторы, удержание и составной ввод не запускают команду; терминальные команды проходят", () => {
  const run = vi.fn(), terminalInput = vi.fn();
  const { container } = render(<ShortcutProvider><div onKeyDown={terminalInput}><Commands run={run} /></div></ShortcutProvider>);
  const input = container.querySelector("input")!;
  for (const event of [{ shiftKey: true, metaKey: true }, { metaKey: true, isComposing: true }, { metaKey: true, repeat: true }, { ctrlKey: true }]) {
    fireEvent.keyDown(input, { key: "k", code: "KeyK", ...event });
  }
  fireEvent.keyDown(input, { key: "c", code: "KeyC", ctrlKey: true });
  expect(run).not.toHaveBeenCalled();
  expect(terminalInput).toHaveBeenCalledTimes(4);
  fireEvent.keyDown(input, { key: "л", code: "KeyK", metaKey: true });
  expect(run).toHaveBeenCalledOnce();
  expect(terminalInput).toHaveBeenCalledTimes(4);
});

test("диалог блокирует команды приложения", () => {
  const run = vi.fn();
  render(<ShortcutProvider><Commands run={run} /><dialog open><input aria-label="Поле диалога" /></dialog></ShortcutProvider>);
  fireEvent.keyDown(screen.getByRole("textbox", { name: "Поле диалога" }), { key: "k", code: "KeyK", metaKey: true });
  expect(run).not.toHaveBeenCalled();
});

test.each([
  ["q", "KeyQ", { metaKey: true }, "стандартной командой"],
  ["c", "KeyC", { ctrlKey: true }, "оставлено терминалу"],
  ["a", "KeyA", {}, "Добавьте"],
  ["Enter", "Enter", { metaKey: true }, "оставлено вводу"],
])("запись не принимает защищённое сочетание %s", (key, code, modifiers, message) => {
  render(<ShortcutProvider><ShortcutSettings /></ShortcutProvider>);
  fireEvent.click(screen.getByRole("button", { name: "Изменить сочетание: Открыть настройки" }));
  fireEvent.keyDown(screen.getByRole("textbox", { name: "Новое сочетание: Открыть настройки" }), { key, code, ...modifiers });
  expect(screen.getByRole("alert").textContent).toContain(message);
  expect(JSON.parse(localStorage.getItem(shortcutsKey)!).settings).toBe(defaultShortcuts.settings);
});

test("повреждённые сохранённые назначения не перехватывают ввод и системные команды", () => {
  localStorage.setItem(shortcutsKey, JSON.stringify({ projects: "Meta+KeyQ", newTab: "KeyT", settings: 42 }));
  render(<ShortcutProvider><ShortcutSettings /></ShortcutProvider>);
  expect(JSON.parse(localStorage.getItem(shortcutsKey)!)).toEqual(defaultShortcuts);
});

test("ошибка сохранения видима, настройка продолжает действовать до перезапуска", () => {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
  render(<ShortcutProvider><ShortcutSettings /></ShortcutProvider>);
  expect(screen.getByRole("alert").textContent).toContain("не сохранены");
});
