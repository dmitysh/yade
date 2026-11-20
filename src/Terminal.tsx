import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { appearanceZoom, monoFonts, useAppearance } from "./appearance";
import type { TerminalInfo } from "./types";
import { openFileLink, resolveFileLink, type FileLinks } from "./fileLinks";
import { terminalFileLinks } from "./terminalLinks";
import { ShellStream } from "./terminalShell";
import { terminalSnapshot, terminalTheme, TerminalOutput, type TerminalSnapshot } from "./terminalOutput";
import TerminalInput from "./TerminalInput";
import { Icon } from "./Ide";
import { TerminalCommand, TerminalPrompt, type TerminalLocation } from "./TerminalPrompt";
import "./terminal.css";
import "@xterm/xterm/css/xterm.css";

interface TerminalFrame { info: TerminalInfo; data: number[]; outputDone: boolean; shellStarted: boolean }
interface Block extends TerminalLocation { id: number; command: string; output: TerminalSnapshot; status: number | null; duration: number }

export function terminalTitle(id: string, title?: string | null) { return title || `Терминал ${id.replace(/^terminal:/, "").slice(0, 8)}`; }

export interface TerminalPanelHandle { pasteToChat: (code: string) => void }

export function TerminalPanel({ ref, workspaceId, id, active, focused = active, screenReaderEnabled = true, workspacePath, fileWorkspaces, openFile, split, close, onExit }: {
  ref?: Ref<TerminalPanelHandle>;
  workspaceId: string; id: string; active: boolean; focused?: boolean; split?: (axis: "row" | "column") => void; close?: () => void; onExit?: (state: "completed" | "failed") => void;
  screenReaderEnabled?: boolean;
} & FileLinks) {
  const { appearance } = useAppearance();
  const fontSize = appearance.terminalFontSize * 96 / 72;
  const screenFontSize = fontSize * appearanceZoom(appearance.scale);
  const element = useRef<HTMLDivElement>(null);
  const view = useRef<({ terminal: Terminal; fit: FitAddon } & TerminalPanelHandle) | null>(null);
  const [info, setInfo] = useState<TerminalInfo | null>(null);
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(true);
  const [ready, setReady] = useState(false);
  const [enhanced, setEnhanced] = useState(false);
  const [running, setRunning] = useState(false);
  const [runningCommand, setRunningCommand] = useState("");
  const [restore, setRestore] = useState<{ command: string; request: number } | null>(null);
  const cancel = useRef<(command: string) => void>(() => {});
  const searchHistory = useRef<(draft: string) => Promise<boolean>>(async () => false);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [context, setContext] = useState<TerminalLocation>({ cwd: workspacePath ?? "" });
  const output = useRef<HTMLDivElement>(null);
  const followBottom = useRef(true);
  const links = useRef({ workspacePath, fileWorkspaces, openFile });
  links.current = { workspacePath, fileWorkspaces, openFile };
  const openOutputFile = useCallback<NonNullable<FileLinks["openFile"]>>(async (...args) => { await links.current.openFile?.(...args); }, []);
  const exited = useRef(onExit);
  exited.current = onExit;
  useImperativeHandle(ref, () => ({ pasteToChat(code) {
    const current = view.current;
    if (!current) throw new Error("Терминальный чат недоступен.");
    current.pasteToChat(code);
  } }), []);

  useEffect(() => {
    const container = element.current!;
    const terminal = new Terminal({ cursorBlink: true, scrollback: 2000, screenReaderMode: screenReaderEnabled,
      theme: terminalTheme, fontSize: screenFontSize });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container);
    container.querySelector("textarea")?.setAttribute("aria-label", "Ввод терминала");
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    let input = Promise.resolve();
    let interruption = Promise.resolve();
    let inputGeneration = 0;
    const stream = new ShellStream();
    let location: TerminalLocation = { cwd: workspacePath ?? "" };
    let command: (TerminalLocation & { text: string; started: number }) | null = null;
    let sequence = 0;
    let waiting = false, promptDone = false;
    let latestInfo: TerminalInfo | null = null;
    let chatPaste = false;
    function requireChatInput() {
      if (waiting || latestInfo?.state !== "running" || latestInfo.execution?.state !== "ready" || !terminal.modes.bracketedPasteMode) {
        throw new Error("Код можно вставить, когда терминальный чат готов к вводу.");
      }
    }
    view.current = { terminal, fit, pasteToChat(code) {
      if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(code)) throw new Error("Выделение содержит управляющие символы терминала.");
      requireChatInput();
      chatPaste = true;
      try { terminal.paste(code); }
      finally { chatPaste = false; }
    } };
    const report = (reason: unknown) => { if (!disposed) setError(String(reason)); };
    const write = (data: Uint8Array) => new Promise<void>(resolve => terminal.write(data, resolve));
    function snapshot() {
      return terminalSnapshot(terminal.buffer.active);
    }
    function background(submitted?: string) {
      if (!waiting || !promptDone) return;
      const output = snapshot();
      if (submitted?.trimEnd()) {
        const suffix = submitted.trimEnd();
        if (!output.text.endsWith(suffix)) return;
        output.text = output.text.slice(0, -suffix.length).trimEnd();
      }
      if (output.text) {
        const id = ++sequence;
        setBlocks(current => [...current, { ...location, id, command: "", output, status: null, duration: 0 }].slice(-100));
      }
    }
    function complete(status: number | null, duration?: number) {
      if (!command) return;
      const block = { cwd: command.cwd, home: command.home, branch: command.branch, id: ++sequence, command: command.text, output: snapshot(), status, duration: duration ?? performance.now() - command.started };
      // shortcut: последние 100 блоков ограничивают память; для более длинной истории нужно отдельное хранилище.
      setBlocks(current => [...current, block].slice(-100));
      command = null; setRunning(false); setRunningCommand("");
    }
    terminal.options.linkHandler = {
      allowNonHttpProtocols: true,
      activate: (_event, href) => {
        const { workspacePath, fileWorkspaces, openFile } = links.current;
        const target = workspacePath && openFile ? resolveFileLink(href, workspacePath, fileWorkspaces) : null;
        if (target) void openFileLink(target, openFile!).catch(report);
        else if (/^https?:\/\//i.test(href)) window.open(href, "_blank", "noopener,noreferrer");
      },
      hover: (_event, href) => { container.title = href; },
      leave: () => { container.removeAttribute("title"); },
    };
    const linkProvider = terminal.registerLinkProvider({ provideLinks: (row, callback) => {
      const { workspacePath, fileWorkspaces, openFile } = links.current;
      callback(workspacePath && openFile ? terminalFileLinks(terminal.buffer.active, row, workspacePath,
        target => { void openFileLink(target, openFile).catch(report); }, fileWorkspaces) : undefined);
    } });
    function enqueue(data: string, raw = Promise.resolve(true), validate?: () => void) {
      const generation = interruption.then(() => inputGeneration);
      const pending = input.then(async () => {
        const queuedGeneration = await generation;
        await interruption;
        if (!disposed && await raw && queuedGeneration === inputGeneration) {
          validate?.();
          await invoke("write_terminal", { workspaceId, id, data });
        }
      });
      input = pending.catch(report);
      return pending;
    }
    const data = (data: string) => {
      if (data === "\x03") {
        const attempt = invoke<"raw" | "flushed" | "signalled">("interrupt_terminal", { workspaceId, id });
        interruption = Promise.all([interruption, attempt]).then(([, result]) => {
          if (result === "flushed") inputGeneration++;
        }).catch(report);
        enqueue(data, attempt.then(result => result === "raw").catch(() => false));
      } else enqueue(data, undefined, chatPaste ? requireChatInput : undefined);
    };
    let applicationWheel: WheelEvent | undefined;
    let repeatWheelInput = false;
    const dataListener = terminal.onData(value => {
      const repeat = repeatWheelInput;
      repeatWheelInput = false;
      data(repeat ? value.repeat(3) : value);
    });
    let executorActive = false;
    const wheel = (event: WheelEvent) => {
      // shortcut: компенсируем замедление трекпада в xterm 6; перепроверить при обновлении xterm.
      const mode = terminal.modes.mouseTrackingMode;
      const application = (mode !== "none" && mode !== "x10") || terminal.buffer.active.type === "alternate";
      applicationWheel = application ? event : undefined;
      const sensitivity = application || executorActive ? 8 : 1;
      terminal.options.scrollSensitivity = application && event.deltaMode === WheelEvent.DOM_DELTA_PIXEL
        && Math.abs(event.deltaY) < 50 ? sensitivity / 0.3 : sensitivity;
    };
    container.addEventListener("wheel", wheel, { capture: true, passive: true });
    terminal.attachCustomWheelEventHandler(event => {
      if (event === applicationWheel) {
        // xterm 6 отправляет один шаг синхронно, даже если жест соответствует нескольким.
        repeatWheelInput = event.deltaY !== 0 && !event.shiftKey;
        queueMicrotask(() => { repeatWheelInput = false; });
      }
      return true;
    });
    cancel.current = command => {
      background(command); waiting = false; promptDone = false;
      data("\x03");
    };
    searchHistory.current = async draft => {
      if (disposed || !waiting || !promptDone) return false;
      background(draft);
      waiting = false; promptDone = false;
      try { await enqueue("\x12"); }
      catch {
        if (!disposed && !waiting && !command) { waiting = true; promptDone = true; }
        return false;
      }
      // До нового приглашения строкой и клавишами управляет сама оболочка.
      if (!disposed && !waiting && !command) { setReady(false); setRunning(true); }
      return true;
    };
    terminal.attachCustomKeyEventHandler(event => {
      if (event.key === "Tab" && !event.ctrlKey && !event.altKey && !event.metaKey) {
        if (event.type === "keydown") { event.preventDefault(); data(event.shiftKey ? "\x1b[Z" : "\t"); }
        return false;
      }
      if (event.key === "Enter" && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey && !event.isComposing) {
        if (event.type === "keydown") { event.preventDefault(); data("\x1b[13;2u"); }
        return false;
      }
      return true;
    });
    let resized = false;
    const resize = ({ cols, rows }: { cols: number; rows: number }) => {
      resized = true;
      invoke("resize_terminal", { workspaceId, id, cols, rows }).catch(report);
    };
    const resizeListener = terminal.onResize(resize);
    const observer = new ResizeObserver(() => {
      if (!container.clientWidth || !container.clientHeight) return;
      fit.fit();
      if (!resized) resize(terminal);
    });
    observer.observe(container);

    async function read() {
      try {
        const frame = await invoke<TerminalFrame>("read_terminal", { workspaceId, id });
        if (disposed) return;
        latestInfo = frame.info;
        const state = frame.info.execution?.state;
        executorActive = state === "ready" || state === "running" || state === "waiting";
        if (container.hasAttribute("inert") && !frame.info.shellToken) setStarting(false);
        setInfo(current => current && current.state === frame.info.state && current.error === frame.info.error
          && current.execution?.title === frame.info.execution?.title ? current : frame.info);
        for (const part of stream.push(frame.data, frame.info.shellToken)) {
          if (disposed) return;
          if ("data" in part) {
            await write(part.data);
          }
          else try { if (part.event === "command" || part.event === "submitted") {
            const text = part.command ?? (await invoke<{ command: string }>("terminal_shell_context", { workspaceId, id })).command;
            background(text); waiting = false; promptDone = false;
            command = { ...location, text, started: command?.started ?? performance.now() };
            setRunningCommand(text);
            setEnhanced(true); setReady(false); setRunning(true);
            await write(new TextEncoder().encode("\x1b[3J\x1b[H\x1b[2J"));
            if (container.clientWidth && container.clientHeight) fit.fit();
            if (!container.closest("[hidden]")) terminal.focus?.();
          } else if (part.event === "input") {
            if (waiting) {
              await write(new TextEncoder().encode("\x1b[3J\x1b[H\x1b[2J"));
              promptDone = true; setReady(true);
            }
            setStarting(false);
          } else {
            background();
            complete(part.status ?? null, part.duration);
            const shell = await invoke<TerminalLocation>("terminal_shell_context", { workspaceId, id });
            location = { cwd: shell.cwd, home: shell.home, branch: shell.branch };
            setContext(shell); setEnhanced(true); setReady(false);
            waiting = true; promptDone = false; setRunning(false);
            await write(new TextEncoder().encode("\x1b[3J\x1b[H\x1b[2J"));
          } } catch (reason) {
            report(reason); setEnhanced(false); setReady(false); setRunning(false); command = null;
          }
        }
        // Сигнал мог быть прочитан до повторного открытия панели.
        if (container.hasAttribute("inert") && frame.shellStarted && !waiting) setStarting(false);
        if (frame.outputDone && frame.info.state !== "running") {
          const tail = stream.finish();
          if (tail.length) await write(tail);
          complete(frame.info.exitCode); setReady(false);
          if (!disposed && (frame.info.state === "completed" || frame.info.state === "failed") && !frame.info.error) exited.current?.(frame.info.state);
        }
        if (!disposed && !(frame.outputDone && frame.info.state !== "running")) {
          if (!frame.data.length) await invoke("wait_terminal", { workspaceId, id });
          if (!disposed) timer = setTimeout(() => void read(), 0);
        }
      } catch (reason) { report(reason); }
    }
    void read();
    return () => {
      disposed = true;
      clearTimeout(timer);
      observer.disconnect();
      container.removeEventListener("wheel", wheel, true);
      view.current = null;
      linkProvider.dispose(); dataListener.dispose(); resizeListener.dispose(); terminal.dispose();
    };
  }, [workspaceId, id]);

  useEffect(() => {
    if (view.current) view.current.terminal.options.screenReaderMode = screenReaderEnabled;
  }, [screenReaderEnabled, workspaceId, id]);

  useEffect(() => {
    if (!active || !view.current) return;
    const renderer = new WebglAddon();
    const contextLoss = renderer.onContextLoss(() => renderer.dispose());
    try { view.current.terminal.loadAddon(renderer); }
    catch { contextLoss.dispose(); renderer.dispose(); return; }
    return () => { contextLoss.dispose(); renderer.dispose(); };
  }, [active, workspaceId, id]);

  useEffect(() => {
    let disposed = false;
    const family = monoFonts[appearance.terminalFont].family;
    const apply = () => {
      if (disposed || !view.current) return;
      view.current.terminal.options.fontFamily = family;
      view.current.terminal.options.fontSize = screenFontSize;
      if (element.current?.clientWidth && element.current?.clientHeight) view.current.fit.fit();
    };
    const loaded = document.fonts?.load(`${screenFontSize}px ${family}`) ?? Promise.resolve();
    loaded.then(apply, apply);
    return () => { disposed = true; };
  }, [appearance.terminalFont, screenFontSize, active, workspaceId, id]);

  useEffect(() => {
    if (active && focused && !starting && !ready) view.current?.terminal.focus();
  }, [active, focused, starting, ready]);

  useEffect(() => { if (active && followBottom.current && output.current) output.current.scrollTop = output.current.scrollHeight; }, [blocks, active]);

  const report = useCallback((reason: unknown) => setError(String(reason)), []);

  return <section id={`terminal:${id}`} role="tabpanel" aria-label={terminalTitle(id, info?.execution?.title)} hidden={!active} className={`terminal-view ${running ? "terminal-busy" : ""}`} style={{ fontFamily: monoFonts[appearance.terminalFont].family, fontSize }}>
    {(error || info?.error) && <p role="alert" className="error">{error || info?.error}</p>}
    <div className="terminal-pane-actions">
      {split && <><button className="ide-icon-button" title="Разделить на левую и правую панели" aria-label="Разделить на левую и правую панели" onClick={() => split("row")}><Icon name="layout" /></button>
        <button className="ide-icon-button" title="Разделить на верхнюю и нижнюю панели" aria-label="Разделить на верхнюю и нижнюю панели" onClick={() => split("column")}><Icon name="layers" /></button></>}
      <span className="terminal-pane-title" title="Ctrl+Alt+стрелки — перейти между панелями">{terminalTitle(id, info?.execution?.title)}</span>
      <button className="ide-icon-button" title="Завершить терминал" aria-label="Завершить терминал" disabled={!info || info.state !== "running"} onClick={() => {
        void invoke("stop_terminal", { workspaceId, id }).catch(report);
      }}><Icon name="stop" /></button>
      {close && <button className="ide-icon-button" title="Скрыть панель" aria-label="Скрыть панель" onClick={close}><Icon name="close" /></button>}
    </div>
    {starting && !error && !info?.error && (!info || info.state === "running") && <p role="status" className="terminal-starting ide-dim">Терминал запускается…</p>}
    {enhanced && <div ref={output} className="terminal-blocks" onScroll={event => {
      const element = event.currentTarget;
      if (element.clientHeight) followBottom.current = element.scrollHeight - element.clientHeight - element.scrollTop <= 1;
    }} style={{ fontFamily: monoFonts[appearance.terminalFont].family, fontSize }}>
      {blocks.map(block => <details key={block.id} className="terminal-block" open>
        <summary><span className="terminal-block-meta"><TerminalPrompt cwd={block.cwd} home={block.home} branch={block.branch} />
          {block.status !== null && block.status !== 0 && <span className="terminal-failure">Код {block.status}</span>}{block.command && <time>({(block.duration / 1000).toFixed(3)} с)</time>}</span>
          <TerminalCommand command={block.command || "Вывод оболочки"} /></summary>
        <div className="terminal-block-actions"><button title="Скопировать команду" aria-label="Скопировать команду" disabled={!block.command} onClick={() => { void navigator.clipboard.writeText(block.command).catch(report); }}><Icon name="copy" />Команда</button>
          <button title="Скопировать вывод" aria-label="Скопировать вывод" onClick={() => { void navigator.clipboard.writeText(block.output.text).catch(report); }}><Icon name="copy" />Вывод</button>
          <button title="Вернуть команду во ввод" aria-label="Вернуть команду во ввод" disabled={!ready || !block.command} onClick={() => setRestore({ command: block.command, request: Date.now() })}><Icon name="refresh" />Во ввод</button></div>
        <TerminalOutput output={block.output} workspacePath={workspacePath} fileWorkspaces={fileWorkspaces} openFile={openFile ? openOutputFile : undefined} report={report} />
      </details>)}
    </div>}
    {runningCommand && <div className="terminal-running-command"><TerminalPrompt cwd={context.cwd} home={context.home} branch={context.branch} /><TerminalCommand command={runningCommand} /></div>}
    <div ref={element} inert={starting} className={`terminal-screen ${enhanced && !running ? "terminal-idle-screen" : ""}`} aria-hidden={enhanced && !running} />
    {enhanced && <div hidden={!ready}><TerminalInput workspaceId={workspaceId} id={id} {...context} active={active && focused && ready}
      restore={restore} report={report} searchHistory={draft => searchHistory.current(draft)} interrupt={command => cancel.current(command)} submit={async command => {
        setError(""); setReady(false); setRunning(true);
        try { await invoke("submit_terminal", { workspaceId, id, command }); }
        catch (reason) { setReady(true); setRunning(false); throw reason; }
      }} /></div>}
  </section>;
}
