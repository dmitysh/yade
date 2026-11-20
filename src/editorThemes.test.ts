import { expect, test } from "vitest";
import { defaultEditorTheme, editorHighlightStyle, importEditorTheme, isEditorTheme } from "./editorThemes";
import { vscodeTheme } from "./test-fixtures/editorTheme";
import { tags } from "@lezer/highlight";

test("тема VS Code переносит цвета редактора и основные категории синтаксиса", () => {
  const theme = importEditorTheme(vscodeTheme);
  expect(theme.colors.background).toBe("#fafafa");
  expect(theme.colors["gutter-background"]).toBe("#fafafa");
  expect(theme.colors["added-line"]).toBe("#ddffdd");
  expect(theme.syntax.keyword.color).toBe("#990099");
  expect(theme.syntax.string.color).toBe("#228822");
  expect(theme.syntax.comment).toMatchObject({ color: "#666666", fontStyle: "italic" });
  expect(theme.syntax.heading).toMatchObject({ color: "#660099", fontWeight: "bold" });
  expect(theme.syntax.strong.fontWeight).toBe("bold");
  expect(theme.syntax.emphasis.fontStyle).toBe("italic");
  expect(theme.syntax.link.textDecoration).toBe("underline");
  expect(theme.syntax.inserted.color).toBe("#006600");
  expect(theme.syntax.deleted.color).toBe("#990000");
  expect(isEditorTheme(JSON.parse(JSON.stringify(theme)))).toBe(true);
});

test("специфичность области важнее порядка, стили наследуются и явно сбрасываются", () => {
  const theme = importEditorTheme({ ...vscodeTheme, tokenColors: [
    { scope: "string.quoted", settings: { foreground: "#123456", fontStyle: "bold italic underline strikethrough" } },
    { scope: "string", settings: { foreground: "#abcdef" } },
    { scope: "string.quoted", settings: { fontStyle: "" } },
    { scope: "source.ts string.quoted", settings: { foreground: "#ff0000" } },
  ] });
  expect(theme.syntax.string).toMatchObject({ color: "#123456", fontStyle: "normal", fontWeight: "normal", textDecoration: "none" });
  expect(theme.syntax.regexp.color).toBe("#abcdef");
});

test("глобальные настройки TextMate поддерживаются, цвета редактора имеют приоритет", () => {
  const theme = importEditorTheme({ ...vscodeTheme, colors: {}, tokenColors: [
    { settings: { background: "#112233", foreground: "#aabbcc" } },
  ] });
  expect(theme.colors.background).toBe("#112233");
  expect(theme.colors.foreground).toBe("#aabbcc");
  expect(theme.colors.cursor).toBe("#aabbcc");
  expect(theme.syntax.keyword.color).toBe("#aabbcc");
  expect(importEditorTheme({ ...vscodeTheme, tokenColors: [{ settings: { foreground: "#aabbcc" } }] }).colors.foreground).toBe("#202020");
});

test("специфичные области Markdown сохраняют оформление заголовков и встроенного кода", () => {
  const theme = importEditorTheme({ ...vscodeTheme, tokenColors: [
    { scope: "markup.heading.markdown", settings: { foreground: "#123456" } },
    { scope: "markup.inline.raw.string.markdown", settings: { foreground: "#234567" } },
    { scope: "markup.bold.markdown", settings: { fontStyle: "bold" } },
  ] });
  expect(theme.syntax.heading).toMatchObject({ color: "#123456", fontWeight: "bold" });
  expect(theme.syntax.monospace.color).toBe("#234567");
  expect(theme.syntax.strong.fontWeight).toBe("bold");
});

test.each([
  { ...vscodeTheme, colors: { "editor.background": "url(https://example.com)" } },
  { ...vscodeTheme, colors: { "editor.foreground": 42 } },
  { ...vscodeTheme, colors: { "editor.foreground": ["#ffffff"] } },
  { ...vscodeTheme, tokenColors: [{ scope: 42, settings: {} }] },
  { ...vscodeTheme, tokenColors: [{ settings: { foreground: "red;display:none" } }] },
  { ...vscodeTheme, tokenColors: [{ settings: { fontStyle: "position:absolute" } }] },
  { ...vscodeTheme, tokenColors: [{ settings: { fontStyle: "bolditalic" } }] },
  { ...vscodeTheme, id: "" }, null,
])("некорректная тема не превращается в CSS: %j", value => {
  expect(() => importEditorTheme(value)).toThrow();
});

test("флаги оформления допускают пробелы и переносят все четыре стиля", () => {
  const theme = importEditorTheme({ ...vscodeTheme, tokenColors: [
    { scope: "keyword", settings: { fontStyle: "  bold italic  underline strikethrough " } },
  ] });
  expect(theme.syntax.keyword).toMatchObject({ fontWeight: "bold", fontStyle: "italic", textDecoration: "underline line-through" });
});

test.each(["normal", "regular"])("стиль %s из Dracula сбрасывает оформление", fontStyle => {
  const theme = importEditorTheme({ ...vscodeTheme, tokenColors: [
    { scope: "comment", settings: { fontStyle } },
  ] });
  expect(theme.syntax.comment).toMatchObject({ fontWeight: "normal", fontStyle: "normal", textDecoration: "none" });
});

test("повреждённая сохранённая тема не принимается за готовое оформление", () => {
  const theme = importEditorTheme(vscodeTheme);
  expect(isEditorTheme({ ...theme, colors: { ...theme.colors, background: "url(https://example.com)" } })).toBe(false);
  expect(isEditorTheme({ ...theme, syntax: { ...theme.syntax, keyword: { backgroundImage: "url(https://example.com)" } } })).toBe(false);
  expect(isEditorTheme({ ...theme, syntax: {} })).toBe(false);
  expect(isEditorTheme(defaultEditorTheme)).toBe(false);
  expect(editorHighlightStyle(defaultEditorTheme).style([tags.keyword])).toBeTruthy();
});

test("неиспользуемые цвета оболочки VS Code не влияют на проверку цветов редактора", () => {
  const theme = importEditorTheme({ ...vscodeTheme, colors: {
    ...vscodeTheme.colors, "symbolIcon.constantForeground": ["#aff5b4", "#7ee787"],
  } });
  expect(theme.colors.background).toBe("#fafafa");
  expect(theme.syntax.keyword.color).toBe("#990099");
  expect(isEditorTheme(theme)).toBe(true);
});
