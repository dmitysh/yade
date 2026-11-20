import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";

export const shortcutCommands = {
  projects: { label: "Найти проект или пространство", scope: "global", key: "Meta+KeyK" },
  findFile: { label: "Найти файл", scope: "global", key: "Meta+Shift+KeyO" },
  findText: { label: "Найти текст в пространстве", scope: "global", key: "Meta+Shift+KeyF" },
  searchEverywhere: { label: "Поиск везде", scope: "global", key: "DoubleShift" },
  newTab: { label: "Новая вкладка", scope: "global", key: "Meta+KeyT" },
  message: { label: "Перейти к сообщению", scope: "global", key: "Meta+Shift+Space" },
  terminal: { label: "Перейти в терминал", scope: "global", key: "Alt+F12" },
  nextTab: { label: "Следующая вкладка по истории", scope: "global", key: "Ctrl+Tab" },
  previousTab: { label: "Предыдущая вкладка по истории", scope: "global", key: "Ctrl+Shift+Tab" },
  closeTab: { label: "Закрыть текущую вкладку", scope: "global", key: "Meta+KeyW" },
  files: { label: "Показать или скрыть файлы", scope: "global", key: "Meta+Digit1" },
  git: { label: "Показать или скрыть Git", scope: "global", key: "Meta+Digit9" },
  settings: { label: "Открыть настройки", scope: "global", key: "Meta+Comma" },
  save: { label: "Сохранить файл", scope: "editor", key: "Meta+KeyS" },
  findSymbol: { label: "Найти символ", scope: "editor", key: "Meta+Alt+KeyO" },
  structure: { label: "Структура файла", scope: "editor", key: "Meta+F12" },
  definition: { label: "К объявлению или использованиям", scope: "editor", key: "Meta+KeyB" },
  typeDefinition: { label: "К типу", scope: "editor", key: "Meta+Shift+KeyB" },
  implementation: { label: "К реализации", scope: "editor", key: "Meta+Alt+KeyB" },
  references: { label: "Использования символа", scope: "editor", key: "Alt+F7" },
  line: { label: "Перейти к строке", scope: "editor", key: "Meta+KeyL" },
  rename: { label: "Переименовать символ", scope: "editor", key: "Shift+F6" },
  signature: { label: "Параметры функции", scope: "editor", key: "Meta+KeyP" },
  back: { label: "Назад по коду", scope: "editor", key: "Meta+BracketLeft" },
  forward: { label: "Вперёд по коду", scope: "editor", key: "Meta+BracketRight" },
  addToChat: { label: "Добавить код в чат", scope: "editor", key: "Meta+Shift+KeyC" },
} as const;

export type ShortcutCommand = keyof typeof shortcutCommands;
export type ShortcutBindings = Record<ShortcutCommand, string | null>;
export const shortcutIds = Object.keys(shortcutCommands) as ShortcutCommand[];
export const defaultShortcuts = Object.fromEntries(shortcutIds.map(id => [id, shortcutCommands[id].key])) as ShortcutBindings;
export const shortcutsKey = "yade.shortcuts";

const keyNames: Record<string, string> = { Meta: "⌘", Ctrl: "⌃", Alt: "⌥", Shift: "⇧", Space: "Space", Tab: "Tab", Comma: ",", Period: ".", BracketLeft: "[", BracketRight: "]", Backquote: "`", Minus: "−", Equal: "=", Slash: "/", Backslash: "\\", Semicolon: ";", Quote: "'", Enter: "Enter", Backspace: "⌫", Delete: "⌦", ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓" };
export function formatShortcut(key: string | null) {
  if (!key) return "Не назначено";
  if (key === "DoubleShift") return "⇧ ⇧";
  return key.split("+").map(part => keyNames[part] ?? part.replace(/^(Key|Digit)/, "")).join("");
}

export function shortcutFromEvent(event: KeyboardEvent) {
  if (event.isComposing || ["Meta", "Control", "Alt", "Shift", "AltGraph"].includes(event.key)) return null;
  // В синтетических событиях code иногда отсутствует; настоящий ввод использует физическую клавишу.
  const code = event.code || (/^[a-z]$/i.test(event.key) ? `Key${event.key.toUpperCase()}` : /^\d$/.test(event.key) ? `Digit${event.key}` : event.key === "," ? "Comma" : event.key === " " ? "Space" : event.key);
  return [event.metaKey && "Meta", event.ctrlKey && "Ctrl", event.altKey && "Alt", event.shiftKey && "Shift", code].filter(Boolean).join("+");
}

export function shortcutMatcher() {
  let lastShift = 0;
  return (event: KeyboardEvent) => {
    if (event.isComposing) { lastShift = 0; return null; }
    if (event.key === "Shift" && !event.repeat && !event.metaKey && !event.ctrlKey && !event.altKey) {
      if (lastShift && Date.now() - lastShift < 350) { lastShift = 0; return "DoubleShift"; }
      lastShift = Date.now(); return null;
    }
    lastShift = 0;
    return shortcutFromEvent(event);
  };
}

const protectedKeys = new Set([
  "Meta+KeyA", "Meta+KeyC", "Meta+KeyX", "Meta+KeyV", "Meta+KeyZ", "Meta+Shift+KeyZ", "Meta+Alt+Shift+KeyV",
  "Meta+KeyQ", "Meta+KeyH", "Meta+KeyM", "Meta+Tab", "Meta+Shift+Tab", "Meta+Alt+KeyH", "Meta+Space", "Meta+Alt+Space", "Ctrl+Space", "Meta+Ctrl+Space", "Meta+Ctrl+KeyF", "Meta+Backquote", "Meta+Shift+Backquote",
  "Meta+KeyF", "Meta+KeyG", "Meta+Shift+KeyG", "Meta+KeyD", "Meta+Shift+KeyL", "Meta+Shift+KeyK", "Meta+Slash", "Alt+ArrowUp", "Alt+ArrowDown",
]);
export function shortcutProblem(id: ShortcutCommand, key: string) {
  if (key === "DoubleShift") return "";
  if (!/^(Meta\+)?(Ctrl\+)?(Alt\+)?(Shift\+)?(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-9]|2[0-4])|Space|Tab|Comma|Period|BracketLeft|BracketRight|Backquote|Minus|Equal|Slash|Backslash|Semicolon|Quote|Enter|Backspace|Delete|Arrow(Left|Right|Up|Down))$/.test(key)) return "Это сочетание не поддерживается.";
  if (protectedKeys.has(key)) return "Сочетание используется стандартной командой редактора или macOS.";
  if (!/(Meta|Ctrl|Alt)\+/.test(key) && !/F\d+$/.test(key)) return "Добавьте ⌘, ⌃ или ⌥, чтобы сочетание не мешало вводу текста.";
  if (shortcutCommands[id].scope === "global" && key.endsWith("+Enter")) return "Это сочетание оставлено вводу и отправке сообщения или коммиту.";
  if (shortcutCommands[id].scope === "global" && key.startsWith("Ctrl+") && !/^Ctrl\+(Shift\+)?(Tab|F\d+)$/.test(key)) return "Это сочетание оставлено терминалу.";
  return "";
}

export function shortcutConflicts(bindings: ShortcutBindings, id: ShortcutCommand, key: string | null) {
  return key ? shortcutIds.filter(other => other !== id && bindings[other] === key) : [];
}

function readShortcuts(): ShortcutBindings {
  try {
    const stored = JSON.parse(localStorage.getItem(shortcutsKey) ?? "{}");
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return { ...defaultShortcuts };
    const bindings = { ...defaultShortcuts };
    for (const id of shortcutIds) {
      const key = stored[id];
      if (key === null || (typeof key === "string" && !shortcutProblem(id, key))) bindings[id] = key;
    }
    const used = new Set<string>();
    for (const id of shortcutIds) {
      const key = bindings[id];
      if (key && used.has(key)) bindings[id] = null;
      else if (key) used.add(key);
    }
    return bindings;
  } catch { return { ...defaultShortcuts }; }
}

const ShortcutContext = createContext({ bindings: defaultShortcuts, error: "", assign: (_id: ShortcutCommand, _key: string | null) => {}, reset: () => {} });

export function ShortcutProvider({ children }: { children: ReactNode }) {
  const [bindings, setBindings] = useState(readShortcuts);
  const [error, setError] = useState("");
  useEffect(() => {
    try { localStorage.setItem(shortcutsKey, JSON.stringify(bindings)); setError(""); }
    catch { setError("Горячие клавиши не сохранены: локальное хранилище недоступно."); }
  }, [bindings]);
  function assign(id: ShortcutCommand, key: string | null) {
    if (key && shortcutProblem(id, key)) return;
    setBindings(current => {
      const next = { ...current, [id]: key };
      for (const other of shortcutConflicts(current, id, key)) next[other] = null;
      return next;
    });
  }
  return <ShortcutContext.Provider value={{ bindings, error, assign, reset: () => setBindings({ ...defaultShortcuts }) }}>{children}</ShortcutContext.Provider>;
}

export function useShortcuts() {
  const context = useContext(ShortcutContext);
  return { ...context, hint: (id: ShortcutCommand) => context.bindings[id] ? ` · ${formatShortcut(context.bindings[id])}` : "" };
}

export function useShortcutHandlers(handlers: Partial<Record<ShortcutCommand, (event: KeyboardEvent) => void>>, enabled = true) {
  const { bindings } = useShortcuts();
  const current = useRef({ handlers, bindings, enabled });
  current.current = { handlers, bindings, enabled };
  useEffect(() => {
    let match = shortcutMatcher();
    function keydown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing || !current.current.enabled || document.querySelector("dialog[open]")) { match = shortcutMatcher(); return; }
      const key = match(event);
      const id = (Object.keys(current.current.handlers) as ShortcutCommand[]).find(id => current.current.bindings[id] === key && key !== null
        && (shortcutCommands[id].scope === "global" || (event.target instanceof Element && !!event.target.closest(".code-editor"))));
      if (!id) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (!event.repeat) current.current.handlers[id]?.(event);
    }
    function resetShift() { match = shortcutMatcher(); }
    window.addEventListener("keydown", keydown, true);
    window.addEventListener("blur", resetShift);
    return () => { window.removeEventListener("keydown", keydown, true); window.removeEventListener("blur", resetShift); };
  }, []);
}
