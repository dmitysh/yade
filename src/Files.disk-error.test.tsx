// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { FilePanel } from "./Files";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("./CodeEditor", () => ({
  default: ({ body }: { body: string }) => <textarea aria-label="Код" value={body} readOnly />,
  Comparison: () => <div aria-label="Сравнение версий" />,
}));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

test("ошибка чтения исходника не закрывает черновик и снимается после успешного чтения", async () => {
  let readable = false;
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "open_file") return { path: "file.txt", body: "сохранённые правки", base: "исходник", disk: null, diskError: "некорректный UTF-8" };
    if (command === "read_file_disk") {
      if (!readable) throw new Error("некорректный UTF-8");
      return "внешняя версия";
    }
    throw new Error(`неожиданная команда: ${command}`);
  });
  render(<FilePanel tab={{ id: "file:w1:file.txt", workspaceId: "w1", sessionId: null }} active dirty={vi.fn()} />);
  expect((await screen.findByRole("textbox", { name: "Код" }) as HTMLTextAreaElement).value).toBe("сохранённые правки");
  expect((await screen.findByRole("alert")).textContent).toContain("Внешняя версия файла недоступна");
  expect(screen.queryByText(/файл удалён снаружи/)).toBeNull();
  expect(screen.queryByRole("button", { name: "Восстановить удалённый файл" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Принять версию с диска" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Заменить файл черновиком" })).toBeNull();
  fireEvent.focus(window);
  await screen.findByText(/Внешняя версия файла недоступна: Error:/);
  expect(screen.queryByRole("button", { name: "Сравнить с диском" })).toBeNull();
  expect(screen.queryByLabelText("Сравнение версий")).toBeNull();
  readable = true;
  fireEvent.focus(window);
  await screen.findByRole("button", { name: "Принять версию с диска" });
  expect(screen.queryByText(/Внешняя версия файла недоступна/)).toBeNull();
  expect((screen.getByRole("textbox", { name: "Код" }) as HTMLTextAreaElement).value).toBe("сохранённые правки");
});
