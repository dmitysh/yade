// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { EditorView } from "@codemirror/view";
import { FilePanel, flushFile } from "./Files";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
beforeAll(() => {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});
const tab = { id: "file:w1:nested/main.go", workspaceId: "w1", sessionId: null };
afterEach(async () => { cleanup(); await flushFile(tab.id); vi.resetAllMocks(); });

test("Git-метки включают сохранённые и ручные правки и исчезают после коммита", async () => {
  let head = "package main\n\nfunc old() {}\n";
  let disk = head.replace("old", "updated");
  vi.mocked(invoke).mockImplementation(async (command, args: any) => {
    if (command === "open_file") return { path: args.path, body: disk, base: disk, disk };
    if (command === "read_file_disk") return disk;
    if (command === "read_git_file") return head;
    if (command === "save_file_draft") return;
    if (command === "save_file") {
      disk = args.document.body;
      return { ...args.document, base: disk, disk };
    }
    throw new Error(command);
  });
  const { container } = render(<FilePanel tab={tab} active dirty={vi.fn()} />);
  const editor = EditorView.findFromDOM(await screen.findByRole("textbox", { name: "Код nested/main.go" }))!;
  await waitFor(() => expect(container.querySelectorAll(".cm-line-change-modified")).toHaveLength(1));
  expect(invoke).toHaveBeenCalledWith("read_git_file", { workspaceId: "w1", path: "nested/main.go", revision: "HEAD" });
  act(() => editor.dispatch({ changes: { from: 0, insert: "// добавлено\n" } }));
  expect(container.querySelectorAll(".cm-line-change-added")).toHaveLength(1);
  await act(async () => { await flushFile(tab.id); });
  expect(disk).toBe(editor.state.sliceDoc());
  expect(container.querySelectorAll(".cm-line-change-added")).toHaveLength(1);
  expect(container.querySelectorAll(".cm-line-change-modified")).toHaveLength(1);
  head = disk;
  fireEvent.focus(window);
  await waitFor(() => expect(container.querySelectorAll(".cm-line-change-added, .cm-line-change-modified, .cm-line-change-deleted")).toHaveLength(0));
  expect(EditorView.findFromDOM(screen.getByRole("textbox", { name: "Код nested/main.go" }))).toBe(editor);
});

test("без Git метки сравнивают текст с сохранённой версией файла", async () => {
  const disk = "package main\n";
  vi.mocked(invoke).mockImplementation(async (command, args: any) => {
    if (command === "open_file") return { path: args.path, body: disk, base: disk, disk };
    if (command === "read_file_disk") return disk;
    if (command === "read_git_file") throw new Error("not a git repository");
    if (command === "save_file_draft") return;
    throw new Error(command);
  });
  const { container } = render(<FilePanel tab={tab} active dirty={vi.fn()} />);
  const editor = EditorView.findFromDOM(await screen.findByRole("textbox", { name: "Код nested/main.go" }))!;
  act(() => editor.dispatch({ changes: { from: 0, insert: "// добавлено\n" } }));
  expect(container.querySelectorAll(".cm-line-change-added")).toHaveLength(1);
  fireEvent.keyDown(editor.contentDOM, { key: "z", code: "KeyZ", ctrlKey: true });
  expect(container.querySelectorAll(".cm-line-change-added, .cm-line-change-modified, .cm-line-change-deleted")).toHaveLength(0);
  expect(screen.queryByRole("alert")).toBeNull();
});
