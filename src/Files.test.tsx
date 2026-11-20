// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { FileBrowser, FilePanel, flushFile } from "./Files";
import type { FileDocument } from "./types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("./CodeEditor", () => ({
  default: ({ body, disabled, change, save, location }: any) => <>
    <textarea aria-label="Код" value={body} disabled={disabled} onChange={e => change(e.target.value)} />
    <button onClick={save}>Проверка Cmd+S</button><p>{location ? `Строка ${location.line}, столбец ${location.column}` : ""}</p>
  </>,
  Comparison: ({ a, b }: { a: string; b: string }) => <div aria-label="Сравнение версий"><pre>{a}</pre><pre>{b}</pre></div>,
}));
afterEach(async () => { cleanup(); await flushFile("file:w1:src/file.ts").catch(() => {}); vi.resetAllMocks(); });

const tab = { id: "file:w1:src/file.ts", workspaceId: "w1", sessionId: null };
function fixture(options: { draftError?: boolean; saveError?: boolean; body?: string; disk?: string | null } = {}) {
  const document: FileDocument = { path: "src/file.ts", body: options.body ?? "исходник", base: "исходник", disk: options.disk === undefined ? "исходник" : options.disk };
  let disk = document.disk;
  vi.mocked(invoke).mockImplementation(async (command, args: any) => {
    if (command === "open_file") return structuredClone(document);
    if (command === "read_file_disk") return disk;
    if (command === "save_file_draft") {
      if (options.draftError) throw new Error("база недоступна");
      document.body = args.body; document.base = args.base;
      return;
    }
    if (command === "save_file") {
      if (options.draftError) throw new Error("база недоступна");
      if (options.saveError) throw new Error("запись запрещена");
      const saved = { ...args.document, base: args.document.body, disk: args.document.body };
      Object.assign(document, saved); disk = saved.disk;
      return structuredClone(saved);
    }
    throw new Error(`неожиданная команда: ${command}`);
  });
  return { document, setDisk: (value: string | null) => { disk = value; document.disk = value; } };
}

test("дерево лениво открывает вложенные файлы выбранного пространства", async () => {
  const open = vi.fn();
  vi.mocked(invoke).mockImplementation(async (command, args: any) => {
    if (command === "list_file_drafts") return [];
    if (command === "list_directory") return args.path === "" ? [{ path: "src", name: "src", directory: true }] : [{ path: "src/file.ts", name: "file.ts", directory: false }];
    throw new Error(`неожиданная команда: ${command}`);
  });
  render(<FileBrowser workspaceId="second-worktree" open={open} />);
  expect(invoke).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Файлы" }));
  fireEvent.click(await screen.findByRole("button", { name: "src/" }));
  fireEvent.click(await screen.findByRole("button", { name: "file.ts" }));
  expect(open).toHaveBeenCalledWith("src/file.ts");
  expect(invoke).toHaveBeenCalledWith("list_directory", { workspaceId: "second-worktree", path: "src" });
});

test("дерево обновляется каждые пять секунд и сохраняет строки и фокус во время чтения", async () => {
  vi.useFakeTimers();
  try {
    let changed = false;
    vi.mocked(invoke).mockImplementation(async (command, args: any) => {
      if (command === "list_file_drafts") return [];
      if (command !== "list_directory") throw new Error(command);
      if (changed) await new Promise(resolve => setTimeout(resolve, 100));
      if (args.path === "") return [
        { path: "src", name: "src", directory: true },
        ...(changed ? [{ path: "README.md", name: "README.md", directory: false }] : []),
      ];
      return [
        { path: "src/file.ts", name: "file.ts", directory: false },
        changed ? { path: "src/new.ts", name: "new.ts", directory: false } : { path: "src/old.ts", name: "old.ts", directory: false },
      ];
    });
    const refreshWorkspace = vi.fn();
    await act(async () => { render(<FileBrowser workspaceId="poll-worktree" open={vi.fn()} refreshWorkspace={refreshWorkspace} embedded selectedPath="src/file.ts" />); });
    const folder = screen.getByRole("button", { name: "src/" });
    await act(async () => { fireEvent.click(folder); });
    const file = screen.getByRole("button", { name: "file.ts" });
    file.focus();
    vi.mocked(invoke).mockClear();
    changed = true;

    await act(() => vi.advanceTimersByTimeAsync(4999));
    expect(invoke).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "old.ts" })).toBeTruthy();
    expect(screen.queryByText("Загрузка…")).toBeNull();
    expect(document.activeElement).toBe(file);

    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(screen.getByRole("button", { name: "README.md" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "new.ts" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "old.ts" })).toBeNull();
    expect(screen.getByRole("button", { name: "src/", expanded: true })).toBe(folder);
    expect(screen.getByRole("button", { name: "file.ts", current: "page" })).toBe(file);
    expect(document.activeElement).toBe(file);
    expect(refreshWorkspace).not.toHaveBeenCalled();
  } finally {
    cleanup();
    vi.useRealTimers();
  }
});

test("редактирование сразу сохраняет черновик, Cmd+S записывает файл без панели сохранения", async () => {
  const { document } = fixture();
  const dirty = vi.fn();
  render(<FilePanel tab={tab} active dirty={dirty} location={{ line: 3, column: 2, request: 1 }} />);
  const code = await screen.findByRole("textbox", { name: "Код" });
  fireEvent.change(code, { target: { value: "ручная правка" } });
  await waitFor(() => expect(document.body).toBe("ручная правка"));
  expect(document.disk).toBe("исходник");
  expect(invoke).not.toHaveBeenCalledWith("save_file", expect.anything());
  expect(dirty).toHaveBeenLastCalledWith(tab.id, true);
  fireEvent.click(screen.getByRole("button", { name: "Проверка Cmd+S" }));
  await waitFor(() => expect(dirty).toHaveBeenLastCalledWith(tab.id, false));
  expect(invoke).toHaveBeenCalledWith("save_file", { workspaceId: "w1", document: { path: "src/file.ts", body: "ручная правка", base: "исходник", disk: "исходник" }, overwrite: false });
  expect(dirty).toHaveBeenLastCalledWith(tab.id, false);
  expect(screen.getByText("Строка 3, столбец 2")).toBeTruthy();
  expect(screen.queryByRole("heading", { name: /src\/file.ts/ })).toBeNull();
  expect(screen.queryByText("Нет несохранённых правок")).toBeNull();
  expect(screen.queryByRole("button", { name: /Сохранить файл|Сохранить черновик|Проверить файл на диске/ })).toBeNull();
});

test("ошибка записи оставляет черновик и несохранённые правки", async () => {
  fixture({ saveError: true });
  const dirty = vi.fn();
  render(<FilePanel tab={tab} active dirty={dirty} />);
  fireEvent.change(await screen.findByRole("textbox", { name: "Код" }), { target: { value: "ручная правка" } });
  fireEvent.click(screen.getByRole("button", { name: "Проверка Cmd+S" }));
  expect((await screen.findByRole("alert")).textContent).toContain("запись запрещена");
  expect((screen.getByRole("textbox", { name: "Код" }) as HTMLTextAreaElement).value).toBe("ручная правка");
  expect(dirty).toHaveBeenLastCalledWith(tab.id, true);
});

test("очередь черновиков сохраняет последние правки до повторного открытия", async () => {
  fixture();
  let finish: (() => void) | undefined;
  const original = vi.mocked(invoke).getMockImplementation()!;
  let writes = 0;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "save_file_draft" && ++writes === 1) await new Promise<void>(resolve => { finish = resolve; });
    return original(command, args);
  });
  const first = render(<FilePanel tab={tab} active dirty={vi.fn()} />);
  const code = await screen.findByRole("textbox", { name: "Код" });
  fireEvent.change(code, { target: { value: "первая" } });
  await waitFor(() => expect(finish).toBeDefined());
  fireEvent.change(code, { target: { value: "последняя" } });
  expect(writes).toBe(1);
  first.unmount();
  render(<FilePanel tab={tab} active dirty={vi.fn()} />);
  await act(async () => { finish!(); await flushFile(tab.id); });
  expect((await screen.findByRole("textbox", { name: "Код" }) as HTMLTextAreaElement).value).toBe("последняя");
});

test("сбой сохранения черновика блокирует закрытие до успешной повторной записи", async () => {
  const options = { draftError: true };
  fixture(options);
  render(<FilePanel tab={tab} active dirty={vi.fn()} />);
  fireEvent.change(await screen.findByRole("textbox", { name: "Код" }), { target: { value: "не потерять" } });
  await screen.findByRole("alert");
  await expect(flushFile(tab.id)).rejects.toThrow("база недоступна");
  options.draftError = false;
  await act(async () => { await flushFile(tab.id); });
  expect(screen.queryByRole("alert")).toBeNull();
});

test.each(["сохранить файл", "принять диск"])("%s после сбоя черновика позволяет закрыть и открыть вкладку", async action => {
  const options = { draftError: true, disk: action === "принять диск" ? "внешняя версия" : "исходник", body: "предыдущий черновик" };
  fixture(options);
  vi.spyOn(window, "confirm").mockReturnValue(true);
  const dirty = vi.fn();
  const panel = render(<FilePanel tab={tab} active dirty={dirty} />);
  fireEvent.change(await screen.findByRole("textbox", { name: "Код" }), { target: { value: "ручная правка" } });
  await screen.findByText(/Черновик не сохранён:/);
  await expect(flushFile(tab.id)).rejects.toThrow("база недоступна");
  options.draftError = false;
  fireEvent.click(screen.getByRole("button", { name: action === "принять диск" ? "Принять версию с диска" : "Проверка Cmd+S" }));
  await waitFor(() => expect(dirty).toHaveBeenLastCalledWith(tab.id, false));
  await expect(flushFile(tab.id)).resolves.toBeUndefined();
  panel.unmount();
  render(<FilePanel tab={tab} active dirty={vi.fn()} />);
  expect((await screen.findByRole("textbox", { name: "Код" }) as HTMLTextAreaElement).value).toBe(action === "принять диск" ? "внешняя версия" : "ручная правка");
});

test("повтор закрытия после сбоя черновика сохраняет конфликт без замены внешнего файла", async () => {
  const options = { body: "черновик", disk: "внешняя версия", draftError: true };
  const { document } = fixture(options);
  render(<FilePanel tab={tab} active dirty={vi.fn()} />);
  fireEvent.change(await screen.findByRole("textbox", { name: "Код" }), { target: { value: "не потерять" } });
  await screen.findByText(/Черновик не сохранён:/);
  await expect(flushFile(tab.id)).rejects.toThrow("база недоступна");
  options.draftError = false;
  await act(async () => { await flushFile(tab.id); });
  expect(document.body).toBe("не потерять");
  expect(document.disk).toBe("внешняя версия");
  expect(screen.queryByText(/Черновик не сохранён:/)).toBeNull();
  expect(invoke).not.toHaveBeenCalledWith("save_file", expect.anything());
});

test("внешнее изменение и удаление показывают конфликт и сохраняют ручной текст", async () => {
  const { setDisk } = fixture({ body: "ручной черновик" });
  vi.spyOn(window, "confirm").mockReturnValue(true);
  render(<FilePanel tab={tab} active dirty={vi.fn()} />);
  await screen.findByRole("textbox", { name: "Код" });
  setDisk("внешние правки");
  fireEvent.focus(window);
  await screen.findByText(/Конфликт: файл изменён снаружи/);
  fireEvent.click(screen.getByRole("button", { name: "Сравнить с диском" }));
  const comparison = await screen.findByLabelText("Сравнение версий");
  expect(comparison.textContent).toContain("внешние правки");
  expect(comparison.textContent).toContain("ручной черновик");
  setDisk(null);
  fireEvent.focus(window);
  await screen.findByText(/Конфликт: файл удалён снаружи/);
  expect((screen.getByRole("textbox", { name: "Код" }) as HTMLTextAreaElement).value).toBe("ручной черновик");
  fireEvent.click(screen.getByRole("button", { name: "Восстановить удалённый файл" }));
  await waitFor(() => expect(screen.queryByText(/Конфликт: файл удалён снаружи/)).toBeNull());
  expect(invoke).toHaveBeenCalledWith("save_file", { workspaceId: "w1", document: { path: "src/file.ts", body: "ручной черновик", base: "исходник", disk: null }, overwrite: true });
});

test("восстановленный конфликт можно разрешить принятием дисковой версии без записи исходника", async () => {
  fixture({ body: "черновик после перезапуска", disk: "внешняя версия" });
  vi.spyOn(window, "confirm").mockReturnValue(true);
  render(<FilePanel tab={tab} active dirty={vi.fn()} />);
  await screen.findByText(/Конфликт: файл изменён снаружи/);
  fireEvent.click(screen.getByRole("button", { name: "Принять версию с диска" }));
  await waitFor(() => expect((screen.getByRole("textbox", { name: "Код" }) as HTMLTextAreaElement).value).toBe("внешняя версия"));
  expect((screen.getByRole("textbox", { name: "Код" }) as HTMLTextAreaElement).value).toBe("внешняя версия");
  expect(invoke).not.toHaveBeenCalledWith("save_file", expect.anything());
});

test("редактор открывается без панели выбора версий", async () => {
  fixture();
  render(<FilePanel tab={tab} active dirty={vi.fn()} />);
  await screen.findByRole("textbox", { name: "Код" });
  expect(screen.queryByText("Сравнение версий")).toBeNull();
  expect(screen.queryByRole("combobox")).toBeNull();
  expect(screen.queryByRole("button", { name: /Сравнить версии|Неподготовленные изменения|Подготовленные изменения/ })).toBeNull();
});
