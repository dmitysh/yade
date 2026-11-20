// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import App from "./App";
import type { FileLinks } from "./fileLinks";
import type { Snapshot, View } from "./types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));
vi.mock("./Lifecycle", () => ({ default: () => null }));
vi.mock("./CodeEditor", () => ({
  default: ({ path, body, location, change }: any) => <textarea aria-label={`Код ${path}`} value={body} data-line={location?.line} data-column={location?.column} onChange={event => change(event.target.value)} />,
  Comparison: () => null,
}));
vi.mock("./Terminal", () => ({
  terminalTitle: () => "Терминал",
  TerminalPanel: ({ openFile, workspacePath, active }: FileLinks & { active: boolean }) => <section hidden={!active}>
    <span>{workspacePath}</span><button onClick={() => void openFile?.("src/App.tsx", { line: 12, column: 3, request: 1 })}>Файл из терминала</button>
    <button onClick={() => void openFile?.("src/App.tsx", { line: 293, column: 1, request: 2 }, "other-w")}>Файл другого проекта из терминала</button>
  </section>,
}));

afterEach(() => { cleanup(); vi.resetAllMocks(); localStorage.clear(); });

test.each(["codex", "claude", "terminal"])("переход из %s открывает вкладку нужного пространства и сохраняет черновик при повторном открытии", async source => {
  const workspace = { id: "w", projectId: "p", groupId: null, name: "Основное", path: "/project/worktree", kind: "folder", archived: false, deleted: false,
    sourceRef: null, sourceCommit: null, gitRef: null, operationState: "ready", operationError: null, preparationCommand: null, preparationState: "skipped", preparationOutput: "" };
  const session = { id: "s", workspaceId: "w", executor: source === "terminal" ? "codex" : source, title: "Разговор", state: "ready" };
  const sourceTab = source === "terminal" ? "terminal:t" : "session:s";
  const data: Snapshot = { groups: [], projects: [{ id: "p", name: "Проект", groupId: null, path: "/project", kind: "folder", preparationCommand: null }],
    workspaces: [workspace], sessions: [session], view: { projectId: "p", workspaceId: "w", tabs: [
      { id: sourceTab, workspaceId: "w", sessionId: source === "terminal" ? null : "s" },
    ], activeTabs: { w: sourceTab }, sidebarWidth: 260 } };
  const body = "[Код](/project/worktree/src/App.tsx:12:3)";
  vi.mocked(invoke).mockImplementation(async (command, args: any) => {
    if (command === "snapshot") return structuredClone(data);
    if (["list_directory", "list_file_drafts", "executor_availability"].includes(command)) return [];
    if (command === "save_view") { data.view = structuredClone((args as { view: View }).view); return; }
    if (command === "read_conversation") return { session, context: null, canStop: false, messages: [
      { sequence: 1, sessionId: "s", runId: null, role: "assistant", body },
    ], messageEvents: {}, events: [], requests: [], olderMessages: false, olderEvents: false, draft: "" };
    if (command === "open_file") return { path: args.path, body: "исходный текст", base: "исходный текст", disk: "исходный текст" };
    if (command === "save_file_draft") return;
    throw new Error(command);
  });
  render(<App />);
  async function followLink() {
    const role = source === "terminal" ? "button" : "link";
    const name = source === "terminal" ? "Файл из терминала" : "Код";
    await screen.findByRole(role, { name });
    fireEvent.click(screen.getByRole(role, { name }));
  }
  await followLink();
  const editor = await screen.findByRole("textbox", { name: "Код src/App.tsx" });
  expect(editor.getAttribute("data-line")).toBe("12");
  expect(editor.getAttribute("data-column")).toBe("3");
  expect(invoke).toHaveBeenCalledWith("open_file", { workspaceId: "w", path: "src/App.tsx" });
  fireEvent.change(editor, { target: { value: "мой черновик" } });
  fireEvent.click(screen.getByRole("tab", { name: source === "terminal" ? "Терминал" : /Разговор/ }));
  await followLink();
  await waitFor(() => expect(screen.getByRole("textbox", { name: "Код src/App.tsx" })).toBe(editor));
  expect((editor as HTMLTextAreaElement).value).toBe("мой черновик");
  expect(data.view.tabs.filter(tab => tab.id === "file:w:src/App.tsx")).toHaveLength(1);
});

test.each(["codex", "claude", "terminal"])("ссылка из %s переключает проект и использует его открытый редактор", async source => {
  const workspace = { id: "w", projectId: "p", groupId: null, name: "Основное", path: "/frontend", kind: "folder", archived: false, deleted: false,
    sourceRef: null, sourceCommit: null, gitRef: null, operationState: "ready", operationError: null, preparationCommand: null, preparationState: "skipped", preparationOutput: "" };
  const other = { ...workspace, id: "other-w", projectId: "other-p", path: "/backend" };
  const session = { id: "s", workspaceId: "w", executor: source === "terminal" ? "codex" : source, title: "Разговор", state: "ready" };
  const sourceTab = source === "terminal" ? "terminal:t" : "session:s";
  const data: Snapshot = {
    groups: [], projects: [{ id: "p", name: "Первый проект", groupId: null, path: "/frontend", kind: "folder", preparationCommand: null },
      { id: "other-p", name: "Другой проект", groupId: null, path: "/backend", kind: "folder", preparationCommand: null }],
    workspaces: [workspace, other], sessions: [session], view: { projectId: "p", workspaceId: "w", tabs: [
      { id: sourceTab, workspaceId: "w", sessionId: source === "terminal" ? null : "s" },
      { id: "file:w:src/App.tsx", workspaceId: "w", sessionId: null },
      { id: "file:other-w:src/App.tsx", workspaceId: "other-w", sessionId: null },
    ], activeTabs: { w: sourceTab, "other-w": "file:other-w:src/App.tsx" }, sidebarWidth: 260 },
  };
  vi.mocked(invoke).mockImplementation(async (command, args: any) => {
    if (command === "snapshot") return structuredClone(data);
    if (["list_directory", "list_file_drafts", "executor_availability"].includes(command)) return [];
    if (command === "save_view") { data.view = structuredClone((args as { view: View }).view); return; }
    if (command === "read_conversation") return { session, context: null, canStop: false, messages: [
      { sequence: 1, sessionId: "s", runId: null, role: "assistant", body: "[Код другого проекта](/backend/src/App.tsx:293)" },
    ], messageEvents: {}, events: [], requests: [], olderMessages: false, olderEvents: false, draft: "" };
    if (command === "open_file") {
      const body = args.workspaceId === "other-w" ? "черновик другого проекта" : "текст текущего проекта";
      return { path: args.path, body, base: body, disk: body };
    }
    if (command === "save_file_draft") return;
    throw new Error(command);
  });
  const { container } = render(<App />);
  const targetEditor = await waitFor(() => {
    const editor = container.querySelector<HTMLTextAreaElement>('[id="file:other-w:src/App.tsx"] textarea');
    expect(editor).toBeTruthy();
    return editor!;
  });
  const role = source === "terminal" ? "button" : "link";
  const name = source === "terminal" ? "Файл другого проекта из терминала" : "Код другого проекта";
  await screen.findByRole(role, { name });
  fireEvent.click(screen.getByRole(role, { name }));
  const editor = await screen.findByRole("textbox", { name: "Код src/App.tsx" });
  expect(editor).toBe(targetEditor);
  expect((editor as HTMLTextAreaElement).value).toBe("черновик другого проекта");
  expect(editor.getAttribute("data-line")).toBe("293");
  expect(data.view.projectId).toBe("other-p");
  expect(data.view.workspaceId).toBe("other-w");
  expect(data.view.tabs.some(tab => tab.id === sourceTab)).toBe(true);
  expect(data.view.tabs.some(tab => tab.id === "file:w:src/App.tsx")).toBe(true);
  expect(data.view.tabs.filter(tab => tab.id === "file:other-w:src/App.tsx")).toHaveLength(1);
  expect(vi.mocked(invoke).mock.calls.filter(([command, args]) => command === "open_file" && (args as any).workspaceId === "other-w")).toHaveLength(1);
});
