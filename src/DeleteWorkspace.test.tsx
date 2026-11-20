// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import DeleteWorkspace from "./DeleteWorkspace";
import type { DeletionCheck, Workspace } from "./types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };

const workspace: Workspace = {
  id: "w", projectId: "p", groupId: null, name: "Исправление", path: "/project/fix", kind: "worktree",
  archived: false, deleted: false, sourceRef: "main", sourceCommit: "abc", gitRef: "fix", operationState: "ready",
  operationError: null, preparationCommand: null, preparationState: "skipped", preparationOutput: "",
};
const check: DeletionCheck = {
  workspaceId: "w", path: workspace.path, kind: "worktree", pathExists: true, registered: true,
  branch: "fix", head: "def", drafts: [], changes: "", unmerged: "",
};

test.each(["Отмена", "Закрыть Удаление пространства", "Escape"])("%s отменяет удаление без вызова команды", async button => {
  const close = vi.fn();
  render(<DeleteWorkspace workspace={workspace} inspect={vi.fn().mockResolvedValue(check)} refresh={vi.fn()} close={close} />);
  await screen.findByText(/Ветка fix сохранится/);
  expect(invoke).not.toHaveBeenCalled();
  if (button === "Escape") fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
  else fireEvent.click(screen.getByRole("button", { name: button }));
  expect(close).toHaveBeenCalledOnce();
  expect(invoke).not.toHaveBeenCalled();
});

test.each(["drafts", "changes", "unmerged"] as const)("обнаруженная работа требует дополнительного подтверждения: %s", async field => {
  const expected = { ...check, [field]: field === "drafts" ? [{ id: "d", workspaceId: "w", sessionId: null, path: "file.txt", body: "правка", baseVersion: "abc" }] : "работа" };
  const close = vi.fn(), refresh = vi.fn().mockResolvedValue(undefined);
  render(<DeleteWorkspace workspace={workspace} inspect={vi.fn().mockResolvedValue(expected)} refresh={refresh} close={close} />);
  const consent = await screen.findByRole("checkbox");
  const remove = screen.getByRole("button", { name: "Удалить пространство" });
  expect((remove as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(remove);
  expect(invoke).not.toHaveBeenCalled();
  fireEvent.click(consent);
  fireEvent.click(remove);
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(invoke).toHaveBeenCalledExactlyOnceWith("delete_workspace", { expected, confirmed: true, discardWork: true });
  expect(refresh).toHaveBeenCalledOnce();
});

test("основная папка сохраняется на диске, удаление требует кнопки подтверждения", async () => {
  const expected = { ...check, kind: "folder", registered: false, branch: null, head: null };
  const close = vi.fn();
  render(<DeleteWorkspace workspace={{ ...workspace, kind: "folder" }} inspect={vi.fn().mockResolvedValue(expected)} refresh={vi.fn().mockResolvedValue(undefined)} close={close} />);
  await screen.findByText(/Папка и вложенные репозитории останутся на диске/);
  expect(screen.queryByRole("checkbox")).toBeNull();
  expect(invoke).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Удалить пространство" }));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(invoke).toHaveBeenCalledWith("delete_workspace", { expected, confirmed: true, discardWork: false });
});

test("ошибка проверки блокирует удаление, повторная проверка показывает актуальное состояние", async () => {
  const inspect = vi.fn().mockRejectedValueOnce(new Error("В пространстве выполняется работа"))
    .mockResolvedValueOnce({ ...check, changes: " M file.txt" });
  render(<DeleteWorkspace workspace={workspace} inspect={inspect} refresh={vi.fn()} close={vi.fn()} />);
  expect((await screen.findByRole("alert")).textContent).toContain("В пространстве выполняется работа");
  expect(screen.queryByRole("button", { name: "Удалить пространство" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Проверить повторно" }));
  await screen.findByText("M file.txt");
  expect((screen.getByRole("button", { name: "Удалить пространство" }) as HTMLButtonElement).disabled).toBe(true);
  expect(invoke).not.toHaveBeenCalled();
});

test("изменение состояния требует повторной проверки и сбрасывает согласие", async () => {
  const expected = { ...check, changes: " M file.txt" };
  const inspect = vi.fn().mockResolvedValue(expected);
  const close = vi.fn();
  vi.mocked(invoke).mockRejectedValue(new Error("Состояние пространства изменилось"));
  render(<DeleteWorkspace workspace={workspace} inspect={inspect} refresh={vi.fn()} close={close} />);
  fireEvent.click(await screen.findByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Удалить пространство" }));
  expect((await screen.findByRole("alert")).textContent).toContain("Состояние пространства изменилось");
  expect(close).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Проверить повторно" }));
  expect((await screen.findByRole("checkbox") as HTMLInputElement).checked).toBe(false);
  expect(inspect).toHaveBeenCalledTimes(2);
  expect((screen.getByRole("button", { name: "Удалить пространство" }) as HTMLButtonElement).disabled).toBe(true);
});

test("ошибка обновления списка не приводит к повторному удалению", async () => {
  const refresh = vi.fn().mockRejectedValueOnce(new Error("Список недоступен")).mockResolvedValueOnce(undefined);
  const close = vi.fn();
  render(<DeleteWorkspace workspace={workspace} inspect={vi.fn().mockResolvedValue(check)} refresh={refresh} close={close} />);
  await screen.findByText(/Ветка fix сохранится/);
  fireEvent.click(screen.getByRole("button", { name: "Удалить пространство" }));
  await screen.findByRole("alert");
  expect(close).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Обновить список" }));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(refresh).toHaveBeenCalledTimes(2);
});
