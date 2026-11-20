import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { classHighlighter, highlightTree } from "@lezer/highlight";
import { expect, test } from "vitest";
import { editorLanguages } from "./fileLanguages";
import { fileTypes } from "./fileTypes";
import { editorHighlightStyle, importEditorTheme } from "./editorThemes";
import { vscodeTheme } from "./test-fixtures/editorTheme";
import { builtinEditorThemes } from "./builtinEditorThemes";

const samples: [string, string, string, string][] = [
  ["Go", 'package main\nfunc main() { println("hello") }', "func", "keyword"],
  ["Rust", 'fn main() { let value = "hello"; }', "fn", "keyword"],
  ["JavaScript", 'const value = "hello";', "const", "keyword"],
  ["TypeScript", 'interface User { name: string }; const value: number = 42;', "interface", "keyword"],
  ["JSX", 'const value = <div title="hello" />;', "div", "typeName"],
  ["TSX", 'const value: JSX.Element = <div title="hello" />;', "div", "typeName"],
  ["Python", 'def main():\n  return "hello"', "def", "keyword"],
  ["Java", 'public class Main { String name = "hello"; }', "class", "keyword"],
  ["Kotlin", 'fun main() { val name = "hello" }', "fun", "keyword"],
  ["C", '#include <stdio.h>\nint main() { return 42; }', "return", "keyword"],
  ["C++", 'class Main { public: int value = 42; };', "class", "keyword"],
  ["C#", 'public class Main { string name = "hello"; }', "class", "keyword"],
  ["PHP", '<?php function main() { return "hello"; }', "function", "keyword"],
  ["Ruby", 'def main\n  "hello"\nend', "def", "keyword"],
  ["Swift", 'func main() { let name = "hello" }', "func", "keyword"],
  ["Dart", 'class Main { var name = "hello"; }', "class", "keyword"],
  ["Lua", 'local name = "hello"\nreturn name', "local", "keyword"],
  ["Shell", 'export NAME="hello"\necho "$NAME"', "export", "keyword"],
  ["PowerShell", 'function Main { Write-Host "hello" }', "function", "keyword"],
  ["HTML", '<div title="hello">text</div>', "div", "typeName"],
  ["CSS", '.main { color: red; }', "color", "propertyName"],
  ["Sass", '$color: red\n.main\n  color: $color', "red", "atom"],
  ["SCSS", '$color: red; .main { color: $color; }', "red", "atom"],
  ["LESS", '@color: red; .main { color: @color; }', "red", "atom"],
  ["Vue", '<template><div title="hello">text</div></template>', "div", "typeName"],
  ["JSON", '{"name": "hello", "count": 42}', "42", "number"],
  ["JSONC", '{\n// comment\n"name": "hello",\n}', "// comment", "comment"],
  ["YAML", 'name: "hello"\ncount: 42', '"hello"', "string"],
  ["TOML", 'name = "hello"\ncount = 42', '"hello"', "string"],
  ["Properties files", '[section]\nname = hello\n# comment', "# comment", "comment"],
  ["Env", 'export NAME="hello"\n# comment', "NAME", "variableName"],
  ["Markdown", '# Heading\n\n**bold**', "Heading", "heading"],
  ["XML", '<root name="hello" />', "root", "typeName"],
  ["SVG", '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>', "svg", "typeName"],
  ["SQL", "SELECT name FROM users WHERE id = 42;", "SELECT", "keyword"],
  ["ProtoBuf", 'syntax = "proto3"; message User { string name = 1; }', "message", "keyword"],
  ["Dockerfile", 'FROM alpine\nRUN echo "hello"', "FROM", "keyword"],
  ["CMake", 'set(NAME "hello")\n# comment', "# comment", "comment"],
  ["Nginx", 'server { listen 80; server_name example.com; }', "server", "keyword"],
  ["diff", '--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new\n', "+new", "inserted"],
];

async function parse(id: string, body: string) {
  const support = await editorLanguages.find(language => language.name === id)!.load();
  const state = EditorState.create({ doc: body, extensions: support });
  const tree = ensureSyntaxTree(state, state.doc.length, 1000)!;
  expect(tree).toBeTruthy();
  const tokens: { text: string; classes: string; from: number; to: number }[] = [];
  highlightTree(tree, classHighlighter, (from, to, classes) => tokens.push({ text: body.slice(from, to), classes, from, to }));
  return { tree, tokens };
}

test.each(samples)("%s выдаёт реальные токены подсветки", async (id, body, token, tag) => {
  const { tokens } = await parse(id, body);
  expect(tokens.some(item => item.text.includes(token) && item.classes.includes(`tok-${tag}`)), JSON.stringify(tokens)).toBe(true);
});

test("проверен каждый режим обязательного набора", () => {
  expect(samples.map(([id]) => id).sort()).toEqual(fileTypes.filter(type => type.id !== "text").map(type => type.id).sort());
});

const themeHighlights = [importEditorTheme(vscodeTheme), ...builtinEditorThemes].map(theme => ({ name: theme.name, highlight: editorHighlightStyle(theme) }));
test.each(samples)("все встроенные и импортированная темы сохраняют подсветку %s и вложенного блока Markdown", async (id, body, token) => {
  for (const [mode, source] of [[id, body], ...(id === "Markdown" ? [] : [["Markdown", "```" + (id === "Properties files" ? "ini" : id) + "\n" + body + "\n```"]])]) {
    const { tree } = await parse(mode, source);
    for (const theme of themeHighlights) {
      const tokens: string[] = [];
      highlightTree(tree, theme.highlight, (from, to, classes) => { if (classes) tokens.push(source.slice(from, to)); });
      expect(tokens.some(text => text.includes(token)), theme.name + " / " + mode + ": " + JSON.stringify(tokens)).toBe(true);
    }
  }
});

test("JSONC допускает комментарии и завершающие запятые", async () => {
  const body = '{ /* comment */ "items": [1, 2,], "active": true, }';
  const { tree, tokens } = await parse("JSONC", body);
  tree.iterate({ enter: node => { expect(node.type.isError).toBe(false); } });
  expect(tokens.some(token => token.text === "/* comment */" && token.classes.includes("comment"))).toBe(true);
  expect(tokens.some(token => token.text === "true" && token.classes.includes("atom"))).toBe(true);
});

test("переменные окружения различают имена, значения, комментарии и многострочные строки", async () => {
  const { tokens } = await parse("Env", '\uFEFFexport NAME=hello # comment\nQUOTED="a#b\nc"\nNEXT=42');
  for (const [text, tag] of [["NAME", "variableName"], ["hello ", "string"], ["# comment", "comment"], ['"a#b', "string"], ['c"', "string"], ["NEXT", "variableName"], ["42", "string"]]) {
    expect(tokens.some(token => token.text === text && token.classes.includes(tag)), JSON.stringify(tokens)).toBe(true);
  }
});

test.each(["HTML", "Vue"])("%s подсвечивает вложенные JavaScript, TypeScript и CSS", async id => {
  const body = '<template><div>hello</div></template>\n<script>const value = "hello";</script>\n<script lang="ts">interface User { name: string }</script>\n<style>.main { color: red; }</style>';
  const { tree, tokens } = await parse(id, body);
  for (const [text, tag] of [["div", "typeName"], ["const", "keyword"], ["interface", "keyword"], ["color", "propertyName"]]) {
    expect(tokens.some(token => token.text === text && token.classes.includes(tag)), JSON.stringify(tokens)).toBe(true);
  }
  for (const theme of themeHighlights) {
    const themedTokens: string[] = [];
    highlightTree(tree, theme.highlight, (from, to, classes) => { if (classes) themedTokens.push(body.slice(from, to)); });
    for (const text of ["div", "const", "interface", "color"]) expect(themedTokens.includes(text), theme.name + ": " + JSON.stringify(themedTokens)).toBe(true);
  }
});

test.each(samples.filter(([id]) => id !== "Markdown"))("Markdown подсвечивает именованный блок %s", async (id, code, token, tag) => {
  const body = `\`\`\`${id === "Properties files" ? "ini" : id}\n${code}\n\`\`\``;
  const { tokens } = await parse("Markdown", body);
  expect(tokens.some(item => item.text.includes(token) && item.classes.includes(`tok-${tag}`)), JSON.stringify(tokens)).toBe(true);
});

test("неизвестный язык блока Markdown остаётся текстом", async () => {
  const body = '```unknown-javascript\nconst value = "hello";\n```';
  const { tokens } = await parse("Markdown", body);
  expect(tokens.some(token => token.classes.includes("keyword"))).toBe(false);
});
