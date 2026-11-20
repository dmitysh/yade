// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { flushFiles } from "./Files";
import { flushConversationDrafts } from "./Conversations";
import Lifecycle from "./Lifecycle";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("./Files", () => ({ flushFiles: vi.fn(async () => {}) }));
vi.mock("./Conversations", () => ({ flushConversationDrafts: vi.fn(async () => {}) }));
let request: () => void;
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  vi.mocked(listen).mockImplementation(async (_, handler) => { request = () => handler({} as any); return () => {}; });
  vi.mocked(invoke).mockImplementation(async command => command === "reconcile_processes" ? [] : true);
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

test("отмена выхода сохраняет работу, повторный запрос показывает предупреждение", async () => {
  render(<Lifecycle flushView={async () => {}} />);
  await act(async () => request());
  await screen.findByText(/Выполняются задачи/);
  fireEvent.click(screen.getByRole("button", { name: "Отменить выход" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(vi.mocked(invoke).mock.calls.some(([c]) => c === "finish_exit")).toBe(false);
  await act(async () => request());
  await screen.findByRole("dialog", { name: "Полный выход из Yade" });
});

test("подтверждённый выход ждёт расположения и обоих видов черновиков", async () => {
  vi.mocked(invoke).mockImplementation(async command => command === "reconcile_processes" ? [] : command === "has_active_work");
  let finishView!: () => void;
  let finishFiles!: () => void;
  let finishDrafts!: () => void;
  const view = new Promise<void>(resolve => { finishView = resolve; });
  vi.mocked(flushFiles).mockReturnValue(new Promise(resolve => { finishFiles = resolve; }));
  vi.mocked(flushConversationDrafts).mockReturnValue(new Promise(resolve => { finishDrafts = resolve; }));
  render(<Lifecycle flushView={() => view} />);
  await act(async () => request());
  fireEvent.click(screen.getByRole("button", { name: "Завершить работу" }));
  await act(async () => { finishView(); finishFiles(); });
  expect(vi.mocked(invoke).mock.calls.some(([c]) => c === "finish_exit")).toBe(false);
  await act(async () => finishDrafts());
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("finish_exit", { confirmed: true }));
});

test("ошибка сохранения отменяет выход и оставляет сообщение видимым", async () => {
  vi.mocked(flushFiles).mockRejectedValue(new Error("диск недоступен"));
  render(<Lifecycle flushView={async () => {}} />);
  await act(async () => request());
  fireEvent.click(screen.getByRole("button", { name: "Завершить работу" }));
  expect((await screen.findByRole("alert")).textContent).toContain("диск недоступен");
  expect(vi.mocked(invoke).mock.calls.some(([c]) => c === "finish_exit")).toBe(false);
  expect((screen.getByRole("button", { name: "Отменить выход" }) as HTMLButtonElement).disabled).toBe(false);
});

test("без активной работы выход сохраняет состояние без предупреждения", async () => {
  vi.mocked(invoke).mockImplementation(async command => command === "reconcile_processes" ? [] : false);
  const flushView = vi.fn(async () => {});
  render(<Lifecycle flushView={flushView} />);
  await act(async () => request());
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("finish_exit", { confirmed: false }));
  expect(flushView).toHaveBeenCalledOnce();
  expect(screen.queryByText(/Выполняются задачи/)).toBeNull();
});

test("сохранившиеся процессы видны после сбоя и проверяются повторно без запуска команд", async () => {
  let processes = [{ id: "old", workspaceId: "w1", pid: 321, verified: true }];
  vi.mocked(invoke).mockImplementation(async () => processes);
  render(<Lifecycle flushView={async () => {}} />);
  await screen.findByText(/PID 321: процесс прежнего запуска ещё существует/);
  processes = [];
  fireEvent.click(screen.getByRole("button", { name: "Повторить проверку процессов" }));
  await waitFor(() => expect(screen.queryByRole("region", { name: "Восстановление после сбоя" })).toBeNull());
  expect(vi.mocked(invoke).mock.calls.every(([c]) => c === "reconcile_processes")).toBe(true);
});
