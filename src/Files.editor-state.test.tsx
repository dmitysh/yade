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
afterEach(async () => {
  cleanup();
  await Promise.all([flushFile("file:w1:first.ts"), flushFile("file:w1:second.ts")]);
  vi.resetAllMocks();
});

test("переключение вкладок сохраняет историю отмены, выделение и поиск редактора", async () => {
  const disks: Record<string, string> = { "first.ts": "исходник\n", "second.ts": "исходник\n" };
  vi.mocked(invoke).mockImplementation(async (command, args: any) => {
    if (command === "open_file") return { path: args.path, body: "исходник\n", base: "исходник\n", disk: "исходник\n" };
    if (command === "read_file_disk") return disks[args.path];
    if (command === "save_file_draft") return;
    if (command === "save_file") {
      disks[args.document.path] = args.document.body;
      return { ...args.document, base: args.document.body, disk: args.document.body };
    }
    throw new Error(`неожиданная команда: ${command}`);
  });
  const dirty = vi.fn();
  const first = { id: "file:w1:first.ts", workspaceId: "w1", sessionId: null };
  const second = { id: "file:w1:second.ts", workspaceId: "w1", sessionId: null };
  const location = { line: 1, column: 1, request: 1 };
  const panels = (active: string) => <>
    <FilePanel tab={first} active={active === first.id} dirty={dirty} location={location} />
    <FilePanel tab={second} active={active === second.id} dirty={dirty} />
  </>;
  const { rerender } = render(panels(first.id));
  const code = await screen.findByRole("textbox", { name: "Код first.ts" });
  const editor = EditorView.findFromDOM(code)!;
  act(() => editor.dispatch({ changes: { from: 0, insert: "правка\n" }, selection: { anchor: 2, head: 6 } }));
  fireEvent.click(screen.getByRole("button", { name: "Поиск в документе" }));
  await screen.findByRole("textbox", { name: "Найти в документе" });

  rerender(panels(second.id));
  await screen.findByRole("textbox", { name: "Код second.ts" });
  await waitFor(() => expect(disks["first.ts"]).toBe("правка\nисходник\n"));
  rerender(panels(first.id));
  const restored = EditorView.findFromDOM(await screen.findByRole("textbox", { name: "Код first.ts" }))!;
  expect(restored === editor).toBe(true);
  expect(restored.state.selection.main.anchor).toBe(2);
  expect(restored.state.selection.main.head).toBe(6);
  expect(screen.getByRole("textbox", { name: "Найти в документе" })).toBeTruthy();
  fireEvent.keyDown(restored.contentDOM, { key: "z", code: "KeyZ", ctrlKey: true });
  expect(restored.state.sliceDoc()).toBe("исходник\n");
});
