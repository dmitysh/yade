// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { TerminalPanel, type TerminalPanelHandle } from "./Terminal";
import { AppearanceProvider, monoFonts, useAppearance } from "./appearance";
import type { ILinkProvider, ILinkHandler } from "@xterm/xterm";
import { createRef, Profiler } from "react";

const xterm = vi.hoisted(() => ({
  data: (_data: string) => {}, resize: (_size: { cols: number; rows: number }) => {},
  parsed: () => {}, observe: () => {},
  write: vi.fn(), fit: vi.fn(), dispose: vi.fn(), disconnect: vi.fn(), options: {},
  linkProvider: null as ILinkProvider | null, disposeLinks: vi.fn(),
  webglLoad: vi.fn(), webglDispose: vi.fn(), webglFail: false, contextLost: () => {},
  modes: { mouseTrackingMode: "none", bracketedPasteMode: false }, buffer: { active: { type: "normal" } },
  wheel: (_event: WheelEvent) => true,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@xterm/xterm", () => ({ Terminal: class {
  cols = 80; rows = 24;
  options: object;
  constructor(options: object) { this.options = options; xterm.options = options; }
  loadAddon(addon: { renderer?: boolean }) {
    if (addon.renderer) { xterm.webglLoad(); if (xterm.webglFail) throw new Error("WebGL недоступен"); }
  }
  open() {} focus() {} attachCustomKeyEventHandler() {}
  attachCustomWheelEventHandler(callback: typeof xterm.wheel) { xterm.wheel = callback; }
  modes = xterm.modes; buffer = xterm.buffer;
  registerLinkProvider(provider: ILinkProvider) { xterm.linkProvider = provider; return { dispose: xterm.disposeLinks }; }
  onData(callback: typeof xterm.data) { xterm.data = callback; return { dispose: vi.fn() }; }
  paste(text: string) { xterm.data("\x1b[200~" + text.replace(/\n/g, "\r") + "\x1b[201~"); }
  onResize(callback: typeof xterm.resize) { xterm.resize = callback; return { dispose: vi.fn() }; }
  write(data: Uint8Array, callback: () => void) { xterm.write(data); xterm.parsed = callback; }
  dispose() { xterm.dispose(); }
} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() { xterm.fit(); } } }));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: class {
  renderer = true;
  dispose() { xterm.webglDispose(); }
  onContextLoss(callback: () => void) { xterm.contextLost = callback; return { dispose() {} }; }
} }));

beforeEach(() => {
  xterm.webglFail = false;
  xterm.modes.bracketedPasteMode = false;
  xterm.modes.mouseTrackingMode = "none"; xterm.buffer.active.type = "normal";
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { xterm.observe = callback; }
    observe() {} disconnect() { xterm.disconnect(); }
  });
});
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });

const info = { id: "t1", workspaceId: "w1", state: "running", exitCode: null, error: null };

test.each([
  { state: "ready", bracketed: true },
  { state: "ready", bracketed: false },
  { state: "waiting", bracketed: true },
])("вставка кода в терминальный чат при состоянии $state и режиме вставки $bracketed", async ({ state, bracketed }) => {
  xterm.modes.bracketedPasteMode = bracketed;
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === "read_terminal") return { info: { ...info, execution: { executor: "codex", state } }, data: [], outputDone: false };
    if (command === "wait_terminal") await new Promise(() => {});
  });
  const ref = createRef<TerminalPanelHandle>();
  render(<TerminalPanel ref={ref} workspaceId="w1" id="t1" active />);
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("wait_terminal", { workspaceId: "w1", id: "t1" }));

  const code = "file.ts:2–3\nкод";
  if (state === "ready" && bracketed) {
    expect(() => ref.current!.pasteToChat("\x1b[201~\n" + code)).toThrow("управляющие символы");
    ref.current!.pasteToChat(code);
    await waitFor(() => expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "write_terminal")).toEqual([
      ["write_terminal", { workspaceId: "w1", id: "t1", data: "\x1b[200~file.ts:2–3\rкод\x1b[201~" }],
    ]));
  } else {
    expect(() => ref.current!.pasteToChat(code)).toThrow("чат готов к вводу");
    expect(vi.mocked(invoke).mock.calls.some(([command]) => command === "write_terminal")).toBe(false);
  }
});

test("переключение экранного диктора меняет доступность без пересоздания терминала", () => {
  vi.mocked(invoke).mockImplementation(() => new Promise(() => {}));
  const panel = render(<TerminalPanel workspaceId="w1" id="t1" active screenReaderEnabled={false} />);
  const options = xterm.options;
  expect(options).toMatchObject({ screenReaderMode: false });
  panel.rerender(<TerminalPanel workspaceId="w1" id="t1" active screenReaderEnabled />);
  expect(options).toMatchObject({ screenReaderMode: true });
  panel.rerender(<TerminalPanel workspaceId="w1" id="t1" active screenReaderEnabled={false} />);
  expect(options).toMatchObject({ screenReaderMode: false });
  expect(xterm.options).toBe(options);
  expect(xterm.dispose).not.toHaveBeenCalled();
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(invoke).toHaveBeenCalledWith("read_terminal", { workspaceId: "w1", id: "t1" });
});

test("для исполнителя повышается чувствительность колеса, при выходе возвращается обычная", () => {
  vi.mocked(invoke).mockImplementation(() => new Promise(() => {}));
  const panel = render(<TerminalPanel workspaceId="w1" id="t1" active />);
  const target = document.createElement("div");
  panel.container.querySelector(".terminal-screen")!.appendChild(target);
  let sensitivity = 0;
  target.addEventListener("wheel", () => { sensitivity = (xterm.options as { scrollSensitivity: number }).scrollSensitivity; });
  function scroll(deltaY: number, deltaMode: number = WheelEvent.DOM_DELTA_PIXEL) {
    const event = new WheelEvent("wheel", { deltaY, deltaMode, cancelable: true });
    target.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    return sensitivity;
  }
  expect(scroll(12)).toBe(1);
  xterm.modes.mouseTrackingMode = "vt200";
  expect(scroll(12)).toBeCloseTo(8 / 0.3);
  expect(scroll(-12)).toBeCloseTo(8 / 0.3);
  expect(scroll(50)).toBe(8);
  expect(scroll(-50)).toBe(8);
  expect(scroll(3, WheelEvent.DOM_DELTA_LINE)).toBe(8);
  expect(scroll(1, WheelEvent.DOM_DELTA_PAGE)).toBe(8);
  xterm.modes.mouseTrackingMode = "none"; xterm.buffer.active.type = "alternate";
  expect(scroll(12)).toBeCloseTo(8 / 0.3);
  xterm.buffer.active.type = "normal";
  expect(scroll(12)).toBe(1);
  xterm.modes.mouseTrackingMode = "x10";
  expect(scroll(12)).toBe(1);
  panel.unmount();
  xterm.modes.mouseTrackingMode = "vt200";
  expect(scroll(12)).toBe(1);
});

test("колесо посылает три шага одним вводом, клавиши не дублируются", async () => {
  vi.mocked(invoke).mockImplementation(command => command === "read_terminal" ? new Promise(() => {}) : Promise.resolve());
  const panel = render(<TerminalPanel workspaceId="w1" id="t1" active />);
  const target = document.createElement("div");
  panel.container.querySelector(".terminal-screen")!.appendChild(target);
  let report: string | undefined;
  target.addEventListener("wheel", event => {
    if (xterm.wheel(event) && report) xterm.data(report);
  });
  const scroll = (value?: string) => {
    report = value;
    fireEvent.wheel(target, { deltaY: -15 });
  };
  const mouse = "\x1b[<64;10;12M";
  xterm.modes.mouseTrackingMode = "vt200";
  scroll(mouse);
  xterm.data("a");
  xterm.modes.mouseTrackingMode = "none";
  xterm.buffer.active.type = "alternate";
  scroll("\x1b[A");
  scroll();
  await Promise.resolve();
  xterm.data("\x1b[A");
  xterm.buffer.active.type = "normal";
  scroll("b");
  await waitFor(() => expect(vi.mocked(invoke).mock.calls.flatMap(([command, args]) =>
    command === "write_terminal" ? [(args as { data: string }).data] : [])).toEqual([
    mouse.repeat(3), "a", "\x1b[A".repeat(3), "\x1b[A", "b",
  ]));
});

test("распознанный исполнитель ускоряет прокрутку в обычном буфере до завершения", async () => {
  vi.useFakeTimers();
  let state = "ready";
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === "read_terminal") return {
      info: { ...info, execution: { executor: "claude", state } }, data: [], outputDone: false,
    };
  });
  try {
    const panel = render(<TerminalPanel workspaceId="w1" id="t1" active />);
    const target = panel.container.querySelector(".terminal-screen")!;
    const scroll = () => {
      fireEvent.wheel(target, { deltaY: 12 });
      return (xterm.options as { scrollSensitivity: number }).scrollSensitivity;
    };
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(scroll()).toBe(8);
    for (state of ["unknown", "completed"]) {
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(scroll()).toBe(1);
    }
  } finally { vi.useRealTimers(); }
});

test.each([false, true])("пустое чтение ждёт уведомления и не продолжает работу после закрытия: %s", async close => {
  vi.useFakeTimers();
  let wake!: () => void;
  let reads = 0;
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === "read_terminal") return { info, data: reads++ ? [65] : [], outputDone: false };
    if (command === "wait_terminal") await new Promise<void>(resolve => { wake = resolve; });
  });
  try {
    const panel = render(<TerminalPanel workspaceId="w1" id="t1" active />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(invoke).toHaveBeenCalledWith("wait_terminal", { workspaceId: "w1", id: "t1" });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(reads).toBe(1);
    if (close) panel.unmount();
    await act(async () => { wake(); await vi.advanceTimersByTimeAsync(0); });
    expect(reads).toBe(close ? 1 : 2);
    expect(xterm.write).toHaveBeenCalledTimes(close ? 0 : 1);
    panel.unmount();
  } finally { vi.useRealTimers(); }
});

test("опрос активности и новый вывод не перерисовывают неизменную панель", async () => {
  let reads = 0;
  const rendered = vi.fn();
  xterm.write.mockImplementation(() => queueMicrotask(() => xterm.parsed()));
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === "read_terminal") return {
      info: { ...info, lastActivityAt: ++reads, execution: { executor: "codex", state: reads % 2 ? "ready" : "running", title: "Задача" } },
      data: [65], outputDone: false,
    };
  });
  render(<Profiler id="terminal" onRender={rendered}><TerminalPanel workspaceId="w1" id="t1" active /></Profiler>);
  await screen.findByRole("tabpanel", { name: "Задача" });
  await waitFor(() => expect(reads).toBeGreaterThan(2));
  rendered.mockClear();
  const previous = reads;
  await waitFor(() => expect(reads).toBeGreaterThan(previous + 2));
  expect(rendered).not.toHaveBeenCalled();
  expect(xterm.write.mock.calls.length).toBeGreaterThan(previous);
});

test("название панели обновляется из результата генерации без перезапуска терминала", async () => {
  let title: string | null = null;
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === "read_terminal") return { info: { ...info, execution: { executor: "codex", state: "ready", title } }, data: [], outputDone: false };
  });
  render(<TerminalPanel workspaceId="w1" id="t1" active />);
  await screen.findByRole("tabpanel", { name: "Терминал t1" });
  title = "Восстановление вкладок";
  await screen.findByRole("tabpanel", { name: title });
  expect(xterm.dispose).not.toHaveBeenCalled();
  expect(vi.mocked(invoke).mock.calls.some(([command]) => ["start_terminal", "stop_terminal"].includes(command))).toBe(false);
});

test("смена шрифта, размера в pt и масштаба обновляет открытый терминал без перезапуска оболочки", async () => {
  function Controls() {
    const { update } = useAppearance();
    return <button onClick={() => update({ terminalFont: "system", terminalFontSize: 12, scale: 125 })}>Изменить вид</button>;
  }
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === "read_terminal") return { info, data: [], outputDone: false };
  });
  const panel = render(<AppearanceProvider><Controls /><TerminalPanel workspaceId="w1" id="t1" active /></AppearanceProvider>);
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("read_terminal", { workspaceId: "w1", id: "t1" }));
  await waitFor(() => expect(xterm.options).toMatchObject({ fontFamily: monoFonts.jetbrains.family, fontSize: 13.65 }));
  const initial = xterm.options;
  const container = panel.container.querySelector(".terminal-screen")!;
  Object.defineProperties(container, { clientWidth: { value: 800 }, clientHeight: { value: 400 } });
  fireEvent.click(screen.getByRole("button", { name: "Изменить вид" }));
  await waitFor(() => expect(xterm.options).toMatchObject({ fontFamily: monoFonts.system.family, fontSize: 21 }));
  expect(xterm.options).toBe(initial);
  expect(xterm.fit).toHaveBeenCalledOnce();
  expect(xterm.dispose).not.toHaveBeenCalled();
  expect(vi.mocked(invoke).mock.calls.some(([command]) => ["start_terminal", "stop_terminal"].includes(command))).toBe(false);
});

test("ввод, Ctrl+C и размер адресованы терминалу, чтение ждёт обработки вывода", async () => {
  let reads = 0;
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === "interrupt_terminal") return "raw";
    if (command === "read_terminal") {
      reads++;
      return { info, data: reads === 1 ? [208, 176] : [], outputDone: false };
    }
  });
  const panel = render(<TerminalPanel workspaceId="w1" id="t1" active />);
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("read_terminal", { workspaceId: "w1", id: "t1" }));
  await waitFor(() => expect(xterm.write).toHaveBeenCalledWith(new Uint8Array([208, 176])));
  expect(xterm.options).toMatchObject({ scrollback: 2000, screenReaderMode: true });
  xterm.data("pwd\r"); xterm.data("\x03");
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("write_terminal", { workspaceId: "w1", id: "t1", data: "\x03" }));
  expect(invoke).toHaveBeenCalledWith("write_terminal", { workspaceId: "w1", id: "t1", data: "pwd\r" });
  xterm.resize({ cols: 101, rows: 37 });
  expect(invoke).toHaveBeenCalledWith("resize_terminal", { workspaceId: "w1", id: "t1", cols: 101, rows: 37 });
  const container = panel.container.querySelector(".terminal-screen")!;
  Object.defineProperties(container, { clientWidth: { value: 800 }, clientHeight: { value: 400 } });
  xterm.observe();
  expect(xterm.fit).toHaveBeenCalledOnce();
  expect(reads).toBe(1);
  xterm.parsed();
  await waitFor(() => expect(reads).toBeGreaterThan(1));
  panel.unmount();
  expect(xterm.dispose).toHaveBeenCalledOnce();
  expect(xterm.disconnect).toHaveBeenCalledOnce();
  expect(vi.mocked(invoke).mock.calls.some(([command]) => ["start_terminal", "stop_terminal"].includes(command))).toBe(false);
});

test("повторное открытие синхронизирует PTY после подгонки без события изменения размера", async () => {
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === "read_terminal") return { info, data: [], outputDone: false };
  });
  const panel = render(<TerminalPanel workspaceId="w1" id="t1" active />);
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("read_terminal", { workspaceId: "w1", id: "t1" }));
  const initial = panel.container.querySelector(".terminal-screen")!;
  Object.defineProperties(initial, { clientWidth: { value: 1200 }, clientHeight: { value: 700 } });
  xterm.fit.mockImplementationOnce(() => xterm.resize({ cols: 120, rows: 35 }));
  xterm.observe();
  expect(invoke).toHaveBeenCalledWith("resize_terminal", { workspaceId: "w1", id: "t1", cols: 120, rows: 35 });
  expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "resize_terminal")).toHaveLength(1);
  panel.unmount();
  vi.mocked(invoke).mockClear();
  xterm.fit.mockClear();

  const reopened = render(<TerminalPanel workspaceId="w1" id="t1" active={false} />);
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("read_terminal", { workspaceId: "w1", id: "t1" }));
  xterm.observe();
  expect(xterm.fit).not.toHaveBeenCalled();
  expect(invoke).not.toHaveBeenCalledWith("resize_terminal", expect.anything());

  reopened.rerender(<TerminalPanel workspaceId="w1" id="t1" active />);
  const container = reopened.container.querySelector(".terminal-screen")!;
  Object.defineProperties(container, { clientWidth: { value: 800 }, clientHeight: { value: 400 } });
  xterm.observe();
  expect(xterm.fit).toHaveBeenCalledOnce();
  expect(invoke).toHaveBeenCalledWith("resize_terminal", { workspaceId: "w1", id: "t1", cols: 80, rows: 24 });
  xterm.observe();
  expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "resize_terminal")).toHaveLength(1);
});

test("Ctrl+C обходит ожидающую вставку и отменяет старый ввод после сброса PTY", async () => {
  let finishPaste!: () => void;
  const writes: string[] = [];
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "read_terminal") return { info, data: [], outputDone: false };
    if (command === "interrupt_terminal") return "flushed";
    if (command === "write_terminal") {
      const data = (args as { data: string }).data;
      writes.push(data);
      if (data === "paste") await new Promise<void>(resolve => { finishPaste = resolve; });
    }
  });
  render(<TerminalPanel workspaceId="w1" id="t1" active />);
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("read_terminal", { workspaceId: "w1", id: "t1" }));
  xterm.data("paste");
  await waitFor(() => expect(writes).toEqual(["paste"]));
  xterm.data("старый ввод");
  xterm.data("\x03");
  xterm.data("новый ввод");
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("interrupt_terminal", { workspaceId: "w1", id: "t1" }));
  finishPaste();
  await waitFor(() => expect(writes).toEqual(["paste", "новый ввод"]));
});

test.each(["raw", "signalled"])("режим %s сохраняет порядок ожидающего ввода", async mode => {
  let finishPaste!: () => void;
  const writes: string[] = [];
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "read_terminal") return { info, data: [], outputDone: false };
    if (command === "interrupt_terminal") return mode;
    if (command === "write_terminal") {
      const data = (args as { data: string }).data;
      writes.push(data);
      if (data === "paste") await new Promise<void>(resolve => { finishPaste = resolve; });
    }
  });
  render(<TerminalPanel workspaceId="w1" id="t1" active />);
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("read_terminal", { workspaceId: "w1", id: "t1" }));
  xterm.data("paste");
  await waitFor(() => expect(writes).toEqual(["paste"]));
  xterm.data("до"); xterm.data("\x03"); xterm.data("после");
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("interrupt_terminal", { workspaceId: "w1", id: "t1" }));
  expect(writes).toEqual(["paste"]);
  finishPaste();
  await waitFor(() => expect(writes).toEqual(mode === "raw" ? ["paste", "до", "\x03", "после"] : ["paste", "до", "после"]));
});

test("ошибка прерывания видна до окончания вставки и не блокирует дальнейший ввод", async () => {
  let finishPaste!: () => void;
  const writes: string[] = [];
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "read_terminal") return { info, data: [], outputDone: false };
    if (command === "interrupt_terminal") throw new Error("PTY недоступен");
    if (command === "write_terminal") {
      const data = (args as { data: string }).data;
      writes.push(data);
      if (data === "paste") await new Promise<void>(resolve => { finishPaste = resolve; });
    }
  });
  render(<TerminalPanel workspaceId="w1" id="t1" active />);
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("read_terminal", { workspaceId: "w1", id: "t1" }));
  xterm.data("paste");
  await waitFor(() => expect(writes).toEqual(["paste"]));
  xterm.data("\x03"); xterm.data("после ошибки");
  await screen.findByText(/PTY недоступен/);
  expect(writes).toEqual(["paste"]);
  finishPaste();
  await waitFor(() => expect(writes).toEqual(["paste", "после ошибки"]));
});

test("обычный терминал показывает вывод и явное завершение оболочки", async () => {
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === "read_terminal") return { info, data: [36, 32], outputDone: false };
  });
  const panel = render(<TerminalPanel workspaceId="w1" id="t1" active />);
  await waitFor(() => expect(xterm.write).toHaveBeenCalledWith(new Uint8Array([36, 32])));
  fireEvent.click(screen.getByRole("button", { name: "Завершить терминал" }));
  expect(invoke).toHaveBeenCalledWith("stop_terminal", { workspaceId: "w1", id: "t1" });
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.queryByRole("heading")).toBeNull();
  expect(panel.container.querySelector(".terminal-screen")).toBeTruthy();
});

test.each([[true, 0], [false, 0], [true, 7], [false, 7]] as const)("завершение оболочки закрывает панель после чтения вывода при active=%s и коде %s", async (active, exitCode) => {
  let reads = 0;
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === "read_terminal") return {
      info: { ...info, state: exitCode === 0 ? "completed" : "failed", exitCode }, data: ++reads === 1 ? [36, 32] : [], outputDone: reads > 1,
    };
  });
  const previous = vi.fn(), onExit = vi.fn();
  const panel = render(<TerminalPanel workspaceId="w1" id="t1" active={active} onExit={previous} />);
  await waitFor(() => expect(xterm.write).toHaveBeenCalledWith(new Uint8Array([36, 32])));
  expect(previous).not.toHaveBeenCalled();
  panel.rerender(<TerminalPanel workspaceId="w1" id="t1" active={active} onExit={onExit} />);
  xterm.parsed();
  await waitFor(() => expect(onExit).toHaveBeenCalledOnce());
  expect(previous).not.toHaveBeenCalled();
  expect(xterm.dispose).not.toHaveBeenCalled();
  expect(invoke).not.toHaveBeenCalledWith("stop_terminal", expect.anything());
});

test("ошибка оболочки остаётся видимой без строки состояния", async () => {
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === "read_terminal") return { info: { ...info, state: "failed", exitCode: 7, error: "ошибка чтения" }, data: [], outputDone: true };
  });
  const onExit = vi.fn();
  render(<TerminalPanel workspaceId="w1" id="t1" active onExit={onExit} />);
  expect((await screen.findByRole("alert")).textContent).toBe("ошибка чтения");
  expect(onExit).not.toHaveBeenCalled();
});

test("явные ссылки терминала открывают локальный файл и используют актуальный обработчик без перезапуска", async () => {
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === "read_terminal") return { info, data: [], outputDone: false };
  });
  const openFile = vi.fn(async () => {});
  const panel = render(<TerminalPanel workspaceId="w1" workspacePath="/project" id="t1" active openFile={openFile} />);
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("read_terminal", { workspaceId: "w1", id: "t1" }));
  const handler = (xterm.options as { linkHandler: ILinkHandler }).linkHandler;
  const range = { start: { x: 1, y: 1 }, end: { x: 12, y: 1 } };
  handler.activate(new MouseEvent("click"), "file:///project/src/App.tsx:12:3", range);
  expect(openFile).toHaveBeenCalledWith("src/App.tsx", { line: 12, column: 3, request: expect.any(Number) });
  openFile.mockClear();
  for (const href of ["file:///other/src/App.tsx", "javascript:alert(1)", "data:text/html,test"]) handler.activate(new MouseEvent("click"), href, range);
  expect(openFile).not.toHaveBeenCalled();
  const next = vi.fn(async () => {});
  panel.rerender(<TerminalPanel workspaceId="w1" workspacePath="/project" id="t1" active openFile={next} />);
  handler.activate(new MouseEvent("click"), "/project/src/App.tsx", range);
  expect(next).toHaveBeenCalledWith("src/App.tsx", undefined);
  expect(xterm.dispose).not.toHaveBeenCalled();
  panel.unmount();
  expect(xterm.disposeLinks).toHaveBeenCalledOnce();
});

test("явная ссылка терминала передаёт пространство другого добавленного проекта", async () => {
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === "read_terminal") return { info, data: [], outputDone: false };
  });
  const openFile = vi.fn(async () => {});
  render(<TerminalPanel workspaceId="w1" workspacePath="/project" id="t1" active
    fileWorkspaces={[{ id: "other", path: "/other" }]} openFile={openFile} />);
  const handler = (xterm.options as { linkHandler: ILinkHandler }).linkHandler;
  handler.activate(new MouseEvent("click"), "file:///other/internal/models.go:293", { start: { x: 1, y: 1 }, end: { x: 12, y: 1 } });
  expect(openFile).toHaveBeenCalledWith("internal/models.go", { line: 293, column: 1, request: expect.any(Number) }, "other");
});


test("GPU-рендерер работает только у видимой панели и не перезапускает PTY", async () => {
  vi.mocked(invoke).mockImplementation(async () => ({ info, data: [], outputDone: false }));
  const panel = render(<TerminalPanel workspaceId="w1" id="t1" active={false} />);
  expect(xterm.webglLoad).not.toHaveBeenCalled();
  panel.rerender(<TerminalPanel workspaceId="w1" id="t1" active />);
  expect(xterm.webglLoad).toHaveBeenCalledTimes(1);
  panel.rerender(<TerminalPanel workspaceId="w1" id="t1" active={false} />);
  expect(xterm.webglDispose).toHaveBeenCalledTimes(1);
  expect(xterm.dispose).not.toHaveBeenCalled();
  expect(xterm.options).toMatchObject({ screenReaderMode: true });
});

test.each(["отказ WebGL", "потеря GPU-контекста"])("%s сохраняет вывод и ввод терминала", async failure => {
  xterm.webglFail = failure === "отказ WebGL";
  let reads = 0;
  xterm.write.mockImplementation(() => queueMicrotask(() => xterm.parsed()));
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === "read_terminal") return { info, data: reads++ ? [] : [65], outputDone: false };
  });
  render(<TerminalPanel workspaceId="w1" id="t1" active />);
  await waitFor(() => expect(xterm.write).toHaveBeenCalledWith(new Uint8Array([65])));
  if (!xterm.webglFail) xterm.contextLost();
  expect(xterm.webglDispose).toHaveBeenCalled();
  expect(xterm.dispose).not.toHaveBeenCalled();
  xterm.data("x");
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("write_terminal", { workspaceId: "w1", id: "t1", data: "x" }));
  expect(screen.queryByRole("alert")).toBeNull();
});
