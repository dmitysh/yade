import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Splitter } from "./Ide";
import { TerminalPanel, type TerminalPanelHandle } from "./Terminal";
import type { Tab, TerminalInfo, Workspace } from "./types";
import type { FileLinks } from "./fileLinks";

type Axis = "row" | "column";
export type TerminalLayout = { id: string } | { axis: Axis; fraction: number; first: TerminalLayout; second: TerminalLayout };
export const terminalLeaves = (node: TerminalLayout): string[] => "id" in node ? [node.id] : [...terminalLeaves(node.first), ...terminalLeaves(node.second)];
export function splitTerminal(node: TerminalLayout, id: string, next: string, axis: Axis): TerminalLayout {
  if ("id" in node) return node.id === id ? { axis, fraction: .5, first: node, second: { id: next } } : node;
  return { ...node, first: splitTerminal(node.first, id, next, axis), second: splitTerminal(node.second, id, next, axis) };
}
export function hideTerminal(node: TerminalLayout, id: string): TerminalLayout | null {
  if ("id" in node) return node.id === id ? null : node;
  const first = hideTerminal(node.first, id), second = hideTerminal(node.second, id);
  return first && second ? { ...node, first, second } : first ?? second;
}
function resizeTerminal(node: TerminalLayout, path: string, fraction: number): TerminalLayout {
  if ("id" in node) return node;
  if (!path) return { ...node, fraction };
  const [side, ...rest] = path.split(".") as ("first" | "second")[];
  return { ...node, [side]: resizeTerminal(node[side], rest.join("."), fraction) };
}

export interface TerminalWorkspaceHandle {
  reveal: (id: string) => string; focus: () => void;
  pasteToChat: (id: string, code: string) => void;
  has: (id: string) => boolean;
  visibleIds: () => string[];
  focusedId: () => string | undefined;
  replacementFor: (id: string) => string | undefined;
  forget: (id: string, replacement: string | undefined) => void;
}
export default forwardRef<TerminalWorkspaceHandle, {
  terminals: TerminalInfo[]; tabs: Tab[]; workspaces: Workspace[]; activeId: string | null;
  screenReaderEnabled?: boolean;
  close: (id: string) => void; openFile: (workspaceId: string, ...args: Parameters<NonNullable<FileLinks["openFile"]>>) => Promise<void>;
  removeCompleted?: (id: string, workspaceId: string) => Promise<void>;
}>(function TerminalWorkspace({ terminals, tabs, workspaces, activeId, screenReaderEnabled, close, openFile, removeCompleted }, ref) {
  const host = useRef<HTMLDivElement>(null);
  const panels = useRef(new Map<string, TerminalPanelHandle>());
  const fileWorkspaces = useRef<NonNullable<FileLinks["fileWorkspaces"]>>([]);
  const available = workspaces.filter(workspace => !workspace.deleted && !workspace.archived && workspace.operationState === "ready");
  if (available.length !== fileWorkspaces.current.length || available.some((workspace, i) =>
    workspace.id !== fileWorkspaces.current[i].id || workspace.path !== fileWorkspaces.current[i].path)) {
    fileWorkspaces.current = available.map(({ id, path }) => ({ id, path }));
  }
  const known = useRef(new Map<string, string>());
  for (const terminal of terminals) known.current.set(terminal.id, terminal.workspaceId);
  for (const tab of tabs) if (tab.id.startsWith("terminal:")) known.current.set(tab.id.slice(9), tab.workspaceId);
  const [created, setCreated] = useState<TerminalInfo[]>([]);
  for (const terminal of created) known.current.set(terminal.id, terminal.workspaceId);
  const [layouts, setLayouts] = useState<Record<string, TerminalLayout>>({});
  const [exited, setExited] = useState<string[]>([]);
  const [completed, setCompleted] = useState<string[]>([]);
  const cleanupRequested = useRef(new Set<string>());
  const [focused, setFocused] = useState<string | null>(null);
  const [size, setSize] = useState({ width: 800, height: 500 });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const root = activeId?.replace(/^terminal:/, "") ?? null;
  let tree: TerminalLayout | null = root ? layouts[root] ?? { id: root } : null;
  for (const id of exited) if (tree) tree = hideTerminal(tree, id);
  const leaves = tree ? terminalLeaves(tree) : [];
  const focus = leaves.includes(focused ?? "") ? focused! : leaves[0];
  useEffect(() => {
    if (!removeCompleted) return;
    for (const id of completed) {
      const workspaceId = known.current.get(id);
      if (!workspaceId || id === focus || cleanupRequested.current.has(id)) continue;
      cleanupRequested.current.add(id);
      void removeCompleted(id, workspaceId).catch(reason => setError(String(reason)))
        .finally(() => cleanupRequested.current.delete(id));
    }
  }, [completed, focus, removeCompleted]);
  useEffect(() => {
    for (const tab of tabs) if (tab.id.startsWith("terminal:")) {
      const id = tab.id.slice(9);
      if (terminalLeaves(layouts[id] ?? { id }).every(leaf => exited.includes(leaf))) close(id);
    }
  }, [exited, tabs, layouts, close]);
  useImperativeHandle(ref, () => ({ reveal(id) {
    const group = Object.entries(layouts).find(([, node]) => terminalLeaves(node).includes(id))?.[0];
    if (!group && layouts[id]) setLayouts(current => ({ ...current, [id]: { axis: "row", fraction: .5, first: current[id], second: { id } } }));
    setFocused(id); return group ?? id;
  }, pasteToChat(id, code) {
    const panel = panels.current.get(id);
    if (!panel) throw new Error("Терминальный чат недоступен.");
    panel.pasteToChat(code);
  }, has: id => known.current.has(id), visibleIds: () => leaves, focusedId: () => focus, replacementFor(id) {
    const remaining = layouts[id] && terminalLeaves(layouts[id]).filter(leaf => leaf !== id && !exited.includes(leaf));
    return remaining?.includes(focus) ? focus : remaining?.[0];
  }, forget(id, replacement) {
    known.current.delete(id);
    setCreated(current => current.filter(terminal => terminal.id !== id));
    setCompleted(current => current.filter(terminal => terminal !== id));
    setExited(current => current.filter(terminal => terminal !== id));
    setLayouts(current => {
      const next: Record<string, TerminalLayout> = {};
      for (const [root, node] of Object.entries(current)) {
        const remaining = hideTerminal(node, id);
        const key = root === id ? replacement : root;
        if (key && remaining) next[key] = remaining;
      }
      return next;
    });
  }, focus() {
    const pane = host.current?.querySelector(".terminal-pane.focused");
    const input = pane?.querySelector<HTMLElement>(".terminal-command-input textarea");
    if (input && !input.closest("[hidden]")) input.focus();
    else pane?.querySelector<HTMLElement>(".xterm-helper-textarea")?.focus();
  } }), [layouts, exited, leaves, focus]);
  useEffect(() => {
    if (leaves.length < 2) return;
    const element = host.current!;
    const measure = () => {
      if (element.clientWidth && element.clientHeight) setSize({ width: element.clientWidth, height: element.clientHeight });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element); return () => observer.disconnect();
  }, [leaves.length, root]);
  async function split(id: string, axis: Axis) {
    if (!root || busy) return;
    const target = root;
    setBusy(true); setError("");
    try {
      const terminal = await invoke<TerminalInfo>("start_terminal", { workspaceId: known.current.get(id), sourceId: id, cols: 80, rows: 24 });
      setCreated(current => [...current, terminal]);
      setLayouts(current => ({ ...current, [target]: splitTerminal(current[target] ?? { id: target }, id, terminal.id, axis) }));
      setFocused(terminal.id);
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }
  function hide(id: string) {
    if (!root || !tree) return;
    const next = hideTerminal(tree, id);
    if (!next) { close(root); return; }
    setLayouts(current => ({ ...current, [root]: next })); setFocused(terminalLeaves(next)[0]);
  }
  const rectangles = new Map<string, CSSProperties>();
  const separators: { path: string; axis: Axis; length: number; fraction: number; style: CSSProperties }[] = [];
  function position(node: TerminalLayout, x: number, y: number, width: number, height: number, path = "") {
    if ("id" in node) {
      rectangles.set(node.id, { left: `${x * 100}%`, top: `${y * 100}%`, width: `calc(${width * 100}% - 2px)`, height: `calc(${height * 100}% - 2px)` }); return;
    }
    const f = node.fraction;
    separators.push({ path, axis: node.axis, length: node.axis === "row" ? width * size.width : height * size.height, fraction: f,
      style: node.axis === "row" ? { left: `calc(${(x + width * f) * 100}% - 2px)`, top: `${y * 100}%`, height: `${height * 100}%` }
        : { left: `${x * 100}%`, top: `calc(${(y + height * f) * 100}% - 2px)`, width: `${width * 100}%` } });
    position(node.first, x, y, node.axis === "row" ? width * f : width, node.axis === "column" ? height * f : height, path ? path + ".first" : "first");
    position(node.second, node.axis === "row" ? x + width * f : x, node.axis === "column" ? y + height * f : y,
      node.axis === "row" ? width * (1 - f) : width, node.axis === "column" ? height * (1 - f) : height, path ? path + ".second" : "second");
  }
  if (tree) position(tree, 0, 0, 1, 1);
  return <div className="terminal-workspace" ref={host} aria-busy={busy} onKeyDownCapture={event => {
    if (!event.ctrlKey || !event.altKey || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key) || leaves.length < 2) return;
    event.preventDefault(); event.stopPropagation();
    const direction = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
    setFocused(leaves[(leaves.indexOf(focus) + leaves.length + direction) % leaves.length]);
  }}>
    {error && <p role="alert" className="error terminal-layout-error">{error}</p>}
    {[...known.current].filter(([, workspaceId]) => workspaces.some(workspace => workspace.id === workspaceId && !workspace.deleted)).map(([id, workspaceId]) => <div
      className={`terminal-pane ${id === focus ? "focused" : ""}`} key={id} hidden={!rectangles.has(id)} style={rectangles.get(id)} onFocusCapture={() => setFocused(id)} onMouseDown={() => setFocused(id)}>
      <TerminalPanel ref={panel => { if (panel) panels.current.set(id, panel); else panels.current.delete(id); }}
        workspaceId={workspaceId} id={id} active={rectangles.has(id)} focused={id === focus} workspacePath={workspaces.find(workspace => workspace.id === workspaceId)?.path}
        screenReaderEnabled={screenReaderEnabled}
        fileWorkspaces={fileWorkspaces.current}
        openFile={(...args) => openFile(workspaceId, ...args)} split={axis => { void split(id, axis); }} close={() => hide(id)}
        onExit={state => (state === "completed" && removeCompleted ? setCompleted : setExited)(current => current.includes(id) ? current : [...current, id])} />
    </div>)}
    {separators.map(separator => <div key={separator.path} className={`terminal-separator ${separator.axis}`} style={separator.style}><Splitter
      label={separator.axis === "row" ? "Ширина терминала" : "Высота терминала"} vertical={separator.axis === "column"} reverse={false}
      value={separator.length * separator.fraction} min={Math.min(100, separator.length * .25)} max={separator.length - Math.min(100, separator.length * .25)}
      change={value => { if (root) setLayouts(current => ({ ...current, [root]: resizeTerminal(current[root], separator.path, value / separator.length) })); }} /></div>)}
  </div>;
});
