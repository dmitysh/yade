// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { FilePanel, flushFile, flushFiles } from "./Files";
import type { FileDocument } from "./types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("./CodeEditor", () => ({
  default: ({ body, disabled, change, save }: any) => <>
    <textarea aria-label="Код" value={body} disabled={disabled} onChange={e => change(e.target.value)} />
    <button onClick={save}>Проверка Cmd+S</button>
  </>,
  Comparison: () => <div aria-label="Сравнение версий" />,
}));
afterEach(async () => { cleanup(); await flushFiles().catch(() => {}); vi.useRealTimers(); vi.resetAllMocks(); });

const tab = { id: "file:w1:auto.ts", workspaceId: "w1", sessionId: null };
async function setup(options: { body?: string; disk?: string | null; saveError?: boolean; wait?: Promise<void> } = {}) {
  let disk = options.disk === undefined ? "исходник" : options.disk;
  let draft = options.body ? { body: options.body, base: "исходник" } : null;
  const snapshots: FileDocument[] = [];
  vi.mocked(invoke).mockImplementation(async (command, args: any) => {
    if (command === "open_file") return { path: "auto.ts", body: draft?.body ?? disk, base: draft?.base ?? disk, disk };
    if (command === "read_file_disk") return disk;
    if (command === "save_file_draft") { draft = args.body === args.base ? null : { body: args.body, base: args.base }; return; }
    if (command === "save_file") {
      const snapshot = structuredClone(args.document);
      snapshots.push(snapshot);
      await options.wait;
      if (options.saveError) throw new Error("запись запрещена");
      if (!args.overwrite && snapshot.base !== disk) throw new Error("файл изменён снаружи");
      disk = snapshot.body; draft = null;
      return { ...snapshot, base: disk, disk };
    }
    throw new Error(`неожиданная команда: ${command}`);
  });
  const dirty = vi.fn(), problem = vi.fn();
  vi.useFakeTimers();
  let panel!: ReturnType<typeof render>;
  await act(async () => { panel = render(<FilePanel tab={tab} active dirty={dirty} problem={problem} />); });
  const code = screen.getByRole("textbox", { name: "Код" }) as HTMLTextAreaElement;
  const change = async (body: string) => { await act(async () => { fireEvent.change(code, { target: { value: body } }); }); };
  const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
  return { ...panel, code, dirty, problem, change, advance, snapshots, disk: () => disk, draft: () => draft, setDisk: (value: string | null) => { disk = value; } };
}

test("автосохранение ждёт 1,5 секунды после последнего ввода и не реагирует на клики по панелям", async () => {
  const file = await setup();
  await file.change("первая");
  expect(file.draft()?.body).toBe("первая");
  await file.advance(1000);
  await file.change("последняя");
  fireEvent.click(document.body);
  await file.advance(1499);
  expect(file.snapshots).toHaveLength(0);
  await file.advance(1);
  expect(file.disk()).toBe("последняя");
  expect(file.dirty).toHaveBeenLastCalledWith(tab.id, false);
});

test.each(["вкладка", "разговор", "окно", "скрытие", "закрытие", "выход"])("уход: %s сохраняет сразу", async reason => {
  const file = await setup();
  await file.change("правка");
  await act(async () => {
    if (reason === "вкладка") file.rerender(<FilePanel tab={tab} active={false} dirty={file.dirty} problem={file.problem} />);
    if (reason === "разговор") file.rerender(<FilePanel tab={tab} active focused={false} dirty={file.dirty} problem={file.problem} />);
    if (reason === "окно") fireEvent.blur(window);
    if (reason === "скрытие") {
      const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
      fireEvent(document, new Event("visibilitychange"));
      visibility.mockRestore();
    }
    if (reason === "закрытие") await flushFile(tab.id);
    if (reason === "выход") await flushFiles();
  });
  expect(file.disk()).toBe("правка");
  expect(file.snapshots).toHaveLength(1);
});

test.each(["новая правка", "исходник"])("ввод во время записи: %s остаётся в редакторе и следующем сохранении", async body => {
  let finish!: () => void;
  const file = await setup({ wait: new Promise<void>(resolve => { finish = resolve; }) });
  await file.change("первая правка");
  await file.advance(1500);
  expect(file.snapshots).toHaveLength(1);
  expect(file.code.disabled).toBe(false);
  await file.change(body);
  await act(async () => { finish(); });
  expect(file.code.value).toBe(body);
  expect(file.disk()).toBe("первая правка");
  expect(file.draft()).toEqual({ body, base: "первая правка" });
  await act(async () => { await flushFile(tab.id); });
  expect(file.disk()).toBe(body);
  expect(file.snapshots[1].base).toBe("первая правка");
  expect(file.dirty).toHaveBeenLastCalledWith(tab.id, false);
});

test("чистая вкладка принимает внешние изменения без записи и конфликта", async () => {
  const file = await setup();
  file.setDisk("внешняя версия");
  await file.advance(1000);
  expect(file.code.value).toBe("внешняя версия");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(file.snapshots).toHaveLength(0);
  expect(file.dirty).toHaveBeenLastCalledWith(tab.id, false);
});

test("выход во время записи дожидается сохранения последних правок", async () => {
  let finish!: () => void;
  const file = await setup({ wait: new Promise<void>(resolve => { finish = resolve; }) });
  await file.change("первая правка");
  await file.advance(1500);
  await file.change("последняя правка");
  await act(async () => { const closing = flushFiles(); finish(); await closing; });
  expect(file.disk()).toBe("последняя правка");
  expect(file.draft()).toBeNull();
});

test("внешнее изменение останавливает автосохранение и оставляет обе версии", async () => {
  const file = await setup();
  await file.change("моя правка");
  file.setDisk("внешняя версия");
  await file.advance(4000);
  expect(file.code.value).toBe("моя правка");
  expect(file.disk()).toBe("внешняя версия");
  expect(file.snapshots).toHaveLength(0);
  expect(file.problem).toHaveBeenLastCalledWith(tab.id, "Файл изменён снаружи");
  await act(async () => { await flushFile(tab.id); });
  expect(file.draft()?.body).toBe("моя правка");
});

test("проверка перед записью обнаруживает внешнюю правку между опросами", async () => {
  const file = await setup();
  await file.change("моя правка");
  file.setDisk("внешняя версия");
  await act(async () => { await flushFile(tab.id); });
  expect(file.disk()).toBe("внешняя версия");
  expect(file.draft()?.body).toBe("моя правка");
  expect(screen.getAllByRole("alert").some(alert => alert.textContent?.includes("изменён снаружи"))).toBe(true);
});

test("восстановленный черновик автоматически дописывается в неизменённый исходник", async () => {
  const file = await setup({ body: "восстановленный черновик" });
  expect(file.code.value).toBe("восстановленный черновик");
  await file.advance(1500);
  expect(file.disk()).toBe("восстановленный черновик");
  expect(file.draft()).toBeNull();
});

test("ошибка записи видна до успешного повтора, резервный черновик позволяет закрытие", async () => {
  const options = { saveError: true };
  const file = await setup(options);
  await file.change("не потерять");
  await file.advance(1500);
  expect(screen.getByRole("alert").textContent).toContain("запись запрещена");
  expect(file.problem).toHaveBeenLastCalledWith(tab.id, expect.stringContaining("запись запрещена"));
  await act(async () => { await flushFiles(); });
  expect(file.draft()?.body).toBe("не потерять");
  expect(file.disk()).toBe("исходник");
  options.saveError = false;
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Проверка Cmd+S" })); });
  expect(file.disk()).toBe("не потерять");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(file.problem).toHaveBeenLastCalledWith(tab.id, "");
});
