import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { EditorState, Prec, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { LSPClient, LSPPlugin, hoverTooltips, serverCompletion, serverDiagnostics, signatureHelp, showSignatureHelp } from "@codemirror/lsp-client";
import DOMPurify from "dompurify";
import type { Diagnostic, DocumentSymbol, Location, LocationLink, Position, SymbolInformation } from "vscode-languageserver-protocol";
import type { FileLocation } from "./CodeEditor";
import { defaultShortcuts, shortcutMatcher, type ShortcutBindings, type ShortcutCommand } from "./shortcuts";

export type Language = "go" | "typescript";
export type NavigationMode = "all" | "files" | "symbols" | "text" | "structure" | "problems" | "line" | "rename";
export interface CodeLocation { path: string; line: number; column: number; utf16?: boolean }
export interface NavigationItem extends CodeLocation { name: string; detail?: string; code?: string }
export interface LanguageTool { language: Language; available: boolean; prerequisite: string | null }
interface Session {
  language: Language; status: "idle" | "starting" | "ready" | "missing" | "trust" | "error";
  client?: LSPClient; id?: string; rootUri?: string; error: string;
  pending?: Promise<LSPClient>; disposed: boolean; owners: number;
  prerequisite?: string;
  diagnosticUris: Set<string>;
}
interface CodeWorkspace {
  sessions: Map<Language, Session>; editors: Map<string, EditorView>; activePath: string | null;
  open?: (path: string, location?: FileLocation) => Promise<void>;
  request?: (mode: NavigationMode, items?: NavigationItem[], title?: string) => void;
  history: CodeLocation[]; index: number; replaying: boolean; visible: boolean;
  diagnostics: Map<string, Diagnostic[]>;
}
const workspaces = new Map<string, CodeWorkspace>();
const listeners = new Set<() => void>();
let revision = 0;
export function codeChanged() { revision++; for (const listener of listeners) listener(); }
export function useCodeRevision() { return useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener); }, () => revision); }
export function codeWorkspace(id: string): CodeWorkspace {
  let workspace = workspaces.get(id);
  if (!workspace) {
    workspace = { sessions: new Map(), editors: new Map(), activePath: null, history: [], index: -1, replaying: false, visible: false, diagnostics: new Map() };
    workspaces.set(id, workspace);
  }
  return workspace;
}
export function languageFor(path: string): Language | null {
  const extension = path.split(".").at(-1)?.toLowerCase();
  return extension === "go" ? "go" : ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"].includes(extension ?? "") ? "typescript" : null;
}
export function languageId(path: string) {
  return /\.tsx$/i.test(path) ? "typescriptreact" : /\.jsx$/i.test(path) ? "javascriptreact" : /\.(?:js|mjs|cjs)$/i.test(path) ? "javascript" : languageFor(path) ?? "plaintext";
}
export function fileUri(root: string, path: string) {
  return path.startsWith("file:") ? path : new URL(path.split("/").map(encodeURIComponent).join("/"), root.endsWith("/") ? root : root + "/").href;
}
export function fileFromUri(root: string, uri: string) {
  const base = new URL(root), file = new URL(uri);
  if (file.protocol !== "file:" || file.host !== base.host) throw new Error("Ожидался локальный файл");
  const prefix = decodeURIComponent(base.pathname).replace(/\/$/, "") + "/";
  const path = decodeURIComponent(file.pathname);
  return path.startsWith(prefix) ? path.slice(prefix.length) : file.href;
}
export function symbolItems(symbols: (DocumentSymbol | SymbolInformation)[], root: string, uri?: string, container = ""): NavigationItem[] {
  return symbols.flatMap(symbol => {
    const location = "location" in symbol ? symbol.location : { uri: uri!, range: symbol.selectionRange };
    if (!location.uri || !location.range) return [];
    const path = fileFromUri(root, location.uri), position = location.range.start;
    const item = { path, name: symbol.name, detail: [container, path].filter(Boolean).join(" · "), line: position.line + 1, column: position.character + 1, utf16: true };
    return [item, ...("children" in symbol && symbol.children ? symbolItems(symbol.children, root, uri, [container, symbol.name].filter(Boolean).join(".")) : [])];
  });
}
export function currentLocation(workspaceId: string): CodeLocation | null {
  const workspace = codeWorkspace(workspaceId), path = workspace.activePath;
  const view = path && workspace.editors.get(path);
  if (!path || !view) return null;
  const head = view.state.selection.main.head, line = view.state.doc.lineAt(head);
  return { path, line: line.number, column: head - line.from + 1, utf16: true };
}
export function recordNavigation(workspaceId: string, destination: CodeLocation, origin = currentLocation(workspaceId)) {
  const workspace = codeWorkspace(workspaceId);
  if (workspace.replaying) return;
  workspace.history.splice(workspace.index + 1);
  const add = (location: CodeLocation | null) => {
    const last = workspace.history.at(-1);
    if (location && (!last || last.path !== location.path || last.line !== location.line || last.column !== location.column)) workspace.history.push(location);
  };
  add(origin); add(destination);
  if (workspace.history.length > 200) workspace.history.splice(0, workspace.history.length - 200);
  workspace.index = workspace.history.length - 1;
  codeChanged();
}
export async function navigate(workspaceId: string, location: CodeLocation & Pick<FileLocation, "query" | "text">) {
  const workspace = codeWorkspace(workspaceId);
  if (!workspace.open) throw new Error("Пространство недоступно");
  await workspace.open(location.path, { ...location, request: Date.now() + Math.random() });
}
export async function navigateHistory(workspaceId: string, direction: number) {
  const workspace = codeWorkspace(workspaceId), index = workspace.index + direction;
  if (index < 0 || index >= workspace.history.length) return;
  const current = currentLocation(workspaceId);
  if (current) workspace.history[workspace.index] = current;
  workspace.replaying = true;
  try { await navigate(workspaceId, workspace.history[index]); workspace.index = index; }
  finally { workspace.replaying = false; codeChanged(); }
}
function session(workspaceId: string, language: Language) {
  const workspace = codeWorkspace(workspaceId);
  let value = workspace.sessions.get(language);
  if (!value) { value = { language, status: "idle", error: "", disposed: false, owners: 0, diagnosticUris: new Set() }; workspace.sessions.set(language, value); }
  return value;
}
function stopSession(workspaceId: string, value: Session) {
  value.disposed = true;
  value.client?.disconnect();
  if (value.id) void invoke("stop_language_server", { id: value.id }).catch(() => {});
  const workspace = codeWorkspace(workspaceId);
  if (workspace.sessions.get(value.language) === value) workspace.sessions.delete(value.language);
  for (const uri of value.diagnosticUris) workspace.diagnostics.delete(uri);
  codeChanged();
}
export function releaseWorkspace(workspaceId: string) {
  const workspace = codeWorkspace(workspaceId);
  workspace.visible = false; workspace.open = undefined; workspace.request = undefined;
  for (const value of workspace.sessions.values()) if (!value.owners) stopSession(workspaceId, value);
}
export async function ensureLanguage(workspaceId: string, language: Language, confirmTrust = false): Promise<LSPClient> {
  const value = session(workspaceId, language);
  if (value.pending) return value.pending;
  value.status = "starting"; value.error = ""; codeChanged();
  value.pending = (async () => {
    const tools = await invoke<LanguageTool[]>("language_tools");
    const tool = tools.find(tool => tool.language === language);
    if (!tool?.available || tool.prerequisite) {
      value.status = "missing";
      value.prerequisite = tool?.prerequisite ?? undefined;
      throw new Error(tool?.prerequisite || `Поддержка ${language === "go" ? "Go" : "TypeScript / JavaScript"} не установлена`);
    }
    const handlers = new Set<(message: string) => void>(), buffered: string[] = [];
    let sending = Promise.resolve();
    const fail = (reason: unknown) => {
      if (value.disposed) return;
      value.error = String(reason); value.status = "error"; codeChanged();
    };
    const send = (message: string) => {
      sending = sending.then(() => invoke<void>("send_language_message", { id: value.id, message })).catch(fail);
    };
    const events = new Channel<{ message: string | null; error: string | null }>();
    events.onmessage = event => {
      if (value.disposed) return;
      if (event.error) { fail(event.error); return; }
      if (!event.message) return;
      const message = JSON.parse(event.message);
      if (message.id !== undefined && message.method) {
        const result = message.method === "workspace/configuration" ? (message.params?.items ?? []).map(() => ({}))
          : message.method === "workspace/applyEdit" ? { applied: false, failureReason: "Изменения требуют предварительного просмотра" }
          : ["client/registerCapability", "client/unregisterCapability", "window/workDoneProgress/create"].includes(message.method) ? null : undefined;
        if (result !== undefined) { send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result })); return; }
      }
      if (!handlers.size) buffered.push(event.message);
      else for (const handler of handlers) handler(event.message);
    };
    const started = await invoke<{ id: string; rootUri: string } | null>("start_language_server", { workspaceId, language, confirmTrust, events });
    if (!started) {
      if (!value.disposed) value.status = "trust";
      throw new Error("Подключение навигации требует доверия к рабочему пространству");
    }
    value.id = started.id; value.rootUri = started.rootUri;
    if (value.disposed) { await invoke("stop_language_server", { id: value.id }); throw new Error("Подключение закрыто"); }
    const workspace = codeWorkspace(workspaceId);
    const diagnostics = serverDiagnostics();
    const client = new LSPClient({
      rootUri: started.rootUri, timeout: 30000,
      // Синтаксический сервер при загрузке проекта возвращает импорты вместо определений.
      initializationOptions: language === "typescript" ? { tsserver: { useSyntaxServer: "never" } } : undefined,
      sanitizeHTML: html => DOMPurify.sanitize(html),
      extensions: [serverCompletion({ override: true }), hoverTooltips(), signatureHelp({ keymap: false }), diagnostics],
      notificationHandlers: {
        "textDocument/publishDiagnostics": (client, params) => {
          if (typeof params.version === "number" && (client.workspace.getFile(params.uri)?.version ?? -1) > params.version) return true;
          value.diagnosticUris.add(params.uri);
          workspace.diagnostics.set(params.uri, params.diagnostics);
          diagnostics.notificationHandlers?.["textDocument/publishDiagnostics"]?.(client, params);
          codeChanged(); return true;
        },
        "window/showMessage": (_client, params) => { if (params.type === 1) { value.error = params.message; codeChanged(); } return true; },
      },
    });
    value.client = client;
    client.connect({ send, subscribe: handler => { handlers.add(handler); for (const message of buffered.splice(0)) handler(message); }, unsubscribe: handler => { handlers.delete(handler); } });
    await client.initializing;
    if (value.disposed) throw new Error("Подключение закрыто");
    value.status = "ready"; codeChanged();
    return client;
  })().catch(reason => {
    if (!value.disposed) { value.error = reason instanceof Error ? reason.message : String(reason); if (value.status !== "missing" && value.status !== "trust") value.status = "error"; codeChanged(); }
    throw reason;
  });
  return value.pending;
}
export async function retryLanguage(workspaceId: string, language: Language, install = false) {
  if (install) await invoke("install_language_tool", { language });
  const previous = session(workspaceId, language), owners = previous.owners;
  const confirmTrust = previous.status === "trust";
  stopSession(workspaceId, previous);
  session(workspaceId, language).owners = owners;
  return ensureLanguage(workspaceId, language, confirmTrust);
}
export function useLanguageSupport(workspaceId: string | undefined, path: string, active: boolean): Extension {
  useCodeRevision();
  const [opened, setOpened] = useState(active);
  useEffect(() => { if (active) setOpened(true); }, [active]);
  const language = languageFor(path);
  useEffect(() => {
    if (!workspaceId || !language || !opened) return;
    session(workspaceId, language).owners++;
    void ensureLanguage(workspaceId, language).catch(() => {});
    return () => {
      const current = session(workspaceId, language);
      current.owners--;
      if (!current.owners && !codeWorkspace(workspaceId).visible) stopSession(workspaceId, current);
    };
  }, [workspaceId, language, opened]);
  const value = workspaceId && language && opened ? session(workspaceId, language) : null;
  const client = value?.status === "ready" ? value.client : null, root = value?.rootUri;
  return useMemo(() => !client || !root || !workspaceId ? [] : client.plugin(fileUri(root, path), languageId(path)), [client, root, path, workspaceId]);
}
export function registerCodeEditor(workspaceId: string, path: string, view: EditorView) {
  const workspace = codeWorkspace(workspaceId);
  workspace.editors.set(path, view);
  codeChanged();
  return () => {
    if (workspace.editors.get(path) === view) {
      workspace.editors.delete(path);
      if (workspace.activePath === path) workspace.activePath = null;
      codeChanged();
    }
  };
}
export function activeEditor(workspaceId: string) {
  const workspace = codeWorkspace(workspaceId);
  return workspace.activePath ? workspace.editors.get(workspace.activePath) ?? null : null;
}
export async function requestLocations(workspaceId: string, view: EditorView, method: string) {
  const plugin = LSPPlugin.get(view);
  if (!plugin) throw new Error("Дождитесь подключения поддержки языка");
  plugin.client.sync();
  const head = view.state.selection.main.head;
  const word = view.state.wordAt(head);
  const wordStart = plugin.toPosition(word?.from ?? head);
  const name = word ? view.state.sliceDoc(word.from, word.to) : "";
  const parameters = { textDocument: { uri: plugin.uri }, position: plugin.toPosition(head) };
  await plugin.client.withMapping(async mapping => {
    let references = method === "textDocument/references";
    const response = await plugin.client.request<object, Location | Location[] | LocationLink[] | null>(method, {
      ...parameters, ...(references ? { context: { includeDeclaration: false } } : {}),
    });
    let locations: (Location | LocationLink)[] = Array.isArray(response) ? response : response ? [response] : [];
    if (method === "textDocument/definition" && locations.length && locations.every(location => {
      const uri = "targetUri" in location ? location.targetUri : location.uri;
      const range = "targetSelectionRange" in location ? location.targetSelectionRange : location.range;
      return uri === plugin.uri && range.start.line === wordStart.line && range.start.character === wordStart.character;
    })) {
      locations = await plugin.client.request<object, Location[] | null>("textDocument/references", { ...parameters, context: { includeDeclaration: false } }) ?? [];
      references = true;
    }
    const root = session(workspaceId, languageFor(plugin.uri)!).rootUri!;
    const items = locations.map(value => {
      const uri = "targetUri" in value ? value.targetUri : value.uri;
      const range = "targetSelectionRange" in value ? value.targetSelectionRange : value.range;
      const path = fileFromUri(root, uri);
      let position = range.start;
      const target = plugin.client.workspace.getFile(uri)?.getView();
      if (target) {
        const offset = mapping.mapPosition(uri, range.start), line = target.state.doc.lineAt(offset);
        position = { line: line.number - 1, character: offset - line.from };
      }
      return { path, line: position.line + 1, column: position.character + 1, utf16: true, name: path.split("/").at(-1) ?? path, detail: `${path}:${position.line + 1}` };
    });
    if (items.length === 1 && method !== "textDocument/references") await navigate(workspaceId, items[0]);
    else {
      const lines = new Map<string, string[]>();
      // shortcut: фрагменты есть у первых 100 результатов; при постраничной выдаче загружать следующую страницу.
      await Promise.allSettled([...new Set(items.slice(0, 100).map(item => item.path))].map(async path => {
        const editor = codeWorkspace(workspaceId).editors.get(path);
        const body = editor?.state.sliceDoc() ?? (path.startsWith("file:")
          ? (await invoke<{ body: string }>("read_language_file", { workspaceId, uri: path })).body
          : await invoke<string | null>("read_file_disk", { workspaceId, path }));
        if (body !== null) lines.set(path, body.split(/\r\n?|\n/));
      }));
      codeWorkspace(workspaceId).request?.("symbols", items.map(item => ({ ...item, code: lines.get(item.path)?.[item.line - 1]?.trim() })), `${references ? "Использования" : "Результаты перехода"}${name ? ` · ${name}` : ""}`);
    }
  });
}
export function navigationKeys(workspaceId: string, bindings: () => ShortcutBindings = () => defaultShortcuts) {
  const match = shortcutMatcher();
  const request = (method: string) => (view: EditorView) => {
    void requestLocations(workspaceId, view, method).catch(reason => codeWorkspace(workspaceId).request?.("symbols", [], String(reason)));
  };
  const handlers: Partial<Record<ShortcutCommand, (view: EditorView) => void>> = {
    definition: request("textDocument/definition"), typeDefinition: request("textDocument/typeDefinition"),
    implementation: request("textDocument/implementation"), references: request("textDocument/references"),
    rename: () => { codeWorkspace(workspaceId).request?.("rename"); },
    signature: showSignatureHelp,
    back: () => { void navigateHistory(workspaceId, -1); }, forward: () => { void navigateHistory(workspaceId, 1); },
  };
  return Prec.highest(EditorView.domEventHandlers({ keydown(event, view) {
    if (event.isComposing || event.defaultPrevented || document.querySelector("dialog[open]")) return false;
    const key = match(event);
    const id = (Object.keys(handlers) as ShortcutCommand[]).find(id => key !== null && bindings()[id] === key);
    if (!id) return false;
    event.preventDefault(); event.stopPropagation();
    if (!event.repeat) handlers[id]?.(view);
    return true;
  } }));
}

export function applyTextEdits(body: string, edits: { range: { start: Position; end: Position }; newText: string }[]) {
  const state = EditorState.create({ doc: body, extensions: EditorState.lineSeparator.of(body.includes("\r\n") ? "\r\n" : "\n") });
  const offset = (position: Position) => {
    if (position.line < 0 || position.line >= state.doc.lines || position.character < 0) throw new Error("Языковой сервер вернул неверную позицию");
    const line = state.doc.line(position.line + 1);
    if (position.character > line.length) throw new Error("Файл изменился после запроса");
    return line.from + position.character;
  };
  return state.update({ changes: edits.map(edit => ({ from: offset(edit.range.start), to: offset(edit.range.end), insert: edit.newText })) }).state.sliceDoc();
}
