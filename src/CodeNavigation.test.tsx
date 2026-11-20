// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import CodeNavigation from "./CodeNavigation";
import CodeEditor from "./CodeEditor";
import { activeEditor, codeWorkspace, recordNavigation } from "./codeIntelligence";
import type { FileMatch } from "./types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class { onmessage = (_message: unknown) => {}; } }));
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLElement.prototype.scrollIntoView = () => {};
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

test("двойной Shift открывает поиск с недавними файлами, сохраняет запрос между вкладками и выбирает с клавиатуры", async () => {
  vi.mocked(invoke).mockResolvedValue(["src/CodeEditor.tsx", "src/Conversations.tsx", "README.md"]);
  const open = vi.fn(async () => {});
  recordNavigation("quick-open-check", { path: "src/Conversations.tsx", line: 10, column: 1 }, null);
  render(<CodeNavigation workspaceId="quick-open-check" open={open} />);
  fireEvent.keyDown(window, { key: "Shift", code: "ShiftLeft" });
  fireEvent.keyUp(window, { key: "Shift", code: "ShiftLeft" });
  fireEvent.keyDown(window, { key: "Shift", code: "ShiftLeft" });
  const dialog = screen.getByRole("dialog", { name: "Поиск по проекту" });
  const input = within(dialog).getByRole("combobox", { name: "Поисковый запрос" });
  const results = within(within(dialog).getByRole("listbox", { name: "Результаты поиска" }));
  expect(document.activeElement).toBe(input);
  await results.findByRole("option", { name: /Conversations/ });
  expect(results.getAllByRole("option")[0].textContent).toContain("Conversations.tsx");
  fireEvent.click(within(dialog).getByRole("tab", { name: "Файлы" }));
  const search = screen.getByRole("combobox", { name: "Поисковый запрос" });
  await screen.findByRole("option", { name: /CodeEditor/ });
  fireEvent.change(search, { target: { value: "CdEd" } });
  fireEvent.click(within(dialog).getByRole("tab", { name: "Всё" }));
  expect((search as HTMLInputElement).value).toBe("CdEd");
  fireEvent.click(within(dialog).getByRole("tab", { name: "Файлы" }));
  expect(results.getAllByRole("option")).toHaveLength(1);
  fireEvent.keyDown(search, { key: "ArrowDown" });
  expect(search.getAttribute("aria-activedescendant")).toBe("code-result-0");
  fireEvent.submit(search.closest("form")!);
  await waitFor(() => expect(open).toHaveBeenCalledWith("src/CodeEditor.tsx", expect.objectContaining({ line: 1, column: 1 })));
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("общий поиск показывает файлы и текст, текстовые фильтры и область сохраняются в запросе", async () => {
  const open = vi.fn(async () => {});
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === "list_source_files") return ["notes.md", "archive.md"];
    if (command === "search_files") return { matches: [{ path: "notes.md", line: 4, column: 3, text: "🦀 Notes здесь", matched: "Notes" }], truncated: false };
    throw new Error(String(command));
  });
  render(<CodeNavigation workspaceId="search-project" open={open} activeFile="notes.md" openFiles={["notes.md"]} />);
  fireEvent.click(screen.getByRole("button", { name: /Поиск по проекту/ }));
  const input = screen.getByRole("combobox", { name: "Поисковый запрос" });
  fireEvent.change(input, { target: { value: "notes" } });
  await screen.findByRole("option", { name: /notes\.md$/i });
  await screen.findByRole("option", { name: /Notes здесь/ });
  fireEvent.keyDown(input, { key: "4", code: "Digit4", altKey: true });
  expect(screen.getByRole("tab", { name: "Текст" }).getAttribute("aria-selected")).toBe("true");
  fireEvent.change(screen.getByRole("combobox", { name: "Область поиска" }), { target: { value: "open" } });
  fireEvent.click(screen.getByRole("button", { name: "Регулярное выражение" }));
  fireEvent.change(screen.getByLabelText("Маска файлов"), { target: { value: "*.md" } });
  fireEvent.change(input, { target: { value: "N.*s" } });
  const result = await screen.findByRole("option", { name: /Notes здесь/ });
  expect(invoke).toHaveBeenLastCalledWith("search_files", { workspaceId: "search-project", query: "N.*s",
    options: { matchCase: false, wholeWord: false, regexp: true, mask: "*.md", paths: ["notes.md"] } });
  expect(result.querySelector("mark")?.textContent).toBe("Notes");
  fireEvent.submit(input.closest("form")!);
  await waitFor(() => expect(open).toHaveBeenCalledWith("notes.md", expect.objectContaining({
    line: 4, column: 3, text: "🦀 Notes здесь", query: "Notes",
  })));
});

test("запоздавший текстовый поиск не подменяет результаты последнего запроса", async () => {
  const open = vi.fn(async () => {});
  let resolveOld!: (result: { matches: FileMatch[]; truncated: boolean }) => void;
  const old = new Promise(resolve => { resolveOld = resolve; });
  const hit = (text: string) => ({ matches: [{ path: "notes.md", line: 2, column: 1, text, matched: text }], truncated: false });
  vi.mocked(invoke).mockImplementation(async (command, args: any) => {
    if (command === "search_files") return args.query === "старый" ? old : hit("текущий");
    throw new Error(String(command));
  });
  render(<CodeNavigation workspaceId="search-race" open={open} />);
  act(() => codeWorkspace("search-race").request?.("text"));
  const input = screen.getByRole("combobox", { name: "Поисковый запрос" });
  fireEvent.change(input, { target: { value: "старый" } });
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("search_files", expect.objectContaining({ query: "старый" })));
  fireEvent.change(input, { target: { value: "текущий" } });
  await screen.findByRole("option", { name: /текущий/ });
  await act(async () => resolveOld(hit("старый")));
  expect(screen.queryByRole("option", { name: /старый/ })).toBeNull();
  fireEvent.submit(input.closest("form")!);
  await waitFor(() => expect(open).toHaveBeenCalledWith("notes.md", expect.objectContaining({ query: "текущий" })));
});

test("список переходов показывает код рядом с символом, закрывается снаружи и открывает выбранную строку", async () => {
  const workspaceId = "targets-navigation-check", open = vi.fn(async () => {});
  render(<><CodeNavigation workspaceId={workspaceId} open={open} /><CodeEditor workspaceId={workspaceId} path="notes.txt" body="Format(value)" disabled={false} change={() => {}} save={() => {}} /></>);
  const editor = activeEditor(workspaceId)!;
  vi.spyOn(editor, "coordsAtPos").mockReturnValue({ left: 400, right: 440, top: 200, bottom: 218 });
  const items = [
    { path: "first.go", name: "first.go", line: 12, column: 3, code: "return Format(value)" },
    { path: "second.go", name: "second.go", line: 28, column: 5, code: "result := Format(other)" },
  ];
  act(() => codeWorkspace(workspaceId).request?.("symbols", items, "Использования · Format"));
  let dialog = screen.getByRole("dialog", { name: "Использования · Format" });
  expect(dialog.style.left).toBe("400px");
  expect(dialog.style.top).toBe("224px");
  expect(within(dialog).getByRole("option", { name: /return Format\(value\)/ }).title).toBe("first.go:12:3");
  fireEvent.pointerDown(dialog);
  expect(screen.queryByRole("dialog")).toBeNull();
  act(() => codeWorkspace(workspaceId).request?.("symbols", items, "Использования · Format"));
  dialog = screen.getByRole("dialog", { name: "Использования · Format" });
  const input = within(dialog).getByRole("combobox");
  fireEvent.keyDown(input, { key: "ArrowDown" });
  fireEvent.submit(input.closest("form")!);
  await waitFor(() => expect(open).toHaveBeenCalledWith("second.go", expect.objectContaining({ line: 28, column: 5 })));
  expect(editor.state.sliceDoc()).toBe("Format(value)");
});

test("переход к строке проверяет ввод, а история не меняет отступы", async () => {
  const workspaceId = "line-navigation-check", open = vi.fn(async () => {});
  render(<><CodeNavigation workspaceId={workspaceId} open={open} /><CodeEditor workspaceId={workspaceId} path="notes.txt" body={"first\nsecond\nthird"} disabled={false} change={() => {}} save={() => {}} /></>);
  fireEvent.keyDown(screen.getByRole("textbox", { name: "Код notes.txt" }), { key: "l", code: "KeyL", metaKey: true });
  const input = screen.getByRole("textbox", { name: "Строка и столбец" });
  expect(document.activeElement).toBe(input);
  fireEvent.change(input, { target: { value: "99" } });
  fireEvent.click(screen.getByRole("button", { name: "Перейти" }));
  await screen.findByRole("alert");
  expect(open).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: "2:3" } });
  fireEvent.click(screen.getByRole("button", { name: "Перейти" }));
  await waitFor(() => expect(open).toHaveBeenCalledWith("notes.txt", expect.objectContaining({ line: 2, column: 3, utf16: true })));
  const view = activeEditor(workspaceId)!;
  recordNavigation(workspaceId, { path: "other.txt", line: 1, column: 1 });
  fireEvent.keyDown(view.contentDOM, { key: "[", code: "BracketLeft", metaKey: true });
  await waitFor(() => expect(open).toHaveBeenLastCalledWith("notes.txt", expect.objectContaining({ line: 1, column: 1 })));
  expect(view.state.sliceDoc()).toBe("first\nsecond\nthird");
  expect(codeWorkspace(workspaceId).index).toBe(0);
});

test("сочетание для открытия файла не перехватывает ввод в другом диалоге", () => {
  render(<><CodeNavigation workspaceId="dialog-isolation-check" open={vi.fn()} /><dialog open aria-label="Настройки"><input aria-label="Параметр" /></dialog></>);
  fireEvent.keyDown(screen.getByLabelText("Параметр"), { key: "O", code: "KeyO", metaKey: true, shiftKey: true });
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  expect(invoke).not.toHaveBeenCalled();
});

test("недостающая поддержка устанавливается только по кнопке, ошибка не блокирует редактор", async () => {
  const workspaceId = "missing-language-check";
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === "language_tools") return [{ language: "go", available: false, prerequisite: null }];
    if (command === "install_language_tool") throw new Error("сеть недоступна");
    throw new Error(String(command));
  });
  render(<><CodeNavigation workspaceId={workspaceId} open={vi.fn()} /><CodeEditor workspaceId={workspaceId} path="main.go" body={"package main\n"} disabled={false} change={() => {}} save={() => {}} /></>);
  const install = await screen.findByRole("button", { name: "Установить поддержку языка" });
  expect(invoke).not.toHaveBeenCalledWith("install_language_tool", expect.anything());
  expect(screen.getByRole("alert").textContent).toContain("Поддержка Go не установлена");
  fireEvent.click(screen.getByRole("button", { name: "Закрыть сообщение навигации" }));
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("button", { name: "Установить поддержку языка" })).toBe(install);
  fireEvent.click(install);
  await screen.findByText(/сеть недоступна/);
  expect(invoke).toHaveBeenCalledWith("install_language_tool", { language: "go" });
  fireEvent.click(screen.getByRole("button", { name: "Закрыть сообщение навигации" }));
  expect(screen.queryByRole("alert")).toBeNull();
  fireEvent.click(install);
  await screen.findByText(/сеть недоступна/);
  expect(activeEditor(workspaceId)!.state.readOnly).toBe(false);
  expect(activeEditor(workspaceId)!.state.sliceDoc()).toBe("package main\n");
});

test("открытие файла TypeScript не запрашивает доверие, пока пользователь не подключит навигацию", async () => {
  const workspaceId = "typescript-trust-check", body = "export const value = 1;\n";
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === "language_tools") return [{ language: "typescript", available: true, prerequisite: null }];
    if (command === "start_language_server") return null;
    throw new Error(String(command));
  });
  render(<><CodeNavigation workspaceId={workspaceId} open={vi.fn()} /><CodeEditor workspaceId={workspaceId} path="index.ts" body={body} disabled={false} change={() => {}} save={() => {}} /></>);
  const connect = await screen.findByRole("button", { name: "Подключить навигацию" });
  expect(invoke).toHaveBeenCalledWith("start_language_server", expect.objectContaining({ workspaceId, language: "typescript", confirmTrust: false }));
  expect(invoke).not.toHaveBeenCalledWith("start_language_server", expect.objectContaining({ confirmTrust: true }));
  fireEvent.click(connect);
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("start_language_server", expect.objectContaining({ workspaceId, confirmTrust: true })));
  expect(await screen.findByRole("button", { name: "Подключить навигацию" })).toBeTruthy();
  expect(activeEditor(workspaceId)!.state.readOnly).toBe(false);
  expect(activeEditor(workspaceId)!.state.sliceDoc()).toBe(body);
});
