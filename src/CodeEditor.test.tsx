// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import CodeEditor, { Comparison } from "./CodeEditor";
import { AppearanceProvider, useAppearance } from "./appearance";
import { syntaxTree } from "@codemirror/language";
import { vscodeTheme } from "./test-fixtures/editorTheme";
import { importEditorTheme } from "./editorThemes";
import { ShortcutProvider, useShortcuts } from "./shortcuts";
import { loadFileLanguage } from "./fileLanguages";

beforeAll(() => {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); localStorage.clear(); });

test.each([false, true])("⌘+клик открывает ссылку без изменения текста в режиме чтения %s", async disabled => {
  const body = "Для UZ: [стейджинг](http://dashboards.staging.example.test:5601/),";
  const open = vi.spyOn(window, "open").mockReturnValue(null), change = vi.fn();
  const { container } = render(<CodeEditor path="notes.md" workspaceId="editor-links" body={body} disabled={disabled} change={change} save={vi.fn()} />);
  const editor = EditorView.findFromDOM(container.querySelector(".cm-editor")!)!;
  await waitFor(() => expect(syntaxTree(editor.state).toString()).toContain("Link("));
  vi.spyOn(editor, "posAtCoords").mockReturnValue(body.indexOf("стейджинг") + 1);
  const selection = editor.state.selection;
  fireEvent.mouseDown(editor.contentDOM, { button: 0, metaKey: true });
  expect(open).toHaveBeenCalledExactlyOnceWith("http://dashboards.staging.example.test:5601/", "_blank", "noopener,noreferrer");
  expect(editor.state.selection).toBe(selection);
  expect(editor.state.sliceDoc()).toBe(body);
  expect(change).not.toHaveBeenCalled();
});

test("ссылки открываются только с модификатором, в том числе после редактирования и в сравнении", () => {
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  const { container } = render(<><CodeEditor path="notes.txt" body="https://old.test/" disabled={false} change={vi.fn()} save={vi.fn()} /><Comparison path="notes.txt" a="https://before.test/" b="https://after.test/" /></>);
  const editors = [...container.querySelectorAll<HTMLElement>(".cm-editor")].map(dom => EditorView.findFromDOM(dom)!);
  act(() => editors[0].dispatch({ changes: { from: 0, to: editors[0].state.doc.length, insert: "https://edited.test/" } }));
  for (const editor of editors) {
    vi.spyOn(editor, "posAtCoords").mockReturnValue(10);
    fireEvent.mouseDown(editor.contentDOM, { button: 0 });
    fireEvent.mouseDown(editor.contentDOM, { button: 1, metaKey: true });
    expect(open).not.toHaveBeenCalled();
  }
  for (const editor of editors) fireEvent.mouseDown(editor.contentDOM, { button: 0, ctrlKey: true });
  expect(open.mock.calls.map(call => call[0])).toEqual(["https://edited.test/", "https://before.test/", "https://after.test/"]);
});

test("переназначение и отключение сохранения меняют работающий редактор без потери текста и выделения", () => {
  const save = vi.fn();
  function Settings() {
    const { assign } = useShortcuts();
    return <><button onClick={() => assign("save", "Meta+KeyE")}>Изменить сохранение</button><button onClick={() => assign("save", null)}>Отключить сохранение</button><button onClick={() => assign("save", "DoubleShift")}>Двойной Shift</button></>;
  }
  const { container } = render(<ShortcutProvider><Settings /><CodeEditor path="notes.txt" body="текст" disabled={false} change={() => {}} save={save} /></ShortcutProvider>);
  const editor = EditorView.findFromDOM(container.querySelector(".cm-editor")!)!;
  act(() => editor.dispatch({ changes: { from: 5, insert: " и правка" }, selection: { anchor: 2, head: 4 } }));
  fireEvent.click(screen.getByText("Изменить сохранение"));
  expect(EditorView.findFromDOM(container.querySelector(".cm-editor")!)).toBe(editor);
  fireEvent.keyDown(editor.contentDOM, { key: "s", code: "KeyS", metaKey: true });
  expect(save).not.toHaveBeenCalled();
  fireEvent.keyDown(editor.contentDOM, { key: "у", code: "KeyE", metaKey: true });
  expect(save).toHaveBeenCalledOnce();
  expect(editor.state.sliceDoc()).toBe("текст и правка");
  expect(editor.state.selection.main).toMatchObject({ anchor: 2, head: 4 });
  fireEvent.click(screen.getByText("Отключить сохранение"));
  fireEvent.keyDown(editor.contentDOM, { key: "e", code: "KeyE", metaKey: true });
  expect(save).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByText("Двойной Shift"));
  fireEvent.keyDown(editor.contentDOM, { key: "Shift", code: "ShiftLeft" });
  fireEvent.keyUp(editor.contentDOM, { key: "Shift", code: "ShiftLeft" });
  fireEvent.keyDown(editor.contentDOM, { key: "Shift", code: "ShiftLeft" });
  expect(save).toHaveBeenCalledTimes(2);
});

test("язык определяется автоматически без переключателя в панели редактора", async () => {
  const change = vi.fn(), save = vi.fn();
  const { container } = render(<CodeEditor path="README.md" body="# Заголовок" disabled={false} change={change} save={save} />);
  await waitFor(() => expect([...container.querySelectorAll(".cm-line span")].some(span => span.textContent?.trim() === "Заголовок")).toBe(true));
  expect(screen.queryByRole("combobox", { name: "Язык файла" })).toBeNull();
  expect(screen.queryByRole("textbox", { name: "Найти язык" })).toBeNull();
  expect(change).not.toHaveBeenCalled();
  expect(save).not.toHaveBeenCalled();
});

test.each(["\n", "\r\n"])("BOM и окончания строк %j сохраняются при загрузке подсветки и ручной правке", async separator => {
  const change = vi.fn();
  const original = `\uFEFFconst value = 1;${separator}// comment${separator}`;
  const { container } = render(<CodeEditor path="file.ts" body={original} disabled={false} change={change} save={vi.fn()} />);
  const editor = EditorView.findFromDOM(container.querySelector(".cm-editor")!)!;
  await waitFor(() => expect(syntaxTree(editor.state).length).toBe(editor.state.doc.length));
  expect(change).not.toHaveBeenCalled();
  expect(editor.state.sliceDoc()).toBe(original);
  editor.dispatch({ changes: { from: 1, insert: "// edit" } });
  expect(change).toHaveBeenLastCalledWith(`\uFEFF// editconst value = 1;${separator}// comment${separator}`);
});

test("блоки Markdown загружают подсветку вложенного языка в редакторе", async () => {
  const { container } = render(<CodeEditor path="README.md" body={'```go\nfunc main() { println("hello") }\n```'} disabled={false} change={vi.fn()} save={vi.fn()} />);
  await waitFor(() => expect([...container.querySelectorAll(".cm-line span")].some(span => span.textContent === "func")).toBe(true));
});

test.each([false, true])("видимый текст подсвечивается после загрузки языка без прокрутки и фонового таймера: сравнение=%s", async comparison => {
  await loadFileLanguage("Go");
  vi.useFakeTimers();
  const body = "package main; " + 'func main() { println("hello") }; '.repeat(300);
  let container!: HTMLElement;
  await act(async () => {
    ({ container } = render(comparison ? <Comparison path="main.go" a={body} b={body} />
      : <CodeEditor path="main.go" body={body} disabled={false} change={vi.fn()} save={vi.fn()} />));
  });
  const editors = container.querySelectorAll<HTMLElement>(".cm-editor");
  expect(editors).toHaveLength(comparison ? 2 : 1);
  for (const dom of editors) {
    const editor = EditorView.findFromDOM(dom)!;
    expect(syntaxTree(editor.state).length).toBeGreaterThanOrEqual(editor.viewport.to);
    expect([...dom.querySelectorAll(".cm-line span")].filter(span => span.textContent === "func")).toHaveLength(300);
  }
});

test.each([
  ["main.go", 'package main\nfunc main() { println("hello") }', "func"],
  ["main.ts", 'const value: string = "hello";', "const"],
  ["tsconfig.json", '{\n// comment\n"value": 42,\n}', "// comment"],
])("сравнение %s подсвечивает обе версии вместе с различиями", async (path, a, token) => {
  const { container } = render(<Comparison path={path} a={a} b={a.replace("hello", "new").replace("42", "43")} />);
  await waitFor(() => {
    const editors = [...container.querySelectorAll(".cm-editor")];
    expect(editors).toHaveLength(2);
    expect(editors.every(editor => [...editor.querySelectorAll(".cm-line span")].some(span => span.textContent === token))).toBe(true);
    expect(container.querySelector(".cm-changedLine")).toBeTruthy();
  });
});

test("Markdown подсвечивает заголовки, выделение, ссылки, код и маркеры разметки", async () => {
  const body = "# Заголовок\n\n**Жирный** и *курсив*\n\n[Ссылка](https://example.com)\n\n`код`\n\n> цитата\n\n- пункт\n\n```\nфрагмент\n```\n\n---\n";
  const { container } = render(<CodeEditor path="README.md" body={body} disabled={false} change={vi.fn()} save={vi.fn()} />);
  await waitFor(() => {
    const spans = [...container.querySelectorAll<HTMLElement>(".cm-line span")];
    for (const text of ["Заголовок", "Жирный", "курсив", "Ссылка", "https://example.com", "код", "цитата", "фрагмент", "#", ">", "-", "```", "---"]) {
      expect(spans.some(span => span.textContent?.trim() === text && span.className)).toBe(true);
    }
    expect(getComputedStyle(spans.find(span => span.textContent === "Жирный")!).fontWeight).toBe("700");
    expect(getComputedStyle(spans.find(span => span.textContent === "курсив")!).fontStyle).toBe("italic");
    expect(getComputedStyle(spans.find(span => span.textContent === "Ссылка")!).textDecoration).toBe("underline");
  });
});

test("CodeMirror редактирует текст, ищет совпадения, переходит к строке и обрабатывает сохранение", async () => {
  const change = vi.fn();
  const save = vi.fn();
  const { container } = render(<CodeEditor path="code.ts" body={"const text = 'найти';\nconst next = 'найти';\n"} disabled={false}
    location={{ line: 2, column: 7, request: 1 }} change={change} save={save} />);
  const editor = EditorView.findFromDOM(container.querySelector(".cm-editor")!)!;
  expect(editor.state.selection.main.head).toBe(editor.state.doc.line(2).from + 6);
  editor.dispatch({ changes: { from: 0, insert: "// правка\n" } });
  expect(change).toHaveBeenLastCalledWith("// правка\nconst text = 'найти';\nconst next = 'найти';\n");
  fireEvent.keyDown(editor.contentDOM, { key: "s", code: "KeyS", metaKey: true });
  expect(save).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Поиск в документе" }));
  const search = await screen.findByRole("textbox", { name: "Найти в документе" });
  fireEvent.input(search, { target: { value: "найти" } });
  const panel = within(screen.getByRole("region", { name: "Поиск в документе" }));
  expect(panel.getByRole("status").textContent).toBe("Совпадений: 2");
  fireEvent.click(screen.getByRole("button", { name: "Далее" }));
  const first = editor.state.selection.main.from;
  fireEvent.keyDown(search, { key: "Enter" });
  const second = editor.state.selection.main.from;
  expect(first).not.toBe(second);
  expect(editor.state.sliceDoc(second, editor.state.selection.main.to)).toBe("найти");
  expect(panel.getByRole("status").textContent).toMatch(/^[12] из 2$/);
  fireEvent.keyDown(search, { key: "Enter", shiftKey: true });
  expect(editor.state.selection.main.from).toBe(first);
  fireEvent.keyDown(search, { key: "Escape" });
  expect(screen.queryByRole("textbox", { name: "Найти в документе" })).toBeNull();
  expect(document.activeElement).toBe(editor.contentDOM);
});

test("поиск в документе учитывает фильтры и разрешает замену только в режиме записи", async () => {
  const change = vi.fn(), save = vi.fn();
  const editor = (disabled: boolean) => <CodeEditor path="notes.txt" body="Case case cases" disabled={disabled} change={change} save={save} />;
  const { rerender } = render(editor(false));
  fireEvent.click(screen.getByRole("button", { name: "Поиск в документе" }));
  const panel = within(screen.getByRole("region", { name: "Поиск в документе" }));
  const search = panel.getByRole("textbox", { name: "Найти в документе" });
  const count = panel.getByRole("status");
  fireEvent.input(search, { target: { value: "case" } });
  expect(count.textContent).toBe("Совпадений: 3");
  fireEvent.click(panel.getByRole("button", { name: "Учитывать регистр" }));
  fireEvent.click(panel.getByRole("button", { name: "Слово целиком" }));
  expect(count.textContent).toBe("Совпадений: 1");
  fireEvent.click(panel.getByRole("button", { name: "Регулярное выражение" }));
  fireEvent.input(search, { target: { value: "[" } });
  expect(search.getAttribute("aria-invalid")).toBe("true");
  expect(panel.getByRole("button", { name: "Далее" })).toHaveProperty("disabled", true);
  fireEvent.input(search, { target: { value: "c.se" } });
  fireEvent.click(panel.getByRole("button", { name: "Показать замену" }));
  fireEvent.input(panel.getByRole("textbox", { name: "Заменить" }), { target: { value: "замена" } });
  fireEvent.click(panel.getByRole("button", { name: "Заменить все" }));
  expect(change).toHaveBeenCalledWith("Case замена cases");
  rerender(editor(true));
  expect(panel.queryByRole("textbox", { name: "Заменить" })).toBeNull();
  expect(panel.queryByRole("button", { name: "Показать замену" })).toBeNull();
});

test("переход мягко подсвечивает только целевую строку и убирает подсветку после затухания", () => {
  vi.useFakeTimers();
  const change = vi.fn();
  const { container } = render(<CodeEditor path="file.txt" body={"первая\nвторая\nтретья"} disabled={false}
    location={{ line: 2, column: 1, request: 1 }} change={change} save={vi.fn()} />);
  expect(container.querySelectorAll(".cm-navigation-highlight")).toHaveLength(1);
  expect(container.querySelector(".cm-navigation-highlight")?.textContent).toBe("вторая");
  expect(getComputedStyle(container.querySelector(".cm-navigation-highlight")!).animation).toContain("2.6s");
  expect(getComputedStyle(container.querySelector(".cm-navigation-highlight")!).minWidth).toBe("100%");
  expect(getComputedStyle(container.querySelector(".cm-navigation-highlight")!).backgroundColor).toBe("rgb(216, 208, 170)");
  act(() => { vi.advanceTimersByTime(2000); });
  expect(container.querySelector(".cm-navigation-highlight")).toBeTruthy();
  act(() => { vi.advanceTimersByTime(599); });
  expect(container.querySelector(".cm-navigation-highlight")).toBeTruthy();
  act(() => { vi.advanceTimersByTime(1); });
  expect(container.querySelector(".cm-navigation-highlight")).toBeNull();
  expect(change).not.toHaveBeenCalled();
});

test("повторный переход на ту же строку перезапускает эффект, а другой переход переносит подсветку", () => {
  vi.useFakeTimers();
  const props = { path: "file.txt", body: "первая\nвторая\nтретья", disabled: false, change: vi.fn(), save: vi.fn() };
  const { container, rerender } = render(<CodeEditor {...props} location={{ line: 2, column: 1, request: 1 }} />);
  const firstPulse = container.querySelector(".cm-navigation-highlight")?.getAttribute("data-navigation-pulse");
  act(() => { vi.advanceTimersByTime(1000); });
  rerender(<CodeEditor {...props} location={{ line: 2, column: 1, request: 2 }} />);
  expect(container.querySelector(".cm-navigation-highlight")?.getAttribute("data-navigation-pulse")).not.toBe(firstPulse);
  act(() => { vi.advanceTimersByTime(1600); });
  expect(container.querySelector(".cm-navigation-highlight")?.textContent).toBe("вторая");
  rerender(<CodeEditor {...props} location={{ line: 3, column: 1, request: 3 }} />);
  expect(container.querySelectorAll(".cm-navigation-highlight")).toHaveLength(1);
  expect(container.querySelector(".cm-navigation-highlight")?.textContent).toBe("третья");
  act(() => { vi.advanceTimersByTime(2600); });
  expect(container.querySelector(".cm-navigation-highlight")).toBeNull();
});

test("подсветка следует за строкой при редактировании и очищается при скрытии редактора", () => {
  const props = { path: "file.txt", body: "первая\nвторая", disabled: false, change: vi.fn(), save: vi.fn(), location: { line: 2, column: 1, request: 1 } };
  const { container, rerender } = render(<CodeEditor {...props} />);
  const editor = EditorView.findFromDOM(container.querySelector(".cm-editor")!)!;
  act(() => { editor.dispatch({ changes: { from: 0, insert: "новая\n" } }); });
  expect(container.querySelector(".cm-navigation-highlight")?.textContent).toBe("вторая");
  rerender(<CodeEditor {...props} active={false} />);
  expect(container.querySelector(".cm-navigation-highlight")).toBeNull();
});

test("просмотр MergeView содержит обе версии и запрещает ручное изменение", () => {
  const { container, unmount } = render(<Comparison a={"исходник\n"} b={"правка\n"} />);
  const editors = [...container.querySelectorAll<HTMLElement>(".cm-editor")].map(dom => EditorView.findFromDOM(dom)!);
  expect(editors).toHaveLength(2);
  expect(editors.map(editor => editor.state.doc.toString())).toEqual(["исходник\n", "правка\n"]);
  expect(editors.every(editor => editor.state.readOnly && editor.contentDOM.getAttribute("contenteditable") === "false")).toBe(true);
  unmount();
  expect(container.querySelector(".cm-mergeView")).toBeNull();
});

test("сравнение сохраняет прокрутку при нескольких обновлениях до отрисовки", async () => {
  const { container, rerender } = render(<Comparison a="исходник\n" b="правка\n" />);
  await act(async () => { await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); });
  container.querySelector<HTMLElement>(".cm-mergeView")!.scrollTop = 500;
  rerender(<Comparison a="исходник\n" b="правка 2\n" />);
  rerender(<Comparison a="исходник\n" b="правка 3\n" />);
  await waitFor(() => expect(container.querySelector<HTMLElement>(".cm-mergeView")!.scrollTop).toBe(500));
});

test("навигация сравнения переходит к изменениям в обеих версиях без редактирования", () => {
  const a = Array.from({ length: 30 }, (_, i) => `строка ${i + 1}\n`).join("");
  const b = a.replace("строка 2\n", "изменение 2\n").replace("строка 28\n", "изменение 28\n");
  const { container } = render(<Comparison a={a} b={b} navigation />);
  const editors = [...container.querySelectorAll<HTMLElement>(".cm-editor")].map(dom => EditorView.findFromDOM(dom)!);
  fireEvent.click(screen.getByRole("button", { name: "Предыдущее изменение" }));
  expect(editors.map(editor => editor.state.doc.lineAt(editor.state.selection.main.head).number)).toEqual([28, 28]);
  fireEvent.click(screen.getByRole("button", { name: "Следующее изменение" }));
  expect(editors.map(editor => editor.state.doc.lineAt(editor.state.selection.main.head).number)).toEqual([2, 2]);
  expect(editors.map(editor => editor.state.doc.toString())).toEqual([a, b]);
});

test("фрагменты включаются кнопками рядом с кодом, во время операции кнопки заблокированы", async () => {
  const a = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n";
  const b = a.replace("two", "updated two").replace("seven", "updated seven");
  const stageHunk = vi.fn();
  const hunks = { path: "file.txt", index: "index", worktree: "working", patch: "patch", hunks: ["@@ -1,3 +1,3 @@\n one\n-two\n+updated two\n three\n", "@@ -6,3 +6,3 @@\n six\n-seven\n+updated seven\n eight\n"] };
  const { rerender } = render(<Comparison a={a} b={b} hunks={hunks} stageHunk={stageHunk} />);
  const include = await screen.findByRole("button", { name: "Включить фрагмент 2 в коммит" });
  fireEvent.click(include); expect(stageHunk).toHaveBeenCalledExactlyOnceWith(1);
  rerender(<Comparison a={a} b={b} hunks={hunks} stageHunk={stageHunk} busy />);
  expect((screen.getByRole("button", { name: "Включить фрагмент 2 в коммит" }) as HTMLButtonElement).disabled).toBe(true);
});

test("настройки меняют перенос в редакторе и сравнении без сброса текста и отмены правок", () => {
  function Controls() {
    const { update } = useAppearance();
    return <button onClick={() => update({ wrapCode: false, editorFont: "system", editorFontSize: 12, scale: 125 })}>Изменить вид</button>;
  }
  const original = "исходный текст";
  const { container } = render(<AppearanceProvider><Controls /><CodeEditor path="file.txt" body={original} disabled={false} change={vi.fn()} save={vi.fn()} />
    <Comparison a="до" b="после" /></AppearanceProvider>);
  const editor = EditorView.findFromDOM(container.querySelector(".code-editor .cm-editor")!)!;
  editor.dispatch({ changes: { from: 0, insert: "правка " }, selection: { anchor: 3 } });
  expect(container.querySelectorAll(".cm-lineWrapping")).toHaveLength(3);
  fireEvent.click(screen.getByRole("button", { name: "Изменить вид" }));
  expect(container.querySelectorAll(".cm-lineWrapping")).toHaveLength(0);
  expect(EditorView.findFromDOM(container.querySelector(".code-editor .cm-editor")!)).toBe(editor);
  expect(editor.state.sliceDoc()).toBe("правка " + original);
  expect(editor.state.selection.main.head).toBe(3);
  fireEvent.keyDown(editor.contentDOM, { key: "z", code: "KeyZ", ctrlKey: true });
  expect(editor.state.sliceDoc()).toBe(original);
});

test("импортированная тема меняет редактор и обе версии без потери текста, курсора, прокрутки и отмены", async () => {
  const theme = importEditorTheme(vscodeTheme), change = vi.fn();
  function Controls() {
    const { update } = useAppearance();
    return <button onClick={() => update({ editorThemes: [theme], editorTheme: theme.id })}>Выбрать тему</button>;
  }
  const original = 'const value = "hello";';
  const { container } = render(<AppearanceProvider><Controls />
    <CodeEditor path="file.ts" body={original} disabled={false} change={change} save={vi.fn()} />
    <Comparison path="file.ts" a={original} b={original.replace("hello", "new")} />
  </AppearanceProvider>);
  const editors = [...container.querySelectorAll<HTMLElement>(".cm-editor")].map(dom => EditorView.findFromDOM(dom)!);
  const editor = editors[0];
  await waitFor(() => expect(container.querySelectorAll(".cm-line span").length).toBeGreaterThan(2));
  act(() => { editor.dispatch({ changes: { from: 0, insert: "// edit\n" }, selection: { anchor: 3 } }); });
  editor.scrollDOM.scrollTop = 120;
  change.mockClear();
  fireEvent.click(screen.getByRole("button", { name: "Выбрать тему" }));
  expect([...container.querySelectorAll<HTMLElement>(".cm-editor")].map(dom => EditorView.findFromDOM(dom))).toEqual(editors);
  expect(editors.every(view => view.state.facet(EditorView.darkTheme) === false)).toBe(true);
  expect(editor.state.sliceDoc()).toBe("// edit\n" + original);
  expect(editor.state.selection.main.head).toBe(3);
  expect(editor.scrollDOM.scrollTop).toBe(120);
  expect(change).not.toHaveBeenCalled();
  expect(container.querySelector(".cm-changedLine")).toBeTruthy();
  await waitFor(() => {
    const keywords = [...container.querySelectorAll<HTMLElement>(".cm-line span")].filter(span => span.textContent === "const");
    expect(keywords).toHaveLength(3);
    expect(keywords.every(span => getComputedStyle(span).color === "rgb(153, 0, 153)")).toBe(true);
  });
  fireEvent.keyDown(editor.contentDOM, { key: "z", code: "KeyZ", ctrlKey: true });
  expect(editor.state.sliceDoc()).toBe(original);
});

test("редактор сохраняет CRLF и принимает внешнюю версию с другими окончаниями строк", () => {
  const change = vi.fn();
  const { container, rerender } = render(<CodeEditor path="file.txt" body={"первая\r\nвторая\r\n"} disabled={false} change={change} save={vi.fn()} />);
  const editor = EditorView.findFromDOM(container.querySelector(".cm-editor")!)!;
  expect(change).not.toHaveBeenCalled();
  expect(editor.state.doc.lines).toBe(3);
  editor.dispatch({ changes: { from: 0, insert: "правка " } });
  expect(change).toHaveBeenLastCalledWith("правка первая\r\nвторая\r\n");
  rerender(<CodeEditor path="file.txt" body={"внешняя\nверсия\n"} disabled={false} change={change} save={vi.fn()} />);
  expect(editor.state.doc.lines).toBe(3);
  expect(editor.state.sliceDoc()).toBe("внешняя\nверсия\n");
});

test.each([
  { disk: "первая\nнайти здесь\n", body: "новая строка\nпервая\nнайти здесь\n", line: 2, column: 1, text: "найти здесь", expected: 20 },
  { disk: "первая\r\n😀 найти здесь\r\n", body: "новая\r\nпервая\r\n😀 вставка найти здесь\r\n", line: 2, column: 3, text: "😀 найти здесь", expected: 24 },
  { disk: "найти\nнайти\n", body: "вставка\nнайти\nнайти\n", line: 2, column: 1, text: "найти", expected: 14 },
])("переход из поиска сопоставляет дисковое совпадение с черновиком: $body", ({ disk, body, line, column, text, expected }) => {
  const { container } = render(<CodeEditor path="file.txt" body={body} disk={disk} disabled={false}
    location={{ line, column, text, query: "найти", request: 1 }} change={vi.fn()} save={vi.fn()} />);
  const editor = EditorView.findFromDOM(container.querySelector(".cm-editor")!)!;
  expect(editor.state.selection.main.head).toBe(expected);
  expect(editor.state.sliceDoc(expected, expected + 5)).toBe("найти");
});

test("удалённое совпадение не переносит курсор к другому такому же тексту", () => {
  const { container } = render(<CodeEditor path="file.txt" body={"первая\nнайти\n"} disk={"найти\nпервая\nнайти\n"} disabled={false}
    location={{ line: 1, column: 1, text: "найти", query: "найти", request: 1 }} change={vi.fn()} save={vi.fn()} />);
  const editor = EditorView.findFromDOM(container.querySelector(".cm-editor")!)!;
  expect(screen.getByRole("alert").textContent).toContain("изменено или удалено в черновике");
  expect(editor.state.selection.main.head).toBe(0);
});

test("устаревший результат поиска не применяет координаты к изменённому диску", () => {
  const { container } = render(<CodeEditor path="file.txt" body={"новая\nнайти\n"} disk={"новая\nнайти\n"} disabled={false}
    location={{ line: 1, column: 1, text: "найти", query: "найти", request: 1 }} change={vi.fn()} save={vi.fn()} />);
  const editor = EditorView.findFromDOM(container.querySelector(".cm-editor")!)!;
  expect(screen.getByRole("alert").textContent).toContain("Повторите поиск");
  expect(editor.state.selection.main.head).toBe(0);
});

test("переход ожидает активной вкладки и не повторяется при обновлении диска или возврате", () => {
  const body = "новая\nпервая\nнайти\n";
  const location = { line: 2, column: 1, text: "найти", query: "найти", request: 1 };
  const props = { path: "file.txt", body, disk: "первая\nнайти\n", disabled: false, location, change: vi.fn(), save: vi.fn() };
  const { container, rerender } = render(<CodeEditor {...props} active={false} />);
  const editor = EditorView.findFromDOM(container.querySelector(".cm-editor")!)!;
  const focus = vi.spyOn(editor, "focus");
  expect(editor.state.selection.main.head).toBe(0);
  rerender(<CodeEditor {...props} active />);
  expect(editor.state.selection.main.head).toBe(13);
  expect(focus).toHaveBeenCalledOnce();
  editor.dispatch({ selection: { anchor: 2 } });
  rerender(<CodeEditor {...props} disk={body} active={false} />);
  rerender(<CodeEditor {...props} disk={body} active />);
  expect(editor.state.selection.main.head).toBe(2);
  expect(focus).toHaveBeenCalledOnce();
});

test.each([
  { baseline: "one\ntwo\nthree\n", body: "one\nnew\ntwo\nthree\n", kind: "added", count: 1 },
  { baseline: "one\ntwo\nthree\n", body: "one\nupdated\nthree\n", kind: "modified", count: 1 },
  { baseline: "one\ntwo\nthree\n", body: "one\nthree\n", kind: "deleted", count: 1 },
  { baseline: "one\ntwo\nthree\n", body: "one\ntwo\n", kind: "deleted", count: 1 },
  { baseline: "one", body: "", kind: "deleted", count: 1 },
  { baseline: "", body: "one\ntwo\n", kind: "added", count: 2 },
  { baseline: "one\ntwo\n", body: "one\r\ntwo\r\n", kind: "modified", count: 0 },
])("метки строк показывают $kind без изменения текста: $body", ({ baseline, body, kind, count }) => {
  const change = vi.fn();
  const { container } = render(<CodeEditor path="file.txt" body={body} baseline={baseline} disabled={false} change={change} save={vi.fn()} />);
  expect(container.querySelectorAll(`.cm-line-change-${kind}`)).toHaveLength(count);
  expect(EditorView.findFromDOM(container.querySelector(".cm-editor")!)!.state.sliceDoc()).toBe(body);
  expect(change).not.toHaveBeenCalled();
});

test("метки обновляются при вводе, отмене и смене HEAD без сброса редактора", () => {
  const baseline = "one\ntwo\nthree\n";
  const props = { path: "file.txt", body: baseline, baseline, disabled: false, change: vi.fn(), save: vi.fn() };
  const { container, rerender } = render(<CodeEditor {...props} />);
  const editor = EditorView.findFromDOM(container.querySelector(".cm-editor")!)!;
  act(() => editor.dispatch({ changes: { from: 4, insert: "new\n" }, selection: { anchor: 6 } }));
  expect(container.querySelectorAll(".cm-line-change-added")).toHaveLength(1);
  const body = editor.state.sliceDoc();
  rerender(<CodeEditor {...props} body={body} baseline={body} />);
  expect(container.querySelectorAll(".cm-line-change-added, .cm-line-change-modified, .cm-line-change-deleted")).toHaveLength(0);
  expect(EditorView.findFromDOM(container.querySelector(".cm-editor")!)).toBe(editor);
  expect(editor.state.selection.main.head).toBe(6);
  fireEvent.keyDown(editor.contentDOM, { key: "z", code: "KeyZ", ctrlKey: true });
  expect(editor.state.sliceDoc()).toBe(baseline);
  expect(container.querySelectorAll(".cm-line-change-deleted")).toHaveLength(1);
  rerender(<CodeEditor {...props} />);
  expect(container.querySelectorAll(".cm-line-change-added, .cm-line-change-modified, .cm-line-change-deleted")).toHaveLength(0);
});

test.each([
  { baseline: "one\ntwo\nthree\n", body: "one\nupdated\nthree\n", marker: "изменённая строка", before: "two" },
  { baseline: "one\ntwo\nthree\n", body: "one\nthree\n", marker: "удалённые строки", before: "two" },
  { baseline: "one\ntwo\nthree\n", body: "one\ntwo\n", marker: "удалённые строки", before: "three" },
  { baseline: "one", body: "", marker: "удалённые строки", before: "one" },
  { baseline: "one\n", body: "one\nnew\n", marker: "добавленная строка", before: null },
])("нажатие на метку показывает исходный фрагмент: $marker, $body", async ({ baseline, body, marker, before }) => {
  const change = vi.fn(), save = vi.fn();
  const { container } = render(<CodeEditor path="file.txt" body={body} baseline={baseline} disabled={false} change={change} save={save} />);
  fireEvent.click(screen.getByRole("button", { name: `Показать изменение: ${marker}` }));
  const popup = within(await screen.findByRole("dialog", { name: "Изменение кода" }));
  if (before) {
    expect(popup.getByRole("textbox", { name: "Код file.txt" }).textContent).toBe(before);
    expect(popup.getByRole("textbox", { name: "Код file.txt" }).getAttribute("contenteditable")).toBe("false");
    expect(container.querySelector(".cm-change-popup .cm-deletedText")).toBeTruthy();
  } else expect(popup.getByText("Добавленные строки — в исходной версии их не было.")).toBeTruthy();
  expect(change).not.toHaveBeenCalled();
  expect(save).not.toHaveBeenCalled();
  fireEvent.keyDown(document.body, { key: "Escape" });
  expect(screen.queryByRole("dialog", { name: "Изменение кода" })).toBeNull();
});

test("панель переходит между фрагментами и показывает сравнение всего файла", async () => {
  const baseline = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n";
  const body = baseline.replace("two", "updated two").replace("seven", "updated seven");
  render(<CodeEditor path="file.txt" body={body} baseline={baseline} disabled={false} change={vi.fn()} save={vi.fn()} />);
  const editor = EditorView.findFromDOM(screen.getByRole("textbox", { name: "Код file.txt" }))!;
  fireEvent.keyDown(screen.getAllByRole("button", { name: "Показать изменение: изменённая строка" })[0], { key: "Enter" });
  let popup = within(await screen.findByRole("dialog", { name: "Изменение кода" }));
  expect(popup.getByRole("textbox", { name: "Код file.txt" }).textContent).toBe("two");
  expect((popup.getByRole("button", { name: "Предыдущее изменение" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(popup.getByRole("button", { name: "Следующее изменение" }));
  popup = within(await screen.findByRole("dialog", { name: "Изменение кода" }));
  expect(popup.getByRole("textbox", { name: "Код file.txt" }).textContent).toBe("seven");
  expect((popup.getByRole("button", { name: "Следующее изменение" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(popup.getByRole("button", { name: "Сравнить весь файл" }));
  expect(popup.getByLabelText("Сравнение версий").querySelectorAll(".cm-editor")).toHaveLength(2);
  expect(editor.state.sliceDoc()).toBe(body);
  fireEvent.pointerDown(editor.contentDOM);
  expect(screen.queryByRole("dialog", { name: "Изменение кода" })).toBeNull();
});

test.each(["\n", "\r\n"])("откат изменяет только выбранный фрагмент и отменяется обычной отменой: %j", async separator => {
  const baseline = ["one", "two", "three", "four", "five", "six", "seven", "eight", ""].join(separator);
  const body = baseline.replace("two", "updated two").replace("seven", "updated seven");
  render(<CodeEditor path="file.txt" body={body} baseline={baseline} disabled={false} change={vi.fn()} save={vi.fn()} />);
  const editor = EditorView.findFromDOM(screen.getByRole("textbox", { name: "Код file.txt" }))!;
  fireEvent.click(screen.getAllByRole("button", { name: "Показать изменение: изменённая строка" })[0]);
  const popup = within(await screen.findByRole("dialog", { name: "Изменение кода" }));
  fireEvent.click(popup.getByRole("button", { name: "Откатить фрагмент" }));
  expect(editor.state.sliceDoc()).toBe(baseline.replace("seven", "updated seven"));
  expect(screen.queryByRole("dialog", { name: "Изменение кода" })).toBeNull();
  fireEvent.keyDown(editor.contentDOM, { key: "z", code: "KeyZ", ctrlKey: true });
  expect(editor.state.sliceDoc()).toBe(body);
});

test.each(["ввод", "HEAD", "скрытие"])("просмотр закрывается при изменении исходных данных: %s", async action => {
  const baseline = "one\ntwo\n", body = "one\nupdated\n";
  const props = { path: "file.txt", body, baseline, disabled: false, change: vi.fn(), save: vi.fn() };
  const { rerender } = render(<CodeEditor {...props} />);
  const editor = EditorView.findFromDOM(screen.getByRole("textbox", { name: "Код file.txt" }))!;
  fireEvent.click(screen.getByRole("button", { name: "Показать изменение: изменённая строка" }));
  await screen.findByRole("dialog", { name: "Изменение кода" });
  if (action === "ввод") act(() => editor.dispatch({ changes: { from: 0, insert: "new\n" } }));
  if (action === "HEAD") rerender(<CodeEditor {...props} baseline={body} />);
  if (action === "скрытие") rerender(<CodeEditor {...props} active={false} />);
  expect(screen.queryByRole("dialog", { name: "Изменение кода" })).toBeNull();
});

test.each([
  { baseline: "one\n", body: "one\nnew\n", marker: "добавленная строка" },
  { baseline: "one\ntwo\n", body: "one\n", marker: "удалённые строки" },
  { baseline: "one", body: "", marker: "удалённые строки" },
])("откат восстанавливает добавленные или удалённые строки: $body", async ({ baseline, body, marker }) => {
  render(<CodeEditor path="file.txt" body={body} baseline={baseline} disabled={false} change={vi.fn()} save={vi.fn()} />);
  const editor = EditorView.findFromDOM(screen.getByRole("textbox", { name: "Код file.txt" }))!;
  fireEvent.click(screen.getByRole("button", { name: `Показать изменение: ${marker}` }));
  const popup = within(await screen.findByRole("dialog", { name: "Изменение кода" }));
  fireEvent.click(popup.getByRole("button", { name: "Откатить фрагмент" }));
  expect(editor.state.sliceDoc()).toBe(baseline);
});

test("просмотр доступен в режиме чтения, а откат заблокирован", async () => {
  const change = vi.fn();
  render(<CodeEditor path="file.txt" body="updated\n" baseline="original\n" disabled change={change} save={vi.fn()} />);
  fireEvent.keyDown(screen.getByRole("button", { name: "Показать изменение: изменённая строка" }), { key: " " });
  const popup = within(await screen.findByRole("dialog", { name: "Изменение кода" }));
  expect((popup.getByRole("button", { name: "Откатить фрагмент" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(popup.getByRole("button", { name: "Откатить фрагмент" }));
  expect(change).not.toHaveBeenCalled();
  fireEvent.click(popup.getByRole("button", { name: "Закрыть изменение" }));
  expect(screen.queryByRole("dialog", { name: "Изменение кода" })).toBeNull();
});
