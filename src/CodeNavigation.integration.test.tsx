// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { useState } from "react";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node";
import { invoke } from "@tauri-apps/api/core";
import { LSPPlugin } from "@codemirror/lsp-client";
import type { CompletionList, DocumentSymbol, Hover, Location, SymbolInformation } from "vscode-languageserver-protocol";
import CodeNavigation from "./CodeNavigation";
import { FilePanel, flushFiles } from "./Files";
import { activeEditor, codeWorkspace, currentLocation, navigateHistory, recordNavigation, requestLocations } from "./codeIntelligence";
import type { FileLocation } from "./CodeEditor";
import type { FileDocument } from "./types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class { onmessage = (_message: unknown) => {}; } }));
const processes = new Map<string, { child: ChildProcessWithoutNullStreams; writer: StreamMessageWriter; reader: StreamMessageReader }>();
const directories: string[] = [];
beforeAll(() => {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  HTMLElement.prototype.scrollIntoView = () => {};
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
});
afterEach(async () => {
  cleanup(); await flushFiles();
  for (const process of processes.values()) {
    process.reader.dispose(); process.writer.dispose();
    if (process.child.pid) { try { globalThis.process.kill(-process.child.pid, "SIGKILL"); } catch {} }
  }
  processes.clear(); vi.resetAllMocks();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

function Harness({ workspaceId, initial }: { workspaceId: string; initial: string }) {
  const [paths, setPaths] = useState([initial]);
  const [active, setActive] = useState(initial);
  const [locations, setLocations] = useState<Record<string, FileLocation>>({});
  async function open(path: string, location?: FileLocation) {
    recordNavigation(workspaceId, { path, line: location?.line ?? 1, column: location?.column ?? 1, utf16: location?.utf16 }, currentLocation(workspaceId));
    setPaths(current => current.includes(path) ? current : [...current, path]); setActive(path);
    if (location) setLocations(current => ({ ...current, [path]: location }));
  }
  return <div className="ide-app ide-live"><CodeNavigation workspaceId={workspaceId} open={open} /><div className="ide-editor-body">{paths.map(path => <FilePanel key={path} tab={{ id: `file:${workspaceId}:${path}`, workspaceId, sessionId: null }} active={path === active} focused={path === active} location={locations[path]} dirty={() => {}} />)}</div></div>;
}

async function fixture(language: "go" | "typescript") {
  const directory = await mkdtemp(join(tmpdir(), "yade-navigation-")); directories.push(directory);
  const workspaceId = `integration-${language}-${Date.now()}`;
  const files = language === "go" ? {
    "go.mod": "module example.test/navigation\n\ngo 1.24.0\n",
    "api.go": 'package navigation\nimport "fmt"\ntype Greeter interface { Greet() string }\ntype Friendly struct{}\nfunc (Friendly) Greet() string { return "hi" }\nfunc Format(value string) string { return fmt.Sprint(value) }\n',
    "usage.go": 'package navigation\nfunc Run() string { var value Greeter = Friendly{}; return Format(value.Greet()) }\n',
  } : {
    "tsconfig.json": '{"compilerOptions":{"strict":true,"target":"ES2022","module":"commonjs"},"include":["*.ts"]}',
    "api.ts": 'export interface Greeter { greet(): string; }\nexport class Friendly implements Greeter { greet() { return "hi"; } }\nexport function format(value: string): string { return value; }\n',
    "usage.ts": 'import * as api from "./api";\nconst value: api.Greeter = new api.Friendly();\nexport const result = api.format(value.greet());\n',
  };
  for (const [name, body] of Object.entries(files)) await writeFile(join(directory, name), body);
  const drafts = new Map<string, { body: string; base: string }>();
  let trusted = language === "go";
  const nativeOpen = async (path: string): Promise<FileDocument> => {
    const disk = await readFile(join(directory, path), "utf8"), draft = drafts.get(path);
    return { path, disk, body: draft?.body ?? disk, base: draft?.base ?? disk };
  };
  vi.mocked(invoke).mockImplementation(async (command, args: any) => {
    if (command === "language_tools") return [{ language: "go", available: true, prerequisite: null }, { language: "typescript", available: true, prerequisite: null }];
    if (command === "start_language_server") {
      if (!trusted && !args.confirmTrust) return null;
      trusted = true;
      const executable = language === "go" ? process.env.YADE_GOPLS ?? "gopls" : process.execPath;
      const arguments_ = language === "go" ? [] : [process.env.YADE_TYPESCRIPT_SERVER ?? "typescript-language-server", "--stdio"];
      const child = spawn(executable, arguments_, { cwd: directory, env: { ...process.env, GOPROXY: "off", GOSUMDB: "off", GOTOOLCHAIN: "local", GOPLSCACHE: join(directory, ".cache") }, stdio: "pipe", detached: true });
      const reader = new StreamMessageReader(child.stdout), writer = new StreamMessageWriter(child.stdin);
      reader.listen(message => args.events.onmessage({ message: JSON.stringify(message), error: null }));
      let stderr = "";
      child.stderr.on("data", chunk => { stderr += chunk.toString(); });
      child.on("error", error => args.events.onmessage({ message: null, error: String(error) }));
      child.on("exit", () => args.events.onmessage({ message: null, error: stderr || "server closed" }));
      const id = `${workspaceId}-${processes.size}`; processes.set(id, { child, reader, writer });
      return { id, rootUri: pathToFileURL(directory + "/").href };
    }
    if (command === "send_language_message") { await processes.get(args.id)!.writer.write(JSON.parse(args.message)); return; }
    if (command === "stop_language_server") { const server = processes.get(args.id); if (server?.child.pid) { try { process.kill(-server.child.pid, "SIGKILL"); } catch {} } return; }
    if (command === "open_file") return nativeOpen(args.path);
    if (command === "read_file_disk") return readFile(join(directory, args.path), "utf8");
    if (command === "read_git_file") return "";
    if (command === "read_language_file") { const body = await readFile(fileURLToPath(args.uri), "utf8"); return { path: args.uri, body, base: body, disk: body }; }
    if (command === "save_file_draft") { if (args.body === args.base) drafts.delete(args.path); else drafts.set(args.path, { body: args.body, base: args.base }); return; }
    if (command === "save_file") { await writeFile(join(directory, args.document.path), args.document.body); drafts.delete(args.document.path); return nativeOpen(args.document.path); }
    if (command === "list_source_files") return Object.keys(files);
    if (command === "apply_file_edits") {
      for (const edit of args.edits) expect(await readFile(join(directory, edit.document.path), "utf8")).toBe(edit.document.base);
      for (const edit of args.edits) { await writeFile(join(directory, edit.document.path), edit.body); drafts.delete(edit.document.path); }
      return Promise.all(args.edits.map((edit: any) => nativeOpen(edit.document.path)));
    }
    throw new Error(`Неожиданная команда: ${command}`);
  });
  return { directory, workspaceId, source: language === "go" ? "api.go" : "api.ts", usage: language === "go" ? "usage.go" : "usage.ts", name: language === "go" ? "Format" : "format" };
}

test.skipIf(process.env.YADE_LANGUAGE_INTEGRATION !== "1").each(["go", "typescript"] as const)("настоящий %s: переходы, символы, подсказки, автодополнение, диагностика и переименование", async language => {
  const { directory, workspaceId, source, usage, name } = await fixture(language);
  render(<Harness workspaceId={workspaceId} initial={usage} />);
  if (language === "typescript") fireEvent.click(await screen.findByRole("button", { name: "Подключить навигацию" }));
  await waitFor(() => expect(codeWorkspace(workspaceId).sessions.get(language)?.status).toBe("ready"), { timeout: 20000 });
  await waitFor(() => expect(activeEditor(workspaceId) && LSPPlugin.get(activeEditor(workspaceId)!)).toBeTruthy());
  let view = activeEditor(workspaceId)!;
  await act(async () => { view.dispatch({ selection: { anchor: view.state.sliceDoc().lastIndexOf(name) + 1 } }); await requestLocations(workspaceId, view, "textDocument/definition"); });
  await waitFor(() => expect(codeWorkspace(workspaceId).activePath).toBe(source));
  await waitFor(() => expect(LSPPlugin.get(activeEditor(workspaceId)!)).toBeTruthy());
  view = activeEditor(workspaceId)!;
  const plugin = LSPPlugin.get(view)!, client = plugin.client;
  const nameOffset = view.state.sliceDoc().lastIndexOf(name);
  const symbols = await client.request<object, DocumentSymbol[]>("textDocument/documentSymbol", { textDocument: { uri: plugin.uri } });
  expect(symbols.some(symbol => symbol.name === name)).toBe(true);
  const hover = await client.request<object, Hover>("textDocument/hover", { textDocument: { uri: plugin.uri }, position: plugin.toPosition(nameOffset + 1) });
  expect(JSON.stringify(hover.contents)).toContain(name);
  const implementation = await client.request<object, Location[]>("textDocument/implementation", { textDocument: { uri: plugin.uri }, position: plugin.toPosition(view.state.sliceDoc().indexOf("Greeter") + 1) });
  expect(implementation.length).toBeGreaterThan(0);
  await act(async () => {
    const coordinates = vi.spyOn(view, "posAtCoords").mockReturnValue(nameOffset + 1);
    fireEvent.mouseDown(view.contentDOM, { button: 0, metaKey: true, clientX: 10, clientY: 10 });
    coordinates.mockRestore();
  });
  await waitFor(() => expect(codeWorkspace(workspaceId).activePath).toBe(usage));
  expect(screen.queryByRole("dialog", { name: /^Использования/ })).toBeNull();
  await act(async () => { await navigateHistory(workspaceId, -1); });
  await waitFor(() => expect(codeWorkspace(workspaceId).activePath).toBe(source));
  const usageView = codeWorkspace(workspaceId).editors.get(usage)!;
  const usagePlugin = LSPPlugin.get(usageView)!;
  const another = language === "go" ? '\nfunc Another() string { return Format("other") }\n' : '\nexport const another = api.format("other");\n';
  await act(async () => {
    usageView.dispatch({ changes: { from: usageView.state.doc.length, insert: another } });
    fireEvent.keyDown(view.contentDOM, { key: "b", code: "KeyB", metaKey: true });
  });
  const references = await screen.findByRole("dialog", { name: `Использования · ${name}` });
  expect(within(references).getAllByRole("option")).toHaveLength(2);
  expect(within(references).getAllByRole("option").some(option => option.textContent?.includes(usage))).toBe(true);
  expect(within(references).getAllByRole("option").some(option => option.textContent?.includes('"other"'))).toBe(true);
  fireEvent.click(within(references).getByRole("button", { name: /^Закрыть Использования/ }));
  const value = usageView.state.sliceDoc().lastIndexOf("value");
  await act(async () => {
    await navigateHistory(workspaceId, 1);
    usageView.dispatch({ selection: { anchor: value + 1 } });
    await requestLocations(workspaceId, usageView, "textDocument/definition");
  });
  await waitFor(() => expect(codeWorkspace(workspaceId).activePath).toBe(usage));
  expect(usageView.state.selection.main.head).toBe(usageView.state.sliceDoc().indexOf("value"));
  await act(async () => {
    const coordinates = vi.spyOn(usageView, "posAtCoords").mockReturnValue(value + 1);
    fireEvent.mouseDown(usageView.contentDOM, { button: 0, metaKey: true, shiftKey: true, clientX: 10, clientY: 10 });
    coordinates.mockRestore();
  });
  await waitFor(() => expect(codeWorkspace(workspaceId).activePath).toBe(source));
  expect(view.state.selection.main.head).toBe(view.state.sliceDoc().indexOf("Greeter"));
  await act(async () => {
    const coordinates = vi.spyOn(view, "posAtCoords").mockReturnValue(view.state.sliceDoc().indexOf("Greeter") + 1);
    fireEvent.mouseDown(view.contentDOM, { button: 0, metaKey: true, altKey: true, clientX: 10, clientY: 10 });
    coordinates.mockRestore();
  });
  await waitFor(() => expect(view.state.selection.main.head).toBe(view.state.sliceDoc().indexOf("Friendly")));
  const original = usageView.state.sliceDoc(), call = original.lastIndexOf(name);
  await act(async () => { usageView.dispatch({ changes: { from: call, to: call + name.length, insert: name.slice(0, 2) } }); });
  client.sync();
  const completion = await client.request<object, CompletionList>("textDocument/completion", { textDocument: { uri: usagePlugin.uri }, position: usagePlugin.toPosition(call + 2), context: { triggerKind: 1 } });
  expect(completion.items.some(item => item.label === name)).toBe(true);
  await act(async () => { usageView.dispatch({ changes: { from: call, to: call + 2, insert: name } }); view.dispatch({ selection: { anchor: nameOffset + 1 }, changes: { from: view.state.doc.length, insert: "\n// ручная правка\n" } }); });
  fireEvent.keyDown(view.contentDOM, { key: "F6", code: "F6", shiftKey: true });
  const rename = await screen.findByRole("dialog", { name: "Переименовать символ" });
  fireEvent.change(within(rename).getByRole("textbox", { name: "Новое имя" }), { target: { value: "Renamed" } });
  fireEvent.click(within(rename).getByRole("button", { name: "Предварительный просмотр" }));
  await within(rename).findByRole("button", { name: "Применить переименование" }, { timeout: 15000 });
  expect(within(rename).getAllByRole("option")).toHaveLength(2);
  expect(await readFile(join(directory, source), "utf8")).not.toContain("Renamed");
  fireEvent.click(within(rename).getByRole("button", { name: "Применить переименование" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Переименовать символ" })).toBeNull());
  expect(await readFile(join(directory, source), "utf8")).toContain("Renamed");
  expect(await readFile(join(directory, source), "utf8")).toContain("// ручная правка");
  expect(await readFile(join(directory, usage), "utf8")).toContain("Renamed");
  expect(activeEditor(workspaceId)!.state.sliceDoc()).toContain("Renamed");
  const current = activeEditor(workspaceId)!;
  const invalid = language === "go" ? '\nfunc Broken() { var broken int = "text"; _ = broken }\n' : '\nconst broken: number = "text";\n';
  await act(async () => { current.dispatch({ changes: { from: current.state.doc.length, insert: invalid } }); });
  client.sync();
  await waitFor(() => expect([...codeWorkspace(workspaceId).diagnostics.values()].flat().some(diagnostic => diagnostic.severity === 1)).toBe(true), { timeout: 15000 });
  const workspaceSymbols = await client.request<object, SymbolInformation[]>("workspace/symbol", { query: "Renamed" });
  expect(workspaceSymbols.some(symbol => symbol.name.includes("Renamed"))).toBe(true);
  if (language === "go") {
    const offset = current.state.sliceDoc().indexOf("Sprint");
    await act(async () => { current.dispatch({ selection: { anchor: offset + 1 } }); await requestLocations(workspaceId, current, "textDocument/definition"); });
    await waitFor(() => expect(codeWorkspace(workspaceId).activePath).toContain("file:"));
    expect((await screen.findByLabelText(/Зависимость file:/)).textContent).toContain("только для чтения");
    expect(activeEditor(workspaceId)!.state.readOnly).toBe(true);
  }
}, 60000);
