import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { expect, test } from "vitest";
import { editorLinkAt } from "./editorLinks";

test.each([
  ["[стейджинг](http://dashboards.staging.example.test:5601/),", "стейджинг", "http://dashboards.staging.example.test:5601/"],
  ["[прод](http://dashboards.prod.example.test:5601/).", "http", "http://dashboards.prod.example.test:5601/"],
  ["[**документ**](https://example.com/a_(b)?q=1&x=2#part)", "документ", "https://example.com/a_(b)?q=1&x=2#part"],
  ["[документ](<https://example.com/path> \"Название\")", "документ", "https://example.com/path"],
  ["<https://example.com/>", "example", "https://example.com/"],
  ["[документ](javascript:alert(1))", "документ", null],
  ["[документ](file:///etc/passwd)", "документ", null],
  ["[документ](./notes.md)", "документ", null],
])("ссылка Markdown: %s", (body, at, expected) => {
  const state = EditorState.create({ doc: body, extensions: [markdown()] });
  expect(editorLinkAt(state, body.indexOf(at) + 1)).toBe(expected);
});

test.each([
  ["Адрес http://localhost:5601/.", "localhost", "http://localhost:5601/"],
  ["(https://example.com/a_(b)?q=1&x=2#part).", "example", "https://example.com/a_(b)?q=1&x=2#part"],
  ["https://one.test/, https://two.test/path;", "two", "https://two.test/path"],
  ["http://[::1]:5601/", "::1", "http://[::1]:5601/"],
  ["HTTP://example.com/path", "example", "HTTP://example.com/path"],
  ["Текст\nhttps://example.com/path", "example", "https://example.com/path"],
  ["Адрес https://example.com/.", ".", null],
  ["Текст https://example.com/path", "Текст", null],
  ["http://", "http", null],
  ["javascript:alert(1)", "alert", null],
])("ссылка в обычном тексте: %s", (body, at, expected) => {
  const state = EditorState.create({ doc: body });
  const position = at === "." ? body.length - 1 : body.indexOf(at) + 1;
  expect(editorLinkAt(state, position)).toBe(expected);
});
