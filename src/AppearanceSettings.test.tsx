// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import AppearanceSettings from "./AppearanceSettings";
import MessageContent from "./MessageContent";
import { AppearanceProvider, appearanceKey, defaultAppearance, monoFonts, textFonts } from "./appearance";
import { vscodeTheme } from "./test-fixtures/editorTheme";
import { importEditorTheme } from "./editorThemes";
import { builtinEditorThemes } from "./builtinEditorThemes";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(async () => null) }));
HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
beforeEach(() => { vi.mocked(invoke).mockReset().mockResolvedValue([]); vi.mocked(open).mockReset().mockResolvedValue(null); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear(); });

function settings(body = "") {
  return <AppearanceProvider><AppearanceSettings close={vi.fn()} />{body && <MessageContent body={body} />}</AppearanceProvider>;
}

function choose(label: string, option: string) {
  fireEvent.click(screen.getByRole("combobox", { name: label }));
  fireEvent.click(within(screen.getByRole("listbox", { name: label })).getByRole("option", { name: option }));
}

test("уведомления настраиваются отдельно, отказ macOS оставляет переключатель выключенным", async () => {
  vi.mocked(invoke)
    .mockResolvedValueOnce({ completion: false, input: false })
    .mockResolvedValueOnce({ completion: true, input: false })
    .mockRejectedValueOnce("Разрешите уведомления для Yade в системных настройках macOS")
    .mockResolvedValueOnce({ completion: true, input: false });
  render(settings());
  const open = () => fireEvent.click(screen.getByRole("button", { name: "Уведомления" }));
  open();
  const completion = await screen.findByRole("switch", { name: "Завершение работы" });
  const input = screen.getByRole("switch", { name: "Запрос ответа" });
  fireEvent.click(completion);
  await waitFor(() => expect(completion.getAttribute("aria-checked")).toBe("true"));
  expect(invoke).toHaveBeenCalledWith("set_notification_enabled", { kind: "completion", enabled: true });
  fireEvent.click(input);
  expect((await screen.findByRole("alert")).textContent).toContain("в системных настройках macOS");
  expect(input.getAttribute("aria-checked")).toBe("false");
  expect(invoke).toHaveBeenCalledWith("set_notification_enabled", { kind: "input", enabled: true });
  fireEvent.click(screen.getByRole("button", { name: "Внешний вид" }));
  open();
  expect((await screen.findByRole("switch", { name: "Завершение работы" })).getAttribute("aria-checked")).toBe("true");
});

test("четыре шрифта, масштаб и отображение применяются сразу и восстанавливаются после открытия", () => {
  const panel = render(settings());
  for (const label of ["Шрифт интерфейса", "Шрифт чата"]) choose(label, "С засечками");
  for (const label of ["Шрифт редактора", "Шрифт терминала"]) choose(label, "Системный моноширинный");
  choose("Общий масштаб интерфейса", "110%");
  fireEvent.click(screen.getByRole("switch", { name: "Переносить длинные строки" }));
  fireEvent.click(screen.getByRole("button", { name: "Исходный" }));
  const root = panel.container.querySelector<HTMLElement>(".appearance-root")!;
  expect(root.style.getPropertyValue("--font-interface")).toBe(textFonts.serif.family);
  expect(root.style.getPropertyValue("--font-chat")).toBe(textFonts.serif.family);
  expect(root.style.getPropertyValue("--font-editor")).toBe(monoFonts.system.family);
  expect(root.style.getPropertyValue("--font-terminal")).toBe(monoFonts.system.family);
  expect(Number(root.style.getPropertyValue("--appearance-scale"))).toBeCloseTo(1.155);
  expect(screen.getByLabelText("Предпросмотр внешнего вида").querySelector(".wrap-code")).toBeNull();
  expect(screen.getByRole("status").textContent).toBe("Изменения применяются сразу");
  expect(JSON.parse(localStorage.getItem(appearanceKey)!)).toEqual({
    ...defaultAppearance,
    interfaceFont: "serif", chatFont: "serif", editorFont: "system", terminalFont: "system", scale: 110, wrapCode: false, chatFormat: "source",
  });
  panel.unmount();
  const reopened = render(settings());
  expect(screen.getByRole("combobox", { name: "Шрифт чата" }).textContent).toBe("С засечками");
  expect(screen.getByRole("combobox", { name: "Шрифт редактора" }).textContent).toBe("Системный моноширинный");
  expect(screen.getByRole("combobox", { name: "Общий масштаб интерфейса" }).textContent).toBe("110%");
  expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false");
  expect(screen.getByRole("button", { name: "Исходный" }).getAttribute("aria-pressed")).toBe("true");
  choose("Общий масштаб интерфейса", "100%");
  expect(reopened.container.querySelector<HTMLElement>(".appearance-root")!.style.getPropertyValue("--appearance-scale")).toBe("1.05");
  expect(JSON.parse(localStorage.getItem(appearanceKey)!).scale).toBe(100);
});

test.each(builtinEditorThemes)("встроенная тема $name доступна без импорта и сохраняет выбор", theme => {
  const panel = render(settings());
  choose("Цветовая тема редактора", theme.name);
  expect(panel.container.querySelector<HTMLElement>(".appearance-root")!.style.getPropertyValue("--editor-background")).toBe(theme.colors.background);
  expect(invoke).not.toHaveBeenCalled();
  expect(open).not.toHaveBeenCalled();
  const stored = JSON.parse(localStorage.getItem(appearanceKey)!);
  expect(stored.editorTheme).toBe(theme.id);
  expect(stored.editorThemes).toEqual([]);
  panel.unmount();
  render(settings());
  expect(screen.getByRole("combobox", { name: "Цветовая тема редактора" }).textContent).toBe(theme.name);
  choose("Цветовая тема редактора", "Исходная тема Yade");
});

test("импорт новой версии встроенной темы обновляет палитру без дублирования", async () => {
  const theme = builtinEditorThemes[0];
  vi.mocked(open).mockResolvedValue("/tmp/updated.vsix");
  vi.mocked(invoke).mockResolvedValue([{ ...vscodeTheme, id: theme.id, name: "Обновлённая тема" }]);
  const panel = render(settings());
  choose("Цветовая тема редактора", theme.name);
  fireEvent.click(screen.getByRole("button", { name: "Импортировать тему VS Code…" }));
  await screen.findByText("Обновлённая тема");
  expect(panel.container.querySelector<HTMLElement>(".appearance-root")!.style.getPropertyValue("--editor-background")).toBe("#fafafa");
  fireEvent.click(screen.getByRole("combobox", { name: "Цветовая тема редактора" }));
  expect(within(screen.getByRole("listbox")).getAllByRole("option")).toHaveLength(builtinEditorThemes.length + 1);
  expect(within(screen.getByRole("listbox")).queryByRole("option", { name: theme.name })).toBeNull();
  expect(JSON.parse(localStorage.getItem(appearanceKey)!).editorThemes).toHaveLength(1);
});

test("четыре размера в pt применяются независимо от масштаба и восстанавливаются после открытия", () => {
  const panel = render(settings());
  const sizes = [
    ["Размер шрифта интерфейса", "interfaceFontSize", "interface", 12],
    ["Размер шрифта чата", "chatFontSize", "chat", 14],
    ["Размер шрифта редактора", "editorFontSize", "editor", 11],
    ["Размер шрифта терминала", "terminalFontSize", "terminal", 16],
  ] as const;
  for (const [label, , , size] of sizes) choose(label, `${size} pt`);
  const root = panel.container.querySelector<HTMLElement>(".appearance-root")!;
  const stored = JSON.parse(localStorage.getItem(appearanceKey)!);
  for (const [, key, variable, size] of sizes) {
    expect(root.style.getPropertyValue(`--font-size-${variable}`)).toBe(`${size}pt`);
    expect(stored[key]).toBe(size);
  }
  expect(screen.getByRole("combobox", { name: "Общий масштаб интерфейса" }).textContent).toBe("100%");
  expect(root.style.getPropertyValue("--appearance-scale")).toBe("1.05");
  expect(Number(root.style.getPropertyValue("--interface-font-scale"))).toBeCloseTo(12 / defaultAppearance.interfaceFontSize);
  panel.unmount();
  render(settings());
  for (const [label, , , size] of sizes) expect(screen.getByRole("combobox", { name: label }).textContent).toBe(`${size} pt`);
});

test("старые настройки получают исходные размеры, некорректные размеры отбрасываются", () => {
  localStorage.setItem(appearanceKey, JSON.stringify({ chatFont: "serif", interfaceFontSize: -1, chatFontSize: "14", editorFontSize: null, terminalFontSize: 10000 }));
  const panel = render(settings());
  expect(screen.getByRole("combobox", { name: "Шрифт чата" }).textContent).toBe("С засечками");
  expect(screen.getByRole("combobox", { name: "Размер шрифта интерфейса" }).textContent).toBe(`${defaultAppearance.interfaceFontSize} pt`);
  expect(screen.getByRole("combobox", { name: "Размер шрифта чата" }).textContent).toBe(`${defaultAppearance.chatFontSize} pt`);
  expect(screen.getByRole("combobox", { name: "Размер шрифта редактора" }).textContent).toBe(`${defaultAppearance.editorFontSize} pt`);
  expect(screen.getByRole("combobox", { name: "Размер шрифта терминала" }).textContent).toBe(`${defaultAppearance.terminalFontSize} pt`);
  panel.unmount();
  localStorage.setItem(appearanceKey, JSON.stringify({ chatFont: "serif" }));
  render(settings());
  expect(screen.getByRole("combobox", { name: "Размер шрифта чата" }).textContent).toBe(`${defaultAppearance.chatFontSize} pt`);
  expect(screen.getByRole("combobox", { name: "Шрифт чата" }).textContent).toBe("С засечками");
});

test.each(["{", "null", "[]", JSON.stringify({ interfaceFont: "__proto__", editorFont: "нет", scale: -10, wrapCode: "false", chatFormat: "html" })])(
  "повреждённые настройки %s не мешают открыть экран", value => {
    localStorage.setItem(appearanceKey, value);
    render(settings());
    expect(screen.getByRole("combobox", { name: "Шрифт интерфейса" }).textContent).toBe(textFonts[defaultAppearance.interfaceFont].name);
    expect(screen.getByRole("combobox", { name: "Шрифт редактора" }).textContent).toBe(monoFonts[defaultAppearance.editorFont].name);
    expect(screen.getByRole("combobox", { name: "Общий масштаб интерфейса" }).textContent).toBe("100%");
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true");
  },
);

test("ошибка хранения показана явно, выбор применяется до конца текущего запуска", () => {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("хранилище недоступно"); });
  const panel = render(settings());
  choose("Шрифт чата", "С засечками");
  expect(screen.getByRole("alert").textContent).toContain("Настройки применены, но не сохранены");
  expect(panel.container.querySelector<HTMLElement>(".appearance-root")!.style.getPropertyValue("--font-chat")).toBe(textFonts.serif.family);
  expect(localStorage.getItem(appearanceKey)).toBeNull();
});

test("форматированные сообщения безопасны, исходный режим сохраняет точный текст", () => {
  const body = "## Результат\n\n**Готово** и `код`\n\n```sh\nnpm run dev\n```\n\n[опасная ссылка](javascript:alert%281%29)\n\n<script>alert(1)</script>";
  const panel = render(settings(body));
  const content = panel.container.querySelector(".appearance-root > .message-formatted")!;
  expect(within(content as HTMLElement).getByRole("heading", { name: "Результат" })).toBeTruthy();
  expect(content.querySelector("strong")?.textContent).toBe("Готово");
  expect(content.querySelector("pre code")?.textContent).toBe("npm run dev\n");
  expect(content.querySelector("script")).toBeNull();
  expect(content.querySelector("a")?.getAttribute("href")).not.toContain("javascript:");
  fireEvent.click(screen.getByRole("button", { name: "Исходный" }));
  expect(panel.container.querySelector(".appearance-root > .message-source")?.textContent).toBe(body);
  fireEvent.click(screen.getByRole("button", { name: "Форматированный" }));
  expect(panel.container.querySelector(".appearance-root > .message-formatted h2")?.textContent).toBe("Результат");
});

test("настройки исполнителей остаются доступны в отдельном разделе", async () => {
  render(settings());
  fireEvent.click(screen.getByRole("button", { name: "Исполнители" }));
  expect(await screen.findByRole("heading", { name: "Исполнители" })).toBeTruthy();
  expect(screen.getByText("Выберите рабочее пространство для настройки параметров.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Внешний вид" }));
  expect(screen.getByRole("combobox", { name: "Шрифт интерфейса" })).toBeTruthy();
});

test("импорт VSIX добавляет варианты, выбор и предпросмотр сохраняются после открытия", async () => {
  vi.mocked(open).mockResolvedValue("/tmp/theme.vsix");
  vi.mocked(invoke).mockResolvedValue([vscodeTheme, { ...vscodeTheme, id: "dark", name: "Тёмная проверочная", dark: true }]);
  const panel = render(settings());
  fireEvent.click(screen.getByRole("button", { name: "Импортировать тему VS Code…" }));
  await screen.findByRole("button", { name: "Импортировать тему VS Code…" });
  expect(open).toHaveBeenCalledWith(expect.objectContaining({ directory: false, multiple: false, filters: [{ name: "Темы VS Code", extensions: ["vsix"] }] }));
  expect(invoke).toHaveBeenCalledWith("import_editor_themes", { path: "/tmp/theme.vsix" });
  choose("Цветовая тема редактора", "Светлая проверочная");
  expect(panel.container.querySelector<HTMLElement>(".appearance-root")!.style.getPropertyValue("--editor-background")).toBe("#fafafa");
  expect(within(screen.getByLabelText("Предпросмотр внешнего вида")).getByText("function").style.color).toBe("rgb(153, 0, 153)");
  expect(JSON.parse(localStorage.getItem(appearanceKey)!).editorThemes).toHaveLength(2);
  panel.unmount();
  render(settings());
  expect(screen.getByRole("combobox", { name: "Цветовая тема редактора" }).textContent).toBe("Светлая проверочная");
  choose("Цветовая тема редактора", "Тёмная проверочная");
  choose("Цветовая тема редактора", "Исходная тема Yade");
  expect(JSON.parse(localStorage.getItem(appearanceKey)!).editorTheme).toBeNull();
  expect(JSON.parse(localStorage.getItem(appearanceKey)!).editorThemes).toHaveLength(2);
});

test("повторный импорт обновляет тему без дублей и сохраняет выбранный вариант", async () => {
  const theme = importEditorTheme(vscodeTheme);
  localStorage.setItem(appearanceKey, JSON.stringify({ editorTheme: theme.id, editorThemes: [theme] }));
  vi.mocked(open).mockResolvedValue("/tmp/theme.vsix");
  vi.mocked(invoke).mockResolvedValue([{ ...vscodeTheme, name: "Обновлённая тема" }]);
  render(settings());
  fireEvent.click(screen.getByRole("button", { name: "Импортировать тему VS Code…" }));
  await screen.findByRole("combobox", { name: "Цветовая тема редактора" });
  await screen.findByText("Обновлённая тема");
  const stored = JSON.parse(localStorage.getItem(appearanceKey)!);
  expect(stored.editorThemes).toHaveLength(1);
  expect(stored.editorTheme).toBe(theme.id);
});

test("отмена выбора и ошибка импорта сохраняют текущие темы", async () => {
  const theme = importEditorTheme(vscodeTheme);
  localStorage.setItem(appearanceKey, JSON.stringify({ editorTheme: theme.id, editorThemes: [theme] }));
  render(settings());
  fireEvent.click(screen.getByRole("button", { name: "Импортировать тему VS Code…" }));
  await screen.findByRole("button", { name: "Импортировать тему VS Code…" });
  expect(invoke).not.toHaveBeenCalled();
  vi.mocked(open).mockResolvedValue("/tmp/broken.vsix");
  vi.mocked(invoke).mockRejectedValue("В пакете нет цветовых тем.");
  fireEvent.click(screen.getByRole("button", { name: "Импортировать тему VS Code…" }));
  expect((await screen.findByRole("alert")).textContent).toContain("В пакете нет цветовых тем");
  expect(screen.getByRole("combobox", { name: "Цветовая тема редактора" }).textContent).toBe(theme.name);
  expect(localStorage.getItem(appearanceKey)).toContain(theme.id);
});

test("повреждённая тема из пакета не добавляется частично", async () => {
  vi.mocked(open).mockResolvedValue("/tmp/broken.vsix");
  vi.mocked(invoke).mockResolvedValue([vscodeTheme, { ...vscodeTheme, colors: { "editor.background": "url(https://example.com)" } }]);
  render(settings());
  fireEvent.click(screen.getByRole("button", { name: "Импортировать тему VS Code…" }));
  expect((await screen.findByRole("alert")).textContent).toContain("Некорректный цвет");
  expect(localStorage.getItem(appearanceKey)).toBeNull();
});

test("изменение шрифта во время импорта не теряется после его завершения", async () => {
  vi.mocked(open).mockResolvedValue("/tmp/theme.vsix");
  let finish!: (value: unknown[]) => void;
  vi.mocked(invoke).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  render(settings());
  fireEvent.click(screen.getByRole("button", { name: "Импортировать тему VS Code…" }));
  await screen.findByRole("button", { name: "Импорт темы…" });
  choose("Шрифт редактора", "Системный моноширинный");
  await Promise.resolve();
  finish([vscodeTheme]);
  await screen.findByRole("button", { name: "Импортировать тему VS Code…" });
  const stored = JSON.parse(localStorage.getItem(appearanceKey)!);
  expect(stored.editorFont).toBe("system");
  expect(stored.editorThemes).toHaveLength(1);
});
