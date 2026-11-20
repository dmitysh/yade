// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { TerminalPanel } from "./Terminal";
import TerminalWorkspace from "./TerminalWorkspace";
import type { Workspace } from "./types";
import * as fileLinks from "./fileLinks";

const native = vi.hoisted(() => ({ data: (_value: string) => {}, key: (_event: KeyboardEvent) => true, focus: vi.fn(), disposed: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: class { onContextLoss() { return { dispose() {} }; } dispose() {} } }));
vi.mock("@xterm/xterm", () => ({ Terminal: class {
  options: object; cols = 80; rows = 24; text = "";
  constructor(options: object) { this.options = options; }
  buffer = { active: { length: 0, baseY: 0, cursorY: 0, getLine: (_line: number) => ({ length: 0, isWrapped: false, translateToString: (_trim: boolean) => "", getCell: (_x: number) => ({ getWidth: () => 1, getChars: () => "", isAttributeDefault: () => true }) }) } };
  loadAddon() {}
  open(container: HTMLElement) { container.appendChild(document.createElement("textarea")); }
  focus() { native.focus(); }
  attachCustomKeyEventHandler(callback: typeof native.key) { native.key = callback; }
  attachCustomWheelEventHandler() {}
  registerLinkProvider() { return { dispose() {} }; }
  onData(callback: typeof native.data) { native.data = callback; return { dispose() {} }; }
  onResize() { return { dispose() {} }; }
  write(bytes: Uint8Array, done: () => void) {
    const text = new TextDecoder().decode(bytes);
    this.text = text.startsWith("\x1b[3J") ? "" : this.text + text.replace(/\r/g, "");
    const lines = this.text.split("\n");
    this.buffer.active.length = lines.length;
    this.buffer.active.cursorY = lines.length - 1;
    this.buffer.active.getLine = line => ({ length: lines[line]?.length ?? 0, isWrapped: false, translateToString: () => lines[line],
      getCell: x => ({ getWidth: () => 1, getChars: () => lines[line][x], isAttributeDefault: () => true }) });
    done();
  }
  dispose() { native.disposed(); }
} }));
const info = { id: "t1", workspaceId: "w1", state: "running", exitCode: null, error: null, shellToken: "secret" };
let frames: { info: typeof info; data: number[]; outputDone: boolean; shellStarted?: boolean }[];
let command = "";
function output(text: string) { frames.push({ info, data: [...new TextEncoder().encode(text)], outputDone: false }); }
beforeEach(() => {
  frames = []; command = "";
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.mocked(invoke).mockImplementation(async (name, args) => {
    if (name === "read_terminal") return frames.shift() ?? { info, data: [], outputDone: false };
    if (name === "terminal_shell_context") return { cwd: "/project", command };
    if (name === "interrupt_terminal") return "raw";
    if (name === "edit_terminal") return { ...(args as object), suggestion: "" };
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.resetAllMocks(); vi.unstubAllGlobals(); });

test("терминал блокирует ввод до готовности редактора zsh", async () => {
  const panel = render(<TerminalPanel workspaceId="w1" id="t1" active />);
  const terminal = panel.container.querySelector(".terminal-screen")!;
  expect(screen.getByRole("status").textContent).toBe("Терминал запускается…");
  expect(terminal.hasAttribute("inert")).toBe(true);
  expect(native.focus).not.toHaveBeenCalled();

  output("\x1b]777;secret;P;0\x07");
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("terminal_shell_context", { workspaceId: "w1", id: "t1" }));
  expect(screen.getByRole("status")).toBeTruthy();
  expect(terminal.hasAttribute("inert")).toBe(true);
  expect(screen.queryByRole("textbox", { name: "Команда терминала" })).toBeNull();

  output("\x1b]777;secret;B\x07");
  const input = await screen.findByRole("textbox", { name: "Команда терминала" });
  expect(screen.queryByRole("status")).toBeNull();
  expect(terminal.hasAttribute("inert")).toBe(false);
  fireEvent.change(input, { target: { value: "pwd" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("submit_terminal", { workspaceId: "w1", id: "t1", command: "pwd" }));
});

test("повторное открытие терминала использует уже подтверждённую готовность zsh", async () => {
  frames.push({ info, data: [], outputDone: false, shellStarted: true });
  const panel = render(<TerminalPanel workspaceId="w1" id="t1" active />);
  await waitFor(() => expect(native.focus).toHaveBeenCalled());
  expect(screen.queryByRole("status")).toBeNull();
  expect(panel.container.querySelector(".terminal-screen")!.hasAttribute("inert")).toBe(false);
});

test("Ctrl+R передаёт ввод оболочке после синхронизации черновика", async () => {
  output("\x1b]777;secret;P;0\x07\x1b]777;secret;B\x07");
  render(<TerminalPanel workspaceId="w1" id="t1" active />);
  const input = await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "Команда терминала" });
  native.focus.mockClear();
  fireEvent.change(input, { target: { value: "черновик" } });
  expect(fireEvent.keyDown(input, { key: "r", code: "KeyR", metaKey: true })).toBe(true);
  expect(fireEvent.keyDown(input, { key: "к", code: "KeyR", ctrlKey: true })).toBe(false);
  await screen.findByRole("textbox", { name: "Ввод терминала" });
  expect(native.focus).toHaveBeenCalled();
  expect(screen.queryByRole("textbox", { name: "Команда терминала" })).toBeNull();
  expect(screen.queryByRole("listbox")).toBeNull();
  native.data("from-history\r");
  await waitFor(() => expect(vi.mocked(invoke).mock.calls.filter(([name]) => name === "write_terminal").map(([, args]) => args)).toEqual([
    { workspaceId: "w1", id: "t1", data: "\x12" },
    { workspaceId: "w1", id: "t1", data: "from-history\r" },
  ]));
  const calls = vi.mocked(invoke).mock.calls;
  const search = calls.findIndex(([name]) => name === "write_terminal");
  expect(calls.slice(0, search).filter(([name]) => name === "edit_terminal").at(-1)?.[1]).toMatchObject({ command: "черновик" });
  expect(calls.some(([name]) => name === "submit_terminal")).toBe(false);
  output("bck-i-search: from-history\x1b]777;secret;C;" + btoa("echo from-history") + "\x07selected command output\r\n\x1b]777;secret;P;0\x07\x1b]777;secret;B\x07");
  expect(await screen.findByText("selected command output")).toBeTruthy();
  expect(screen.queryByText("bck-i-search: from-history")).toBeNull();
  expect((await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "Команда терминала" })).value).toBe("");
});

test("снимки статусов не разбирают старый вывод; скрытие, новые блоки и файловые ссылки остаются актуальными", async () => {
  const resolve = vi.spyOn(fileLinks, "resolveFileLink");
  const openFile = vi.fn(async () => {}), latestOpenFile = vi.fn(async (..._args: unknown[]) => {});
  const workspaces = [{ id: "w1", path: "/project", operationState: "ready" }, { id: "w2", path: "/other", operationState: "ready" }] as Workspace[];
  const props = { terminals: [info], tabs: [{ id: "terminal:t1", workspaceId: "w1", sessionId: null }], workspaces, close: vi.fn(), openFile };
  command = "printf history";
  output("\x1b]777;secret;C\x07/other/src/App.tsx:12 /next/src/Next.tsx:3 /project/local.ts:4\r\n\x1b]777;secret;P;0\x07\x1b]777;secret;B\x07");
  const panel = render(<TerminalWorkspace {...props} activeId="terminal:t1" />);
  const original = await screen.findByRole("link", { name: "/other/src/App.tsx:12" });
  const refresh = (activeId: string | null, spaces = workspaces) => panel.rerender(<TerminalWorkspace {...props}
    terminals={props.terminals.map(terminal => ({ ...terminal, lastActivityAt: Date.now() }))} tabs={props.tabs.map(tab => ({ ...tab }))}
    workspaces={spaces.map(workspace => ({ ...workspace }))} activeId={activeId} openFile={(...args) => latestOpenFile(...args)} close={() => {}} />);
  resolve.mockClear();
  for (const activeId of ["terminal:t1", null, null, "terminal:t1"]) refresh(activeId);
  expect(resolve).not.toHaveBeenCalled();
  expect(screen.getByRole("link", { name: "/other/src/App.tsx:12" })).toBe(original);
  latestOpenFile.mockRejectedValueOnce(new Error("файл недоступен"));
  fireEvent.click(original);
  expect(latestOpenFile).toHaveBeenCalledWith("w1", "src/App.tsx", expect.objectContaining({ line: 12 }), "w2");
  expect(openFile).not.toHaveBeenCalled();
  await screen.findByRole("alert");
  expect(resolve).not.toHaveBeenCalled();

  refresh("terminal:t1", [workspaces[0], { ...workspaces[1], path: "/next" }]);
  expect(screen.queryByRole("link", { name: "/other/src/App.tsx:12" })).toBeNull();
  fireEvent.click(screen.getByRole("link", { name: "/next/src/Next.tsx:3" }));
  expect(latestOpenFile).toHaveBeenLastCalledWith("w1", "src/Next.tsx", expect.objectContaining({ line: 3 }), "w2");
  refresh("terminal:t1", [workspaces[0], { ...workspaces[1], id: "w3", path: "/next" }]);
  fireEvent.click(screen.getByRole("link", { name: "/next/src/Next.tsx:3" }));
  expect(latestOpenFile).toHaveBeenLastCalledWith("w1", "src/Next.tsx", expect.objectContaining({ line: 3 }), "w3");
  refresh("terminal:t1", [workspaces[0], { ...workspaces[1], path: "/next", archived: true }]);
  expect(screen.queryByRole("link", { name: "/next/src/Next.tsx:3" })).toBeNull();
  refresh("terminal:t1", [{ ...workspaces[0], path: "/moved" }]);
  expect(screen.queryByRole("link", { name: "/project/local.ts:4" })).toBeNull();

  resolve.mockClear();
  command = "printf next";
  output("\x1b]777;secret;C\x07src/New.ts:9\r\n\x1b]777;secret;P;0\x07\x1b]777;secret;B\x07");
  await screen.findByRole("link", { name: "src/New.ts:9" });
  expect(resolve.mock.calls.map(([path]) => path)).toEqual(["src/New.ts:9"]);
  expect(panel.container.querySelectorAll(".terminal-block")).toHaveLength(2);
  expect(native.disposed).not.toHaveBeenCalled();
});

test("команда получает отдельный блок; возврат во ввод не запускает её, скрытие сохраняет вывод", async () => {
  output("\x1b]777;secret;P;0\x07\x1b]777;secret;B\x07");
  const panel = render(<TerminalPanel workspaceId="w1" id="t1" active />);
  await screen.findByRole("textbox", { name: "Команда терминала" });
  command = "printf 'hello'";
  native.data(command + "\r");
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("write_terminal", { workspaceId: "w1", id: "t1", data: command + "\r" }));
  output("\x1b]777;secret;C\x07hello\r\n\x1b]777;secret;P;0\x07\x1b]777;secret;B\x07");
  await screen.findByText("hello");
  expect(screen.getByText((_, element) => element?.tagName === "CODE" && element.textContent === "printf 'hello'")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Вернуть команду во ввод" }));
  expect((screen.getByRole("textbox", { name: "Команда терминала" }) as HTMLTextAreaElement).value).toBe("printf 'hello'");
  expect(vi.mocked(invoke).mock.calls.some(([name]) => name === "submit_terminal")).toBe(false);
  panel.rerender(<TerminalPanel workspaceId="w1" id="t1" active={false} />);
  panel.rerender(<TerminalPanel workspaceId="w1" id="t1" active />);
  expect(screen.getByText("hello")).toBeTruthy();
  expect(native.disposed).not.toHaveBeenCalled();
});

test("оболочка и интерактивная команда используют один ввод PTY", async () => {
  output("\x1b]777;secret;P;0\x07\x1b]777;secret;B\x07");
  const panel = render(<TerminalPanel workspaceId="w1" id="t1" active />);
  await waitFor(() => expect(panel.container.querySelector(".terminal-idle-screen")).toBeTruthy());
  command = "read answer";
  native.data(command + "\r");
  output("\x1b]777;secret;C\x07Answer: ");
  await waitFor(() => expect(panel.container.querySelector(".terminal-idle-screen")).toBeNull());
  native.data("yes\r");
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("write_terminal", { workspaceId: "w1", id: "t1", data: "yes\r" }));
  output("yes\r\n\x1b]777;secret;P;0\x07\x1b]777;secret;B\x07");
  await waitFor(() => expect(panel.container.querySelector(".terminal-idle-screen")).toBeTruthy());
  expect(screen.getByText("Answer: yes")).toBeTruthy();
});

test("фоновый вывод после приглашения сохраняется перед следующей командой", async () => {
  output("\x1b]777;secret;P;0\x07prompt-text\x1b]777;secret;B\x07background-log\r\n");
  render(<TerminalPanel workspaceId="w1" id="t1" active />);
  await screen.findByRole("textbox", { name: "Команда терминала" });
  command = "pwd";
  output("pwd\x1b]777;secret;C\x07/project\r\n\x1b]777;secret;P;0\x07\x1b]777;secret;B\x07");
  expect(await screen.findByText("background-log")).toBeTruthy();
  expect(screen.queryByText("prompt-text")).toBeNull();
});

test("Shift+Enter вставляет строку, Tab дополняет команду без перехода фокуса, стрелки остаются у оболочки", async () => {
  output("\x1b]777;secret;P;0\x07\x1b]777;secret;B\x07");
  const panel = render(<TerminalPanel workspaceId="w1" id="t1" active />);
  await waitFor(() => expect(panel.container.querySelector(".terminal-idle-screen")).toBeTruthy());
  expect(native.key(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true }))).toBe(false);
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("write_terminal", { workspaceId: "w1", id: "t1", data: "\x1b[13;2u" }));
  const tab = new KeyboardEvent("keydown", { key: "Tab", cancelable: true });
  expect(native.key(tab)).toBe(false);
  expect(tab.defaultPrevented).toBe(true);
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("write_terminal", { workspaceId: "w1", id: "t1", data: "\t" }));
  expect(native.key(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true }))).toBe(false);
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("write_terminal", { workspaceId: "w1", id: "t1", data: "\x1b[Z" }));
  expect(native.key(new KeyboardEvent("keydown", { key: "ArrowRight" }))).toBe(true);
  expect(screen.queryByRole("listbox")).toBeNull();
});

test("Shift+Enter в интерактивной программе передаётся отдельно от Enter и Shift+Tab", async () => {
  command = "interactive";
  output("\x1b]777;secret;P;0\x07\x1b]777;secret;B\x07\x1b]777;secret;C\x07");
  render(<TerminalPanel workspaceId="w1" id="t1" active />);
  await screen.findByText(command);

  const shiftEnter = { key: "Enter", shiftKey: true, cancelable: true };
  const keydown = new KeyboardEvent("keydown", shiftEnter);
  expect(native.key(keydown)).toBe(false);
  expect(keydown.defaultPrevented).toBe(true);
  expect(native.key(new KeyboardEvent("keypress", shiftEnter))).toBe(false);
  expect(native.key(new KeyboardEvent("keyup", shiftEnter))).toBe(false);
  expect(native.key(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true }))).toBe(false);
  expect(native.key(new KeyboardEvent("keydown", { key: "Enter" }))).toBe(true);
  native.data("\r");

  await waitFor(() => expect(vi.mocked(invoke).mock.calls.filter(([name]) => name === "write_terminal").map(([, args]) => args)).toEqual([
    { workspaceId: "w1", id: "t1", data: "\x1b[13;2u" },
    { workspaceId: "w1", id: "t1", data: "\x1b[Z" },
    { workspaceId: "w1", id: "t1", data: "\r" },
  ]));
});

test("ошибка разбора получает блок с исходной командой и кодом завершения", async () => {
  output("\x1b]777;secret;P;0\x07\x1b]777;secret;B\x07");
  render(<TerminalPanel workspaceId="w1" id="t1" active />);
  await screen.findByRole("textbox", { name: "Команда терминала" });
  command = "echo &&&";
  output(`\x1b]777;secret;S;${btoa(command)}\x07parse error\r\n\x1b]777;secret;P;1;2.5\x07\x1b]777;secret;B\x07`);
  expect(await screen.findByText("parse error")).toBeTruthy();
  expect(screen.getByText((_, element) => element?.tagName === "CODE" && element.textContent === "echo &&&")).toBeTruthy();
  expect(screen.getByText("Код 1")).toBeTruthy();
});

test("отмена редактируемой команды не сохраняет зеркало ввода как фоновый вывод", async () => {
  output("\x1b]777;secret;P;0\x07\x1b]777;secret;B\x07printf cancelled");
  const panel = render(<TerminalPanel workspaceId="w1" id="t1" active />);
  const input = await screen.findByRole("textbox", { name: "Команда терминала" });
  fireEvent.change(input, { target: { value: "printf cancelled", selectionStart: 16 } });
  fireEvent.keyDown(input, { key: "c", ctrlKey: true });
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("interrupt_terminal", { workspaceId: "w1", id: "t1" }));
  output("^C\r\n\x1b]777;secret;P;130\x07\x1b]777;secret;B\x07");
  await waitFor(() => expect((screen.getByRole("textbox", { name: "Команда терминала" }) as HTMLTextAreaElement).value).toBe(""));
  expect(panel.container.querySelectorAll(".terminal-block")).toHaveLength(0);
});


test("новый блок не сбрасывает прокрутку читаемой истории; у нижней границы следование возобновляется", async () => {
  output("\x1b]777;secret;P;0\x07\x1b]777;secret;B\x07");
  const panel = render(<TerminalPanel workspaceId="w1" id="t1" active />);
  await screen.findByRole("textbox", { name: "Команда терминала" });
  const element = panel.container.querySelector<HTMLDivElement>(".terminal-blocks")!;
  let height = 1000, top = 0;
  Object.defineProperties(element, {
    clientHeight: { configurable: true, value: 200 },
    scrollHeight: { configurable: true, get: () => height },
    scrollTop: { configurable: true, get: () => top, set: (value: number) => { top = Math.max(0, Math.min(value, height - 200)); } },
  });
  const finish = (text: string) => {
    command = `printf ${text}`;
    output(`\x1b]777;secret;C\x07${text}\r\n\x1b]777;secret;P;0\x07\x1b]777;secret;B\x07`);
  };
  finish("first"); await screen.findByText("first", { selector: "pre" });
  expect(element.scrollTop).toBe(800);
  element.scrollTop = 200; fireEvent.scroll(element);
  height = 1200; finish("second"); await screen.findByText("second", { selector: "pre" });
  expect(element.scrollTop).toBe(200);
  element.scrollTop = 1000; fireEvent.scroll(element);
  height = 1400; finish("third"); await screen.findByText("third", { selector: "pre" });
  expect(element.scrollTop).toBe(1200);
});
