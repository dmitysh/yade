// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { FileBrowser } from "./Files";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

test("обновление дерева перечитывает сохранённые черновики независимо от существования файлов", async () => {
  let drafts: string[] = [];
  const open = vi.fn();
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === "list_directory") return [];
    if (command === "list_file_drafts") return drafts;
    throw new Error(`неожиданная команда: ${command}`);
  });
  render(<FileBrowser workspaceId="w1" open={open} />);
  fireEvent.click(screen.getByRole("button", { name: "Файлы" }));
  const section = await screen.findByRole("region", { name: "Сохранённые черновики" });
  expect(within(section).queryByRole("button")).toBeNull();
  drafts = ["removed/file.ts"];
  fireEvent.click(screen.getByRole("button", { name: "Обновить дерево" }));
  fireEvent.click(await screen.findByRole("button", { name: "removed/file.ts" }));
  expect(open).toHaveBeenCalledWith("removed/file.ts");
  expect(invoke).toHaveBeenCalledWith("list_file_drafts", { workspaceId: "w1" });
});
