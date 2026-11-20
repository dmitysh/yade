import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { basicSetup } from "codemirror";
import { Compartment, EditorState, RangeSet, StateEffect, StateField, type Extension, type Text } from "@codemirror/state";
import { Decoration, EditorView, GutterMarker, drawSelection, gutter, showTooltip, type DecorationSet, type Tooltip } from "@codemirror/view";
import { openSearchPanel } from "@codemirror/search";
import { Chunk, diff, MergeView } from "@codemirror/merge";
import { forceParsing, language } from "@codemirror/language";
import { editorThemeExtension } from "./editorThemes";
import { editorLinks } from "./editorLinks";
import { Icon } from "./Ide";
import GitMenu from "./GitMenu";
import { monoFonts, useAppearance } from "./appearance";
import { formatShortcut, shortcutMatcher, useShortcuts } from "./shortcuts";
import { fileType } from "./fileTypes";
import { loadFileLanguage } from "./fileLanguages";
import { documentSearch } from "./documentSearch";
import type { GitDiff } from "./types";
import { codeChanged, codeWorkspace, navigationKeys, registerCodeEditor, requestLocations, useLanguageSupport } from "./codeIntelligence";

const editorSetup = [basicSetup, drawSelection({ drawRangeCursor: false })];
const phrases = EditorState.phrases.of({
  Find: "Найти в документе", Replace: "Заменить", next: "Далее", previous: "Назад", all: "Все",
  "match case": "Учитывать регистр", regexp: "Регулярное выражение", "by word": "Слово целиком",
  replace: "Заменить", "replace all": "Заменить все", close: "Закрыть поиск", "Go to line": "Перейти к строке", go: "Перейти",
  "current match": "Текущее совпадение", "on line": "в строке", "replaced $ matches": "Заменено совпадений: $",
  "replaced match on line $": "Заменено совпадение в строке $",
});
const parseVisible = EditorView.updateListener.of(update => {
  if (update.viewportChanged || update.startState.facet(language) !== update.state.facet(language)) forceParsing(update.view);
});
const highlightNavigation = StateEffect.define<DecorationSet>();
const navigationHighlight = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update: (value, transaction) => {
    for (const effect of transaction.effects) if (effect.is(highlightNavigation)) return effect.value;
    return value.map(transaction.changes);
  },
  provide: field => EditorView.decorations.from(field),
});
const navigationBackground = "#d8d0aa";
const navigationPulseFrames = {
  "0%, 100%": { backgroundColor: "var(--editor-active-line, #30333a)", color: "var(--editor-foreground, #bcbec4)" },
  "6%, 77%": { backgroundColor: navigationBackground, color: "#1e1f22" },
};
const theme = EditorView.theme({
  "&": { color: "var(--editor-foreground, #bcbec4)", backgroundColor: "var(--editor-background, #1e1f22)" },
  ".cm-content": { fontFamily: "var(--font-editor, ui-monospace, monospace)", minHeight: "300px" },
  ".cm-scroller": { fontFamily: "var(--font-editor, ui-monospace, monospace)" },
  ".cm-gutters": { backgroundColor: "var(--editor-gutter-background, #1e1f22)", color: "var(--editor-line-number, #737782)", borderColor: "var(--editor-gutter-border, #343944)" },
  ".cm-activeLineGutter": { color: "var(--editor-active-line-number, #bcbec4)", backgroundColor: "var(--editor-active-line, #30333a)" },
  ".cm-activeLine": { position: "relative", backgroundColor: "transparent" },
  ".cm-activeLine::before": {
    // Фон строки находится под слоем выделения CodeMirror.
    content: "''", position: "absolute", inset: "0", zIndex: "-3", pointerEvents: "none",
    backgroundColor: "var(--editor-active-line, #30333a)", boxShadow: "inset 0 0 0 1px var(--editor-active-line-border, transparent)",
  },
  ".cm-line.cm-navigation-highlight": {
    backgroundColor: navigationBackground, color: "#1e1f22", minWidth: "100%", boxSizing: "border-box",
    animation: "cm-navigation-pulse 2.6s ease-in-out forwards",
  },
  '.cm-line.cm-navigation-highlight[data-navigation-pulse="1"]': { animationName: "cm-navigation-pulse-repeat" },
  ".cm-line.cm-navigation-highlight *": { color: "inherit" },
  "@keyframes cm-navigation-pulse": navigationPulseFrames,
  "@keyframes cm-navigation-pulse-repeat": navigationPulseFrames,
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--editor-cursor, #b9bac0)" },
  ".cm-selectionBackground": { backgroundColor: "var(--editor-inactive-selection, #3a3d41)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": { backgroundColor: "var(--editor-selection, #264f78)" },
  ".cm-content ::selection": { backgroundColor: "var(--editor-selection, #264f78)" },
  ".cm-selectionMatch": { backgroundColor: "var(--editor-selection-match, #add6ff26)" },
  ".cm-searchMatch": { backgroundColor: "var(--editor-search-other, #ea5c0055)", outline: "1px solid var(--editor-search-other-border, transparent)" },
  ".cm-searchMatch-selected": { backgroundColor: "var(--editor-search-match, #9e6a03)", outline: "1px solid var(--editor-search-match-border, transparent)" },
  "&.cm-focused .cm-matchingBracket": { backgroundColor: "var(--editor-bracket, #ffffff19)", outline: "1px solid var(--editor-bracket-border, #888888)" },
  ".cm-panels": { color: "var(--editor-panel-foreground, #bcbec4)", backgroundColor: "var(--editor-panel-background, #252526)", borderColor: "var(--editor-panel-border, #454545)" },
  ".cm-textfield, .cm-button": { color: "var(--editor-input-foreground, #cccccc)", backgroundColor: "var(--editor-input-background, #3c3c3c)", border: "1px solid var(--editor-input-border, #555555)", backgroundImage: "none" },
  ".cm-textfield:focus, .cm-button:focus-visible": { outline: "1px solid var(--editor-focus-border, #007fd4)" },
  "&.cm-merge-a .cm-changedLine, .cm-deletedLine": { backgroundColor: "var(--editor-deleted-line, #3e282d)" },
  "&.cm-merge-b .cm-changedLine, .cm-insertedLine": { backgroundColor: "var(--editor-added-line, #1e3a2c)" },
  ".cm-deletedText": { backgroundColor: "var(--editor-deleted-text, #6b343f70)" },
  ".cm-insertedText": { backgroundColor: "var(--editor-added-text, #3d775450)" },
  "&.cm-merge-a .cm-changedText": { backgroundColor: "var(--editor-deleted-text, #6b343f70)" },
  "&.cm-merge-b .cm-changedText": { backgroundColor: "var(--editor-added-text, #3d775450)" },
  ".cm-line-changes .cm-gutterElement": { width: "8px", padding: "0", position: "relative" },
  ".cm-line-changes .cm-line-change": { display: "block", width: "8px", height: "100%", margin: "0", padding: "0", border: "0", borderRadius: "0", background: "transparent", cursor: "pointer" },
  ".cm-line-change::before": { content: "''", display: "block", width: "3px", height: "100%", margin: "0 auto" },
  ".cm-line-change-added::before": { backgroundColor: "var(--editor-gutter-added, #6aab73)" },
  ".cm-line-change-modified::before": { backgroundColor: "var(--editor-gutter-modified, #56a8f5)" },
  ".cm-line-changes .cm-line-change-deleted": { position: "absolute", top: "-4px", height: "8px" },
  ".cm-line-change-deleted::before": { width: "0", height: "0", borderTop: "4px solid transparent", borderBottom: "4px solid transparent", borderLeft: "5px solid var(--editor-gutter-deleted, #f75464)" },
  ".cm-change-popup": { width: "max-content", maxWidth: "min(760px, calc(100vw - 24px))", border: "1px solid var(--editor-panel-border, #454545)", borderRadius: "5px", color: "var(--editor-panel-foreground, #bcbec4)", backgroundColor: "var(--editor-panel-background, #252526)", boxShadow: "0 8px 24px #0006", overflow: "hidden" },
  ".cm-change-popup-toolbar": { display: "flex", alignItems: "center", gap: "4px", minHeight: "32px", padding: "0 6px", borderBottom: "1px solid var(--editor-panel-border, #454545)", font: "12px var(--font-interface, system-ui, sans-serif)" },
  ".cm-change-popup-toolbar > span": { marginRight: "auto", padding: "0 8px" },
  ".cm-change-popup-toolbar button": { display: "grid", placeItems: "center", width: "28px", height: "28px", padding: "4px", color: "inherit", background: "transparent", border: "0", borderRadius: "4px", cursor: "pointer" },
  ".cm-change-popup-toolbar button:hover": { background: "var(--editor-active-line, #ffffff0a)" },
  ".cm-change-popup-toolbar button:disabled": { opacity: "0.4", cursor: "default" },
  ".cm-change-popup-toolbar button:focus-visible": { outline: "2px solid var(--editor-focus-border, #ab84e4)" },
  ".cm-change-popup .cm-change-popup-code .code-editor": { border: "0", margin: "0", minHeight: "0", flex: "none" },
  ".cm-change-popup .code-editor .cm-editor": { height: "auto" },
  ".cm-change-popup .cm-change-popup-code .cm-content": { minHeight: "0", padding: "4px 0" },
  ".cm-change-popup .code-editor .cm-scroller": { maxHeight: "min(260px, 40vh)", overflow: "auto" },
  ".cm-change-popup-code > button": { display: "none" },
  ".cm-change-popup-empty": { margin: "0", padding: "10px 14px", font: "12px var(--font-interface, system-ui, sans-serif)" },
  ".cm-change-popup .comparison": { width: "min(740px, calc(100vw - 26px))" },
  ".cm-change-popup .comparison .cm-mergeView": { height: "min(360px, 50vh)", border: "0" },
});

class ChangeMarker extends GutterMarker {
  constructor(private kind: "added" | "modified" | "deleted" | "unchanged", private from = 0, private open?: (editor: EditorView, from: number) => void) { super(); }
  eq(other: ChangeMarker) { return this.kind === other.kind && this.from === other.from && this.open === other.open; }
  toDOM(editor: EditorView) {
    const marker = document.createElement(this.kind === "unchanged" ? "span" : "button");
    marker.className = `cm-line-change cm-line-change-${this.kind}`;
    marker.title = { added: "Добавленная строка", modified: "Изменённая строка", deleted: "Удалённые строки", unchanged: "" }[this.kind];
    if (marker instanceof HTMLButtonElement) {
      marker.type = "button";
      marker.setAttribute("aria-label", `Показать изменение: ${marker.title.toLocaleLowerCase()}`);
      marker.setAttribute("aria-haspopup", "dialog");
      marker.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); this.open?.(editor, this.from); });
      marker.addEventListener("keydown", event => {
        if (["Enter", " "].includes(event.key)) { event.preventDefault(); event.stopPropagation(); this.open?.(editor, this.from); }
      });
    }
    return marker;
  }
}
const unchangedMarker = new ChangeMarker("unchanged");

interface ChangePreview {
  dom: HTMLElement; original: Text; current: Text; chunk: Chunk; index: number; count: number;
  move: (index: number) => void; revert: () => void; close: () => void;
}

function changeGutter(baseline: string, publish: (preview: ChangePreview) => () => void) {
  const original = EditorState.create({ doc: baseline }).doc;
  const chunks = StateField.define<readonly Chunk[]>({
    create: state => Chunk.build(original, state.doc, { scanLimit: 500 }),
    update: (value, transaction) => transaction.docChanged ? Chunk.updateB(value, original, transaction.newDoc, transaction.changes, { scanLimit: 500 }) : value,
  });
  const reveal = StateEffect.define<Tooltip | null>();
  const popup = StateField.define<Tooltip | null>({
    create: () => null,
    update: (value, transaction) => {
      for (const effect of transaction.effects) if (effect.is(reveal)) return effect.value;
      return transaction.docChanged ? null : value;
    },
    provide: field => showTooltip.from(field),
  });
  function close(editor: EditorView) { editor.dispatch({ effects: reveal.of(null) }); }
  function show(editor: EditorView, index: number) {
    const chunk = editor.state.field(chunks, false)?.[index];
    if (!chunk) return;
    const current = editor.state.doc;
    const pos = Math.min(chunk.fromB, current.length);
    editor.dispatch({ effects: [EditorView.scrollIntoView(pos, { y: "nearest" }), reveal.of({
      pos, above: true,
      create: () => {
        const dom = document.createElement("div");
        dom.className = "cm-change-popup"; dom.tabIndex = -1;
        dom.setAttribute("role", "dialog"); dom.setAttribute("aria-label", "Изменение кода");
        let dispose: (() => void) | undefined;
        const dismiss = () => { close(editor); editor.focus(); };
        function outside(event: PointerEvent) { if (!dom.contains(event.target as Node)) close(editor); }
        function escape(event: KeyboardEvent) {
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); dismiss(); }
        }
        return { dom, offset: { x: 0, y: 4 },
          mount: () => {
            dispose = publish({ dom, original, current, chunk, index, count: editor.state.field(chunks).length,
              close: dismiss, move: next => show(editor, next),
              revert: () => {
                if (editor.state.readOnly || editor.state.doc !== current) return;
                editor.dispatch({ changes: { from: pos, to: Math.min(chunk.toB, current.length), insert: original.slice(chunk.fromA, Math.min(chunk.toA, original.length)) }, userEvent: "input" });
                editor.focus();
              },
            });
            document.addEventListener("pointerdown", outside);
            document.addEventListener("keydown", escape, true);
            dom.focus();
          },
          destroy: () => { dispose?.(); document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape, true); },
        };
      },
    })] });
  }
  const chunkAt = (editor: EditorView, from: number) => editor.state.field(chunks).findIndex(item => item.fromB === item.toB
    ? editor.state.doc.lineAt(Math.min(item.fromB, editor.state.doc.length)).from === from
    : from >= item.fromB && from < item.toB);
  const showLine = (editor: EditorView, from: number) => { const index = chunkAt(editor, from); if (index >= 0) show(editor, index); };
  return [chunks, popup, gutter({
    class: "cm-line-changes",
    initialSpacer: () => unchangedMarker,
    lineMarker: (editor, line) => {
      const chunk = editor.state.field(chunks)[chunkAt(editor, line.from)];
      if (!chunk) return null;
      const kind = chunk.fromB === chunk.toB || !editor.state.doc.length ? "deleted" : chunk.fromA === chunk.toA ? "added" : "modified";
      return new ChangeMarker(kind, line.from, showLine);
    },
    lineMarkerChange: update => update.startState.field(chunks, false) !== update.state.field(chunks, false),
  })];
}

function ChangePreviewPanel({ preview, path, disabled }: { preview: ChangePreview; path: string; disabled: boolean }) {
  const [comparison, setComparison] = useState(false);
  const { chunk, original } = preview;
  const before = original.sliceString(chunk.fromA, Math.min(chunk.endA, original.length));
  const highlights = Decoration.set(chunk.changes.flatMap(change => {
    const from = Math.min(change.fromA, before.length), to = Math.min(change.toA, before.length);
    return from < to ? [Decoration.mark({ class: "cm-deletedText" }).range(from, to)] : [];
  }));
  return <>
    <div className="cm-change-popup-toolbar">
      <button aria-label="Предыдущее изменение" title="Предыдущее изменение" disabled={preview.index === 0} onClick={() => preview.move(preview.index - 1)}>↑</button>
      <button aria-label="Следующее изменение" title="Следующее изменение" disabled={preview.index === preview.count - 1} onClick={() => preview.move(preview.index + 1)}>↓</button>
      <button aria-label="Откатить фрагмент" title="Откатить фрагмент" disabled={disabled} onClick={preview.revert}><Icon name="history" /></button>
      <button aria-label="Сравнить весь файл" title="Сравнить весь файл" aria-pressed={comparison} onClick={() => setComparison(value => !value)}><Icon name="layout" /></button>
      <span>{preview.index + 1} / {preview.count} · {comparison ? "Сравнение файла" : "Исходная версия"}</span>
      <button aria-label="Закрыть изменение" title="Закрыть · Escape" onClick={preview.close}><Icon name="close" /></button>
    </div>
    {comparison ? <Comparison path={path} a={original.toString()} b={preview.current.toString()} />
      : chunk.fromA === chunk.toA ? <p className="cm-change-popup-empty">Добавленные строки — в исходной версии их не было.</p>
      : <div className="cm-change-popup-code"><CodeEditor key={preview.index} path={path} body={before} disabled change={() => {}} save={() => {}} extensions={[EditorView.decorations.of(highlights)]} /></div>}
  </>;
}

export interface FileLocation { line: number; column: number; request: number; query?: string; text?: string; utf16?: boolean }

export default function CodeEditor({ path, body, disk, baseline, active = true, focused = false, disabled, location, change, save, extensions = [], workspaceId, addToChat }: {
  path: string; body: string; disk?: string | null; baseline?: string; active?: boolean; disabled: boolean; location?: FileLocation;
  change: (body: string) => void; save: () => void;
  extensions?: Extension[];
  focused?: boolean;
  workspaceId?: string;
  addToChat?: (code: string) => void;
}) {
  const { appearance, theme: selectedTheme } = useAppearance();
  const highlighting = useMemo(() => editorThemeExtension(selectedTheme), [selectedTheme]);
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const callbacks = useRef({ change, save, addToChat: active ? addToChat : undefined });
  callbacks.current = { change, save, addToChat: active ? addToChat : undefined };
  const editable = useRef(new Compartment());
  const separator = useRef(new Compartment());
  const wrapping = useRef(new Compartment());
  const language = useRef(new Compartment());
  const changes = useRef(new Compartment());
  const colors = useRef(new Compartment());
  const intelligence = useRef(new Compartment());
  const support = useLanguageSupport(workspaceId, path, active);
  const { bindings } = useShortcuts();
  const keyBindings = useRef(bindings); keyBindings.current = bindings;
  const shortcuts = useMemo(() => workspaceId ? navigationKeys(workspaceId, () => keyBindings.current) : [], [workspaceId]);
  const mode = fileType(path, body).id;
  const [languageError, setLanguageError] = useState("");
  const appliedLocation = useRef<FileLocation | null>(null);
  const navigationPulse = useRef(0);
  const [locationError, setLocationError] = useState("");
  const [preview, setPreview] = useState<ChangePreview | null>(null);
  function publishPreview(next: ChangePreview) {
    setPreview(next);
    return () => setPreview(current => current?.dom === next.dom ? null : current);
  }

  function hasCodeSelection(editor: EditorView | null, target: EventTarget) {
    return !!callbacks.current.addToChat && !!editor && !editor.state.selection.main.empty
      && target instanceof Node && editor.contentDOM.contains(target);
  }

  function addSelectionToChat(editor: EditorView) {
    const { from, to, empty } = editor.state.selection.main;
    if (empty || !callbacks.current.addToChat) return;
    const doc = editor.state.doc;
    const start = doc.lineAt(from).number, end = doc.lineAt(to - 1).number;
    const code = doc.sliceString(from, to);
    let fenceLength = 3;
    for (const [run] of code.matchAll(/`{3,}/g)) fenceLength = Math.max(fenceLength, run.length + 1);
    const fence = "`".repeat(fenceLength);
    callbacks.current.addToChat(`${path}:${start}${end === start ? "" : `–${end}`}\n${fence}\n${code}${code.endsWith("\n") ? "" : "\n"}${fence}`);
  }

  useEffect(() => {
    const matchShortcut = shortcutMatcher();
    const editor = new EditorView({ parent: host.current!, doc: body, extensions: [
      EditorView.domEventHandlers({ keydown: (event, editor) => {
        const key = matchShortcut(event);
        if (!key || document.querySelector("dialog[open]")) return false;
        if (key === keyBindings.current.addToChat && event.target && hasCodeSelection(editor, event.target)) {
          event.preventDefault(); if (!event.repeat) addSelectionToChat(editor); return true;
        }
        if (key !== keyBindings.current.save) return false;
        event.preventDefault(); if (!event.repeat) callbacks.current.save(); return true;
      } }),
      editorLinks, shortcuts, editorSetup, documentSearch, theme, phrases, parseVisible, navigationHighlight, colors.current.of(highlighting), extensions, intelligence.current.of(support), language.current.of([]), editable.current.of([EditorView.editable.of(!disabled), EditorState.readOnly.of(disabled)]),
      workspaceId ? EditorView.domEventHandlers({ mousedown: (event, editor) => {
        if (event.button !== 0 || !(event.metaKey || event.ctrlKey)) return false;
        const position = editor.posAtCoords({ x: event.clientX, y: event.clientY });
        if (position === null) return false;
        event.preventDefault();
        editor.dispatch({ selection: { anchor: position } });
        const method = event.shiftKey ? "textDocument/typeDefinition" : event.altKey ? "textDocument/implementation" : "textDocument/definition";
        void requestLocations(workspaceId, editor, method).catch(reason => codeWorkspace(workspaceId).request?.("symbols", [], String(reason)));
        return true;
      } }) : [],
      separator.current.of(EditorState.lineSeparator.of(body.includes("\r\n") ? "\r\n" : "\n")),
      wrapping.current.of(appearance.wrapCode ? EditorView.lineWrapping : []),
      changes.current.of(baseline === undefined || !active ? [] : changeGutter(baseline, publishPreview)),
      EditorView.contentAttributes.of({ "aria-label": `Код ${path}` }),
      EditorView.updateListener.of(update => { if (update.docChanged) callbacks.current.change(update.state.sliceDoc()); }),
    ] });
    view.current = editor;
    const unregister = workspaceId ? registerCodeEditor(workspaceId, path, editor) : undefined;
    return () => { unregister?.(); view.current = null; editor.destroy(); };
  }, [path, workspaceId]);

  useEffect(() => { view.current?.dispatch({ effects: intelligence.current.reconfigure(support) }); }, [support]);
  useEffect(() => { if (workspaceId && active) { const workspace = codeWorkspace(workspaceId); if (workspace.activePath !== path) { workspace.activePath = path; codeChanged(); } } }, [workspaceId, path, active]);

  useEffect(() => { view.current?.dispatch({ effects: colors.current.reconfigure(highlighting) }); }, [highlighting, path]);

  useEffect(() => {
    const editor = view.current!;
    let disposed = false;
    setLanguageError("");
    editor.dispatch({ effects: language.current.reconfigure([]) });
    loadFileLanguage(mode).then(support => {
      if (!disposed) editor.dispatch({ effects: language.current.reconfigure(support) });
    }).catch(() => { if (!disposed) setLanguageError("Подсветка недоступна. Текст можно редактировать."); });
    return () => { disposed = true; };
  }, [path, mode]);

  useEffect(() => {
    const editor = view.current;
    if (editor && editor.state.sliceDoc() !== body) {
      editor.dispatch({
        changes: { from: 0, to: editor.state.doc.length, insert: EditorState.create({ doc: body }).doc },
        effects: separator.current.reconfigure(EditorState.lineSeparator.of(body.includes("\r\n") ? "\r\n" : "\n")),
      });
    }
  }, [body]);
  useEffect(() => { view.current?.dispatch({ effects: editable.current.reconfigure([EditorView.editable.of(!disabled), EditorState.readOnly.of(disabled)]) }); }, [disabled]);
  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    editor.dispatch({ effects: changes.current.reconfigure(baseline === undefined || !active ? [] : changeGutter(baseline, publishPreview)) });
    const column = editor.dom.querySelector(".cm-line-changes");
    if (column) {
      column.parentElement?.removeAttribute("aria-hidden");
      for (const gutter of editor.dom.querySelectorAll(".cm-gutter:not(.cm-line-changes)")) gutter.setAttribute("aria-hidden", "true");
    }
  }, [baseline, active]);
  useEffect(() => { view.current?.dispatch({ effects: wrapping.current.reconfigure(appearance.wrapCode ? EditorView.lineWrapping : []) }); }, [appearance.wrapCode]);
  useEffect(() => {
    let disposed = false;
    const measure = () => { if (!disposed) view.current?.requestMeasure(); };
    measure();
    document.fonts?.load(`${appearance.editorFontSize}pt ${monoFonts[appearance.editorFont].family}`).then(measure).catch(measure);
    return () => { disposed = true; };
  }, [appearance.editorFont, appearance.editorFontSize, appearance.scale]);
  useEffect(() => { if (active && focused) view.current?.focus(); }, [active, focused]);
  useEffect(() => {
    const editor = view.current;
    if (!editor || !active || !location || appliedLocation.current === location) return;
    appliedLocation.current = location;
    setLocationError("");
    const source = location.query ? EditorState.create({ doc: disk ?? "" }).doc : editor.state.doc;
    if (location.query && (disk == null || location.line > source.lines)) {
      setLocationError("Найденная версия файла недоступна. Повторите поиск."); return;
    }
    const line = source.line(Math.max(1, Math.min(location.line, source.lines)));
    const column = location.utf16 ? Math.max(0, location.column - 1) : [...line.text].slice(0, Math.max(0, location.column - 1)).join("").length;
    const from = Math.min(line.to, line.from + column);
    let anchor = from;
    if (location.query) {
      const original = source.toString(), current = editor.state.doc.toString();
      const to = from + location.query.length;
      if (!line.text.startsWith(location.text ?? "") || original.slice(from, to) !== location.query) {
        setLocationError("Файл на диске изменился после поиска. Повторите поиск."); return;
      }
      for (const change of diff(original, current, { scanLimit: 500 })) {
        if (change.toA <= from) anchor = from + change.toB - change.toA;
        else if (change.fromA < to && change.toA > from) {
          setLocationError("Найденное совпадение изменено или удалено в черновике."); return;
        } else if (change.fromA >= to) break;
      }
      if (current.slice(anchor, anchor + location.query.length) !== location.query) {
        setLocationError("Найденное совпадение изменено или удалено в черновике."); return;
      }
    }
    editor.dispatch({ selection: { anchor }, scrollIntoView: true, effects: highlightNavigation.of(Decoration.set([
      Decoration.line({ class: "cm-navigation-highlight", attributes: { "data-navigation-pulse": String(++navigationPulse.current % 2) } })
        .range(editor.state.doc.lineAt(anchor).from),
    ])) });
    editor.focus();
    const clear = () => { if (view.current === editor) editor.dispatch({ effects: highlightNavigation.of(Decoration.none) }); };
    const timer = setTimeout(clear, 2600);
    return () => { clearTimeout(timer); clear(); };
  }, [location, active]);

  return <><button className="ide-document-search-trigger" onClick={() => { if (view.current) openSearchPanel(view.current); }}>Поиск в документе</button>
    {languageError && <p role="status">{languageError}</p>}
    {locationError && <p role="alert">{locationError}</p>}
    <GitMenu label="Действия с кодом" className="code-editor" contextOnly disabled={!active || !addToChat}
      contextWhen={target => hasCodeSelection(view.current, target)}
      items={[{ label: "Добавить в чат", icon: "chat", shortcut: bindings.addToChat ? formatShortcut(bindings.addToChat) : undefined,
        run: () => { if (view.current) addSelectionToChat(view.current); } }]}>
      <div className="code-editor-host" ref={host} />
    </GitMenu>
    {preview && createPortal(<ChangePreviewPanel preview={preview} path={path} disabled={disabled} />, preview.dom)}
  </>;
}

function hunkLine(hunk: string) {
  const header = hunk.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
  if (!header) return null;
  let line = Math.max(1, Number(header[1]));
  for (const text of hunk.split("\n").slice(1)) { if (!text.startsWith(" ")) break; line++; }
  return line;
}

class StageMarker extends GutterMarker {
  constructor(private index: number, private include: () => void, private disabled: () => boolean) { super(); }
  toDOM() {
    const button = document.createElement("button");
    button.type = "button"; button.className = "git-hunk-button"; button.textContent = "+"; button.disabled = this.disabled();
    button.title = `Включить фрагмент ${this.index + 1} в коммит`; button.setAttribute("aria-label", button.title);
    button.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); this.include(); });
    return button;
  }
}

export function Comparison({ a, b, path = "", navigation = false, hunks, stageHunk, busy = false }: { a: string; b: string; path?: string; navigation?: boolean; hunks?: GitDiff; stageHunk?: (hunk: number) => void; busy?: boolean }) {
  const { appearance, theme: selectedTheme } = useAppearance();
  const highlighting = useMemo(() => editorThemeExtension(selectedTheme), [selectedTheme]);
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<MergeView | null>(null);
  const scroll = useRef(0);
  const staging = useRef({ stageHunk, busy });
  staging.current = { stageHunk, busy };
  const wrapping = useRef(new Compartment());
  const language = useRef(new Compartment());
  const colors = useRef(new Compartment());
  const modeA = fileType(path, a).id;
  const modeB = fileType(path, b).id;
  const [languageError, setLanguageError] = useState("");
  const [chunk, setChunk] = useState(-1);
  const [chunkCount, setChunkCount] = useState(0);
  useEffect(() => {
    const extensions = [editorLinks, editorSetup, documentSearch, theme, phrases, parseVisible, colors.current.of(highlighting), language.current.of([]), EditorState.readOnly.of(true), EditorView.editable.of(false), wrapping.current.of(appearance.wrapCode ? EditorView.lineWrapping : [])];
    const markers = hunks?.hunks.map((_, index) => new StageMarker(index, () => { if (!staging.current.busy) staging.current.stageHunk?.(index); }, () => staging.current.busy)) ?? [];
    const controls = hunks ? gutter({ class: "git-hunk-gutter", markers: editor => RangeSet.of(hunks.hunks.flatMap((hunk, index) => {
      const line = hunkLine(hunk);
      return line === null ? [] : [markers[index].range(editor.state.doc.line(Math.min(line, editor.state.doc.lines)).from)];
    }), true) }) : [];
    const merge = new MergeView({ parent: host.current!, a: { doc: a, extensions }, b: { doc: b, extensions: [extensions, controls] } });
    if (hunks) {
      // Поля CodeMirror скрыты от чтения с экрана, а кнопки подготовки должны быть доступны.
      merge.b.dom.querySelector(".git-hunk-gutter")?.parentElement?.removeAttribute("aria-hidden");
      for (const column of merge.b.dom.querySelectorAll(".cm-gutter:not(.git-hunk-gutter)")) column.setAttribute("aria-hidden", "true");
    }
    view.current = merge;
    setChunk(-1); setChunkCount(merge.chunks.length);
    let restored = false;
    const frame = requestAnimationFrame(() => { merge.dom.scrollTop = scroll.current; restored = true; });
    return () => { cancelAnimationFrame(frame); if (restored) scroll.current = merge.dom.scrollTop; view.current = null; merge.destroy(); };
  }, [a, b, hunks?.patch]);
  useEffect(() => {
    for (const editor of [view.current?.a, view.current?.b]) editor?.dispatch({ effects: colors.current.reconfigure(highlighting) });
  }, [highlighting, a, b, hunks?.patch]);
  useEffect(() => { for (const button of host.current?.querySelectorAll<HTMLButtonElement>(".git-hunk-button") ?? []) button.disabled = busy; }, [busy, a, b, hunks?.patch]);
  useEffect(() => {
    const merge = view.current!;
    let disposed = false;
    setLanguageError("");
    for (const editor of [merge.a, merge.b]) editor.dispatch({ effects: language.current.reconfigure([]) });
    Promise.all([loadFileLanguage(modeA), loadFileLanguage(modeB)]).then(([supportA, supportB]) => {
      if (disposed) return;
      merge.a.dispatch({ effects: language.current.reconfigure(supportA) });
      merge.b.dispatch({ effects: language.current.reconfigure(supportB) });
    }).catch(() => { if (!disposed) setLanguageError("Подсветка сравнения недоступна."); });
    return () => { disposed = true; };
  }, [a, b, path, modeA, modeB, hunks?.patch]);
  useEffect(() => {
    for (const editor of [view.current?.a, view.current?.b]) editor?.dispatch({ effects: wrapping.current.reconfigure(appearance.wrapCode ? EditorView.lineWrapping : []) });
  }, [appearance.wrapCode]);
  useEffect(() => {
    let disposed = false;
    const measure = () => { if (!disposed) { view.current?.a.requestMeasure(); view.current?.b.requestMeasure(); } };
    measure();
    document.fonts?.load(`${appearance.editorFontSize}pt ${monoFonts[appearance.editorFont].family}`).then(measure).catch(measure);
    return () => { disposed = true; };
  }, [appearance.editorFont, appearance.editorFontSize, appearance.scale]);
  function move(direction: number) {
    const merge = view.current;
    if (!merge?.chunks.length) return;
    const index = chunk < 0 ? direction > 0 ? 0 : merge.chunks.length - 1 : (chunk + direction + merge.chunks.length) % merge.chunks.length;
    setChunk(index);
    for (const [editor, position] of [[merge.a, merge.chunks[index].fromA], [merge.b, merge.chunks[index].fromB]] as const) {
      const anchor = Math.min(position, editor.state.doc.length);
      editor.dispatch({ selection: { anchor }, effects: EditorView.scrollIntoView(anchor, { y: "center" }) });
    }
  }
  return <>{languageError && <p role="status">{languageError}</p>}{navigation && <div className="git-comparison-navigation"><span>Рядом</span><span className="ide-toolbar-spacer" /><button aria-label="Предыдущее изменение" disabled={!chunkCount} onClick={() => move(-1)}>↑</button><span>{chunk < 0 ? 0 : chunk + 1} / {chunkCount}</span><button aria-label="Следующее изменение" disabled={!chunkCount} onClick={() => move(1)}>↓</button></div>}<div className="comparison" aria-label="Сравнение версий" ref={host} /></>;
}
