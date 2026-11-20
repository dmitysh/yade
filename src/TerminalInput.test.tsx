// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import TerminalInput from "./TerminalInput";
import type { ShellEditor } from "./terminalShell";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
beforeEach(() => vi.mocked(invoke).mockImplementation(async (_name, args) => ({ ...(args as object), suggestion: "", commandKnown: false })));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
function setup() {
  const submit = vi.fn(async (_command: string) => {}), interrupt = vi.fn(), report = vi.fn();
  const props = { workspaceId: "w1", id: "t1", cwd: "/project", active: true, submit, interrupt, report, restore: null, searchHistory: vi.fn(async () => true) };
  const panel = render(<TerminalInput {...props} />);
  return { input: screen.getByRole("textbox", { name: "Команда терминала" }) as HTMLTextAreaElement, panel, props, submit, interrupt, report };
}
test("Ctrl+R сохраняет черновик, если оболочка не приняла его", async () => {
  vi.mocked(invoke).mockRejectedValue(new Error("черновик не принят"));
  const { input, props, report } = setup();
  fireEvent.change(input, { target: { value: "черновик" } });
  fireEvent.keyDown(input, { key: "r", ctrlKey: true });
  expect(input.readOnly).toBe(true);
  await waitFor(() => expect(input.readOnly).toBe(false));
  expect(report).toHaveBeenCalled();
  expect(props.searchHistory).not.toHaveBeenCalled();
  expect(input.value).toBe("черновик");
});

test("ответы zsh сохраняют выделение; Shift+стрелки и копирование остаются обычным редактированием", async () => {
  const { input, submit, interrupt } = setup();
  fireEvent.change(input, { target: { value: "printf hello", selectionStart: 12 } });
  input.setSelectionRange(7, 12);
  fireEvent.select(input);
  await waitFor(() => expect(invoke).toHaveBeenLastCalledWith("edit_terminal", expect.objectContaining({ command: "printf hello", cursor: 7 })));
  await act(async () => {});
  expect([input.selectionStart, input.selectionEnd]).toEqual([7, 12]);
  expect(fireEvent.keyDown(input, { key: "ArrowUp", shiftKey: true })).toBe(true);
  expect(fireEvent.keyDown(input, { key: "c", ctrlKey: true })).toBe(true);
  expect(interrupt).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: "printf replacement", selectionStart: 18 } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(submit).toHaveBeenCalledWith("printf replacement"));
});
test("Tab принимает результат zsh, удерживает фокус и не запускает команду", async () => {
  vi.mocked(invoke).mockImplementation(async (_name, args) => {
    const value = args as Record<string, unknown>;
    return { ...value, command: value.action === "complete" ? "git status" : value.command, cursor: value.action === "complete" ? 10 : value.cursor, suggestion: value.command === "git st" && value.action === "change" ? "atus" : "" };
  });
  const { input, submit, panel } = setup();
  fireEvent.change(input, { target: { value: "git st", selectionStart: 6 } });
  await waitFor(() => expect(panel.container.querySelector(".terminal-input-suggestion")?.textContent).toBe("atus"));
  expect(fireEvent.keyDown(input, { key: "Tab" })).toBe(false);
  await waitFor(() => expect(input.value).toBe("git status"));
  expect(document.activeElement).toBe(input);
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(submit).not.toHaveBeenCalled();
});

test("подсказка zsh остаётся видимой при перемещении курсора внутри команды", async () => {
  vi.mocked(invoke).mockImplementation(async (_name, args) => ({ ...(args as object), suggestion: "atus" }));
  const { input, panel } = setup();
  fireEvent.change(input, { target: { value: "git st", selectionStart: 6 } });
  await waitFor(() => expect(panel.container.querySelector(".terminal-input-suggestion")?.textContent).toBe("atus"));
  input.setSelectionRange(3, 3); fireEvent.select(input);
  expect(panel.container.querySelector(".terminal-input-suggestion")?.textContent).toBe("atus");
  await waitFor(() => expect(invoke).toHaveBeenLastCalledWith("edit_terminal", expect.objectContaining({ cursor: 3 })));
  await waitFor(() => expect(panel.container.querySelector(".terminal-input-suggestion")?.textContent).toBe("atus"));
  expect([input.selectionStart, input.selectionEnd]).toEqual([3, 3]);
});

test("быстрый набор, удаление и повторный префикс не теряют последнюю подсказку", async () => {
  vi.mocked(invoke).mockImplementation(async (_name, args) => {
    const value = args as Record<string, unknown>;
    await new Promise(resolve => setTimeout(resolve, value.command === "g" ? 50 : 5));
    const command = String(value.command);
    return { ...value, suggestion: command && "git status".startsWith(command) ? "git status".slice(command.length) : "" };
  });
  const { input, panel } = setup();
  fireEvent.change(input, { target: { value: "g", selectionStart: 1 } });
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("edit_terminal", expect.objectContaining({ command: "g" })));
  for (const value of ["gi", "git st", "git sta", "git stat", "git st", "", "g", "gi", "git st"]) {
    fireEvent.change(input, { target: { value, selectionStart: value.length } });
  }
  await waitFor(() => expect(panel.container.querySelector(".terminal-input-suggestion")?.textContent).toBe("atus"));
  expect(input.value).toBe("git st");
});
test("поздний ответ дополнения не затирает более свежий текст и выделение", async () => {
  let finish!: (value: ShellEditor) => void;
  vi.mocked(invoke).mockImplementation(async (_name, args) => {
    const value = args as Record<string, unknown>;
    if (value.action === "complete") return new Promise(resolve => { finish = resolve; });
    return { ...value, suggestion: "" };
  });
  const { input } = setup();
  fireEvent.change(input, { target: { value: "git st", selectionStart: 6 } });
  fireEvent.keyDown(input, { key: "Tab" });
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  const request = Number((vi.mocked(invoke).mock.calls.at(-1)![1] as Record<string, unknown>).request);
  fireEvent.change(input, { target: { value: "printf edited", selectionStart: 13 } });
  input.setSelectionRange(7, 13); fireEvent.select(input);
  await act(async () => finish({ request, command: "git status", cursor: 10, suggestion: "", commandKnown: true }));
  expect(input.value).toBe("printf edited");
  expect([input.selectionStart, input.selectionEnd]).toEqual([7, 13]);
  expect(document.querySelector('.terminal-executable')).toBeNull();
});

test("зелёная подсветка зависит от проверки в оболочке и сбрасывается сразу при изменении текста", async () => {
  let finish!: (value: ShellEditor) => void;
  vi.mocked(invoke).mockImplementation(async (_name, args) => {
    const value = args as Record<string, unknown>;
    if (value.command === "codfdsfasf") return new Promise(resolve => { finish = resolve; });
    return { ...value, suggestion: "", commandKnown: value.command === "cod" };
  });
  const { input, panel, submit } = setup();
  fireEvent.change(input, { target: { value: "cod", selectionStart: 3 } });
  await waitFor(() => expect(panel.container.querySelector('.terminal-executable')?.textContent).toBe("cod"));
  fireEvent.change(input, { target: { value: "codfdsfasf", selectionStart: 10 } });
  expect(panel.container.querySelector('.terminal-executable')).toBeNull();
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  const request = Number((vi.mocked(invoke).mock.calls.at(-1)![1] as Record<string, unknown>).request);
  await act(async () => finish({ request, command: "codfdsfasf", cursor: 10, suggestion: "", commandKnown: false }));
  expect(panel.container.querySelector('.terminal-executable')).toBeNull();
  expect(submit).not.toHaveBeenCalled();
});
test("Enter ждёт дополнение, а многострочная вставка, Shift+Enter и IME ничего не запускают", async () => {
  const { input, submit } = setup();
  fireEvent.change(input, { target: { value: "printf first\nprintf second", selectionStart: 26 } });
  fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
  fireEvent.keyDown(input, { key: "Enter", isComposing: true });
  expect(submit).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(submit).toHaveBeenCalledWith("printf first\nprintf second"));
});

test("поздний ответ запуска не стирает возвращённую команду и её выделение", async () => {
  const { input, submit, panel, props } = setup();
  let finish!: () => void;
  submit.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  fireEvent.change(input, { target: { value: "printf first", selectionStart: 12 } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(submit).toHaveBeenCalled());
  panel.rerender(<TerminalInput {...props} restore={{ command: "printf restored", request: 1 }} />);
  await waitFor(() => expect(input.value).toBe("printf restored"));
  input.setSelectionRange(7, 15); fireEvent.select(input);
  await act(async () => finish());
  expect(input.value).toBe("printf restored");
  expect([input.selectionStart, input.selectionEnd]).toEqual([7, 15]);
});

test("событие выделения старого текста не отменяет очистку по Ctrl+C", async () => {
  const { input, interrupt } = setup();
  fireEvent.change(input, { target: { value: "printf original", selectionStart: 15 } });
  act(() => {
    fireEvent.keyDown(input, { key: "c", ctrlKey: true });
    input.setSelectionRange(0, 15); fireEvent.select(input);
  });
  await waitFor(() => expect(input.value).toBe(""));
  await waitFor(() => expect(interrupt).toHaveBeenCalledOnce());
});
