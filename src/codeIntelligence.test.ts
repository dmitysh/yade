// @vitest-environment jsdom
import { expect, test } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { applyTextEdits, codeWorkspace, currentLocation, fileFromUri, fileUri, navigateHistory, recordNavigation } from "./codeIntelligence";

test("адреса файлов сохраняют пробелы, Unicode и специальные символы", () => {
  const root = "file:///tmp/space%20root/";
  const path = "папка/a #1.ts";
  expect(fileFromUri(root, fileUri(root, path))).toBe(path);
  expect(fileFromUri(root, "file:///tmp/space%20root-other/file.ts")).toBe("file:///tmp/space%20root-other/file.ts");
  expect(() => fileFromUri(root, "https://example.com/code.ts")).toThrow();
});

test.each(["\n", "\r\n"])("переименование применяет UTF-16 позиции и сохраняет окончания %j", separator => {
  const body = `const emoji = "🦀"; const oldName = 1;${separator}oldName;${separator}`;
  const first = body.indexOf("oldName");
  const renamed = applyTextEdits(body, [
    { range: { start: { line: 0, character: first }, end: { line: 0, character: first + 7 } }, newText: "newName" },
    { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 7 } }, newText: "newName" },
  ]);
  expect(renamed).toBe(body.replaceAll("oldName", "newName"));
  expect(() => applyTextEdits(body, [{ range: { start: { line: 4, character: 0 }, end: { line: 4, character: 1 } }, newText: "x" }])).toThrow();
});

test("история возвращает живую позицию курсора и обрезает будущие переходы", async () => {
  const workspaceId = "history-check", workspace = codeWorkspace(workspaceId);
  const view = new EditorView({ state: EditorState.create({ doc: "first\nsecond" }) });
  workspace.activePath = "first.ts"; workspace.editors.set("first.ts", view);
  const opened: string[] = [];
  workspace.open = async path => { opened.push(path); };
  recordNavigation(workspaceId, { path: "second.ts", line: 1, column: 1 });
  view.dispatch({ selection: { anchor: 8 } });
  expect(currentLocation(workspaceId)).toMatchObject({ line: 2, column: 3 });
  await navigateHistory(workspaceId, -1);
  expect(opened).toEqual(["first.ts"]);
  recordNavigation(workspaceId, { path: "third.ts", line: 1, column: 1 });
  expect(workspace.history.some(location => location.path === "second.ts")).toBe(false);
  view.destroy(); workspace.editors.clear();
});
