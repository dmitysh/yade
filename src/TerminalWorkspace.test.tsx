// @vitest-environment jsdom
import { createRef, useEffect, useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import TerminalWorkspace, { type TerminalWorkspaceHandle } from "./TerminalWorkspace";
import type { Workspace } from "./types";

const mounted = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("./Terminal", () => ({ TerminalPanel: ({ id, active, focused, split, close, onExit }: any) => {
  const [text, setText] = useState("");
  useEffect(() => { mounted(id); }, [id]);
  return <section role="tabpanel" aria-label={id} hidden={!active} data-focused={focused}>
    <input aria-label={`Ввод ${id}`} value={text} onChange={event => setText(event.target.value)} />
    <button onClick={() => split("row")}>Слева и справа</button><button onClick={() => split("column")}>Сверху и снизу</button><button onClick={close}>Скрыть</button>
    <button onClick={() => onExit("failed")}>Выход</button><button onClick={() => onExit("completed")}>Готово</button>
  </section>;
} }));
beforeEach(() => { vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

test("деление и скрытие панелей сохраняют их DOM и ввод, обзор возвращает скрытую панель", async () => {
  const ref = createRef<TerminalWorkspaceHandle>();
  const props = { terminals: [{ id: "t1", workspaceId: "w1", state: "running", exitCode: null, error: null }], tabs: [{ id: "terminal:t1", workspaceId: "w1", sessionId: null }],
    workspaces: [{ id: "w1", path: "/project", operationState: "ready" } as Workspace], close: vi.fn(), openFile: vi.fn(async () => {}) };
  vi.mocked(invoke).mockResolvedValue({ id: "t2", workspaceId: "w1", state: "running" });
  const view = render(<TerminalWorkspace ref={ref} {...props} activeId="terminal:t1" />);
  const original = screen.getByRole("textbox", { name: "Ввод t1" });
  fireEvent.change(original, { target: { value: "draft" } });
  fireEvent.click(screen.getByRole("button", { name: "Слева и справа" }));
  const second = await screen.findByRole("tabpanel", { name: "t2" });
  expect(invoke).toHaveBeenCalledWith("start_terminal", { workspaceId: "w1", sourceId: "t1", cols: 80, rows: 24 });
  expect(screen.getByRole("textbox", { name: "Ввод t1" })).toBe(original);
  const separator = screen.getByRole("separator", { name: "Ширина терминала" });
  fireEvent.keyDown(separator, { key: "ArrowRight" });
  expect(Number(separator.getAttribute("aria-valuenow"))).toBeGreaterThan(400);
  fireEvent.keyDown(second, { key: "ArrowLeft", ctrlKey: true, altKey: true });
  expect(screen.getByRole("tabpanel", { name: "t1" }).getAttribute("data-focused")).toBe("true");
  fireEvent.click(within(second).getByRole("button", { name: "Скрыть" }));
  expect(second.isConnected).toBe(true);
  expect(screen.queryByRole("tabpanel", { name: "t2" })).toBeNull();
  let root = "";
  act(() => { root = ref.current!.reveal("t2"); });
  view.rerender(<TerminalWorkspace ref={ref} {...props} activeId={`terminal:${root}`} />);
  expect(screen.getByRole("tabpanel", { name: "t2" })).toBe(second);
  expect(mounted.mock.calls.map(([id]) => id)).toEqual(["t1", "t2"]);
  expect((original as HTMLInputElement).value).toBe("draft");
  await waitFor(() => expect(screen.queryByRole("separator")).toBeNull());
});

test("выход закрывает неактивную вкладку, сохраняя активный терминал", async () => {
  const close = vi.fn();
  render(<TerminalWorkspace terminals={[]} tabs={[{ id: "terminal:t1", workspaceId: "w1", sessionId: null }, { id: "terminal:t2", workspaceId: "w1", sessionId: null }]}
    workspaces={[{ id: "w1", path: "/project" } as Workspace]} activeId="terminal:t2" close={close} openFile={vi.fn()} />);
  fireEvent.click(within(screen.getByLabelText("t1")).getByRole("button", { name: "Выход", hidden: true }));
  await waitFor(() => expect(close).toHaveBeenCalledWith("t1"));
  expect(close).not.toHaveBeenCalledWith("t2");
  expect(screen.getByRole("tabpanel", { name: "t2" })).toBeTruthy();
});

test("успешный выход сохраняет вывод до перехода на соседнюю панель", async () => {
  const ref = createRef<TerminalWorkspaceHandle>();
  const first = { id: "t1", workspaceId: "w1", state: "running", exitCode: null, error: null };
  const second = { ...first, id: "t2" };
  const tab = { id: "terminal:t1", workspaceId: "w1", sessionId: null };
  const props = { workspaces: [{ id: "w1", path: "/project" } as Workspace], close: vi.fn(), openFile: vi.fn() };
  const removeCompleted = vi.fn(async (id: string) => {
    expect(ref.current!.replacementFor(id)).toBe("t2");
    ref.current!.forget(id, "t2");
    view.rerender(<TerminalWorkspace ref={ref} {...props} terminals={[second]} tabs={[{ ...tab, id: "terminal:t2" }]} activeId="terminal:t2" removeCompleted={removeCompleted} />);
  });
  vi.mocked(invoke).mockResolvedValue(second);
  const view = render(<TerminalWorkspace ref={ref} {...props} terminals={[first]} tabs={[tab]} activeId={tab.id} removeCompleted={removeCompleted} />);
  fireEvent.click(screen.getByRole("button", { name: "Слева и справа" }));
  const sibling = await screen.findByRole("tabpanel", { name: "t2" });
  fireEvent.focus(screen.getByRole("textbox", { name: "Ввод t1" }));
  fireEvent.click(within(screen.getByRole("tabpanel", { name: "t1" })).getByRole("button", { name: "Готово" }));
  expect(removeCompleted).not.toHaveBeenCalled();
  expect(screen.getByRole("tabpanel", { name: "t1" })).toBeTruthy();
  await act(async () => { fireEvent.focus(within(sibling).getByRole("textbox")); });
  await waitFor(() => expect(removeCompleted).toHaveBeenCalledExactlyOnceWith("t1", "w1"));
  expect(screen.queryByLabelText("t1")).toBeNull();
  expect(screen.getByRole("tabpanel", { name: "t2" })).toBe(sibling);
});

test.each([false, true])("выход из разделённых панелей закрывает вкладку после последней панели, одновременно=%s", async simultaneous => {
  const close = vi.fn();
  vi.mocked(invoke).mockResolvedValue({ id: "t2", workspaceId: "w1", state: "running" });
  render(<TerminalWorkspace terminals={[]} tabs={[{ id: "terminal:t1", workspaceId: "w1", sessionId: null }]}
    workspaces={[{ id: "w1", path: "/project" } as Workspace]} activeId="terminal:t1" close={close} openFile={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Слева и справа" }));
  const second = await screen.findByRole("tabpanel", { name: "t2" });
  const first = screen.getByRole("tabpanel", { name: "t1" });
  act(() => {
    fireEvent.click(within(first).getByRole("button", { name: "Выход" }));
    if (simultaneous) fireEvent.click(within(second).getByRole("button", { name: "Выход" }));
  });
  expect(screen.queryByRole("tabpanel", { name: "t1" })).toBeNull();
  if (!simultaneous) {
    expect(close).not.toHaveBeenCalled();
    expect(screen.getByRole("tabpanel", { name: "t2" })).toBe(second);
    expect(screen.queryByRole("separator")).toBeNull();
    fireEvent.click(within(second).getByRole("button", { name: "Выход" }));
  }
  await waitFor(() => expect(close).toHaveBeenCalledWith("t1"));
  expect(close).not.toHaveBeenCalledWith("t2");
});
