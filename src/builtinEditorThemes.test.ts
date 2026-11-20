import { expect, test } from "vitest";
import { builtinEditorThemes } from "./builtinEditorThemes";
import { isEditorTheme } from "./editorThemes";

test("поставляются ровно пять готовых тем с уникальными идентификаторами", () => {
  expect(builtinEditorThemes.map(theme => theme.name)).toEqual([
    "One Dark Pro", "Dracula Theme", "Catppuccin Mocha", "GitHub Dark Default", "GitHub Light Default",
  ]);
  expect(new Set(builtinEditorThemes.map(theme => theme.id)).size).toBe(5);
  expect(builtinEditorThemes.some(theme => !theme.dark)).toBe(true);
});

test.each(builtinEditorThemes)("$name содержит безопасную палитру и различимые основные категории", theme => {
  expect(isEditorTheme(theme)).toBe(true);
  expect(theme.colors.background.toLowerCase()).not.toBe(theme.colors.foreground.toLowerCase());
  for (const category of ["keyword", "string", "comment"]) {
    expect(theme.syntax[category].color!.toLowerCase()).not.toBe(theme.colors.foreground.toLowerCase());
  }
  expect(theme.syntax.strong.fontWeight).toBe("bold");
  expect(theme.syntax.emphasis.fontStyle).toBe("italic");
  expect(theme.syntax.link.textDecoration).toContain("underline");
});
