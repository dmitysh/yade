// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { EditorView } from "@codemirror/view";
import { useImperativeHandle, type Ref } from "react";
import App from "./App";
import type { ConversationData, Snapshot } from "./types";
import type { TerminalPanelHandle } from "./Terminal";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));
vi.mock("./Lifecycle", () => ({ default: () => null }));
const pasteToChat = vi.hoisted(() => vi.fn());
vi.mock("./Terminal", () => ({
  TerminalPanel: ({ id, ref }: { id: string; ref: Ref<TerminalPanelHandle> }) => {
    useImperativeHandle(ref, () => ({ pasteToChat: code => { pasteToChat(id, code); } }), [id]);
    return null;
  },
  terminalTitle: () => "Терминал",
}));

beforeAll(() => {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
});
afterEach(() => { cleanup(); vi.resetAllMocks(); localStorage.clear(); });

test.each(["открытый чат", "новый чат", "чат в терминале"])("код из редактора попадает в черновик (%s)", async destination => {
  const existing = destination === "открытый чат";
  const terminal = destination === "чат в терминале";
  const path = "notes.md";
  const body = "до\n  фрагмент\n```\nпосле";
  const snippet = "notes.md:2–3\n````\n  фрагмент\n```\n````";
  const draft = existing ? { text: "Проверь", paths: ["/project/file.txt"] } : { text: "", paths: [] };
  const workspace = { id: "w", projectId: "p", groupId: null, name: "Основное", path: "/project", kind: "folder",
    archived: false, deleted: false, sourceRef: null, sourceCommit: null, gitRef: null, operationState: "ready",
    operationError: null, preparationCommand: null, preparationState: "skipped", preparationOutput: "" };
  const session = { id: "s", workspaceId: "w", executor: "codex", title: "Разговор", state: "ready" };
  const fileTab = { id: "file:w:" + path, workspaceId: "w", sessionId: null };
  const sessionTab = { id: "session:s", workspaceId: "w", sessionId: "s" };
  const terminalInfo = { id: "t", workspaceId: "w", state: "running", exitCode: null, error: null, execution: { executor: "codex", state: "ready" } };
  const data: Snapshot = { groups: [], projects: [{ id: "p", name: "Проект", groupId: null, path: "/project", kind: "folder", preparationCommand: null }],
    workspaces: [workspace], sessions: existing ? [session] : [], terminals: terminal ? [terminalInfo] : [], view: { projectId: "p", workspaceId: "w",
      tabs: existing ? [fileTab, sessionTab] : [fileTab], activeTabs: { w: fileTab.id }, sidebarWidth: 260 } };
  vi.mocked(invoke).mockImplementation(async (command, args: any) => {
    if (command === "snapshot") return structuredClone(data);
    if (command === "save_view") { data.view = args.view; return; }
    if (command === "open_file") return { path, body, base: body, disk: body };
    if (command === "read_file_disk") return body;
    if (command === "create_codex_session") { data.sessions.push(session); return session; }
    if (command === "read_conversation") return { session, context: null, canStop: false, messages: [], messageEvents: {}, events: [],
      requests: [], olderMessages: false, olderEvents: false, draft: JSON.stringify(draft) } satisfies ConversationData;
    if (command === "save_conversation_draft") return;
    if (["list_directory", "list_file_drafts", "executor_availability", "language_tools"].includes(command)) return [];
    throw new Error(command);
  });

  render(<App />);
  const content = await screen.findByRole("textbox", { name: "Код notes.md" });
  const editor = EditorView.findFromDOM(content)!;
  fireEvent.contextMenu(content);
  expect(screen.queryByRole("menuitem", { name: "Добавить в чат" })).toBeNull();
  act(() => editor.dispatch({ selection: { anchor: body.indexOf("после"), head: body.indexOf("  фрагмент") } }));
  if (existing || terminal) {
    fireEvent.contextMenu(content);
    const item = screen.getByRole("menuitem", { name: "Добавить в чат" });
    expect(item.textContent).toContain("⌘⇧C");
    fireEvent.click(item);
  } else {
    fireEvent.keyDown(content, { key: "C", code: "KeyC", metaKey: true, shiftKey: true });
    const dialog = screen.getByRole("dialog", { name: "Новый чат" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Создать чат" }));
  }

  if (terminal) {
    await waitFor(() => expect(pasteToChat).toHaveBeenCalledExactlyOnceWith("t", snippet));
    expect(data.view.activeTabs.w).toBe("terminal:t");
    expect(screen.queryByRole("dialog", { name: "Новый чат" })).toBeNull();
    expect(vi.mocked(invoke).mock.calls.some(([command]) => command.startsWith("create_"))).toBe(false);
    return;
  }

  const text = draft.text ? `${draft.text}\n\n${snippet}` : snippet;
  const composer = await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "Сообщение" });
  await waitFor(() => expect(composer.value).toBe(text));
  expect(document.activeElement).toBe(composer);
  expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "save_conversation_draft")).toEqual([
    ["save_conversation_draft", { sessionId: session.id, body: JSON.stringify({ ...draft, text }) }],
  ]);
  expect(vi.mocked(invoke).mock.calls.some(([command]) => command.startsWith("start_") && command.endsWith("_turn"))).toBe(false);
});
