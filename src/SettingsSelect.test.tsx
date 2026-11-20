// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import SettingsSelect from "./SettingsSelect";

afterEach(cleanup);
const choices = [{ value: "read-only", label: "Только чтение" }, { value: "workspace-write", label: "Запись в пространстве" }];

test("список отмечает выбор, возвращает исходную настройку и не отправляет форму", () => {
  const change = vi.fn(), submit = vi.fn();
  render(<form onSubmit={submit}><SettingsSelect label="Доступ к файлам" value="read-only" choices={choices} change={change} /></form>);
  fireEvent.click(screen.getByRole("combobox", { name: "Доступ к файлам" }));
  expect(screen.getByRole("option", { name: "Только чтение" }).getAttribute("aria-selected")).toBe("true");
  expect(document.activeElement).toBe(screen.getByRole("option", { name: "Только чтение" }));
  fireEvent.click(screen.getByRole("option", { name: "По настройкам исполнителя" }));
  expect(change).toHaveBeenCalledWith(null);
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole("combobox"));
  expect(submit).not.toHaveBeenCalled();
});

test("стрелки перемещают фокус, Escape закрывает только список", () => {
  const change = vi.fn(), escape = vi.fn();
  render(<div onKeyDown={escape}><SettingsSelect label="Доступ к файлам" value={null} choices={choices} change={change} /></div>);
  fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowDown" });
  fireEvent.keyDown(document.activeElement!, { key: "End" });
  expect(document.activeElement).toBe(screen.getByRole("option", { name: "Запись в пространстве" }));
  fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
  expect(document.activeElement).toBe(screen.getByRole("option", { name: "Только чтение" }));
  escape.mockClear();
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(escape).not.toHaveBeenCalled();
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole("combobox"));
  expect(change).not.toHaveBeenCalled();
});

test("внешнее нажатие закрывает список, блокировка и неизвестное значение сохраняются", () => {
  const change = vi.fn();
  const { rerender } = render(<SettingsSelect label="Доступ к файлам" value="unknown" choices={choices} change={change} />);
  expect(screen.getByRole("combobox").textContent).toBe("unknown — недоступно");
  fireEvent.click(screen.getByRole("combobox"));
  const unavailable = screen.getByRole("option", { name: "unknown — недоступно" }) as HTMLButtonElement;
  expect(unavailable.disabled).toBe(true);
  fireEvent.click(unavailable);
  fireEvent.keyDown(document.activeElement!, { key: "End" });
  expect(document.activeElement).toBe(screen.getByRole("option", { name: "Запись в пространстве" }));
  expect(change).not.toHaveBeenCalled();
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole("listbox")).toBeNull();
  rerender(<SettingsSelect label="Доступ к файлам" value="unknown" choices={choices} disabled change={change} />);
  fireEvent.click(screen.getByRole("combobox"));
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(change).not.toHaveBeenCalled();
});

test("список без пустого варианта показывает подсказку и передаёт только явное значение", () => {
  const change = vi.fn();
  render(<SettingsSelect label="Доступ к файлам" value={null} choices={choices} allowDefault={false} placeholder="Выберите доступ" change={change} />);
  expect(screen.getByRole("combobox").textContent).toBe("Выберите доступ");
  fireEvent.click(screen.getByRole("combobox"));
  expect(screen.getAllByRole("option")).toHaveLength(2);
  expect(screen.queryByRole("option", { name: "Выберите доступ" })).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole("option", { name: "Только чтение" }));
  fireEvent.click(screen.getByRole("option", { name: "Только чтение" }));
  expect(change).toHaveBeenCalledWith("read-only");
});

test("обязательный выбор останавливает отправку формы и открывает список", () => {
  const change = vi.fn(), submit = vi.fn(event => event.preventDefault());
  const { rerender } = render(<form onSubmit={submit}><SettingsSelect label="Ответ" value={null} choices={choices} required hideLabel change={change} /><button>Отправить</button></form>);
  fireEvent.click(screen.getByRole("button", { name: "Отправить" }));
  expect(submit).not.toHaveBeenCalled();
  expect(screen.getByRole("combobox", { name: "Ответ" }).getAttribute("aria-required")).toBe("true");
  expect(screen.getByRole("listbox", { name: "Ответ" })).toBeTruthy();
  fireEvent.click(screen.getByRole("option", { name: "Только чтение" }));
  expect(change).toHaveBeenCalledWith("read-only");
  rerender(<form onSubmit={submit}><SettingsSelect label="Ответ" value="read-only" choices={choices} required hideLabel change={change} /><button>Отправить</button></form>);
  fireEvent.click(screen.getByRole("button", { name: "Отправить" }));
  expect(submit).toHaveBeenCalledOnce();
});

test("корневой репозиторий с пустым путём остаётся доступным вариантом", () => {
  const change = vi.fn();
  render(<SettingsSelect label="Репозиторий" value="nested" choices={[{ value: "", label: "." }, { value: "nested", label: "nested" }]} allowDefault={false} change={change} />);
  fireEvent.click(screen.getByRole("combobox", { name: "Репозиторий" }));
  fireEvent.click(screen.getByRole("option", { name: "." }));
  expect(change).toHaveBeenCalledWith(null);
});

test("поиск фильтрует варианты, стрелки выбирают результат, Escape сохраняет форму", () => {
  const change = vi.fn(), submit = vi.fn(), escape = vi.fn();
  render(<form onSubmit={submit} onKeyDown={escape}><SettingsSelect label="Ветка" value={null} choices={choices} allowDefault={false} search="Найти ветку" change={change} /></form>);
  fireEvent.click(screen.getByRole("combobox"));
  const input = screen.getByRole("textbox", { name: "Найти ветку" });
  expect(document.activeElement).toBe(input);
  fireEvent.change(input, { target: { value: "ЗАПИСЬ" } });
  expect(screen.queryByRole("option", { name: "Только чтение" })).toBeNull();
  fireEvent.keyDown(input, { key: "Enter" });
  expect(submit).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: "ArrowUp" });
  expect(document.activeElement).toBe(screen.getByRole("option", { name: "Запись в пространстве" }));
  fireEvent.click(document.activeElement!);
  expect(change).toHaveBeenCalledWith("workspace-write");
  fireEvent.click(screen.getByRole("combobox"));
  expect(screen.getAllByRole("option")).toHaveLength(2);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "нет совпадений" } });
  expect(screen.getByRole("status").textContent).toBe("Ничего не найдено");
  escape.mockClear();
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(escape).not.toHaveBeenCalled();
});
