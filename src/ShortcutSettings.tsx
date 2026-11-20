import { useRef, useState } from "react";
import { Icon } from "./Ide";
import { defaultShortcuts, formatShortcut, shortcutCommands, shortcutConflicts, shortcutFromEvent, shortcutIds, shortcutProblem, useShortcuts, type ShortcutCommand } from "./shortcuts";
import "./shortcuts.css";

export default function ShortcutSettings() {
  const { bindings, error, assign, reset } = useShortcuts();
  const [query, setQuery] = useState("");
  const [recording, setRecording] = useState<ShortcutCommand | null>(null);
  const [problem, setProblem] = useState("");
  const [pending, setPending] = useState<{ id: ShortcutCommand; key: string } | null>(null);
  const lastShift = useRef(0);
  const conflicts = pending ? shortcutConflicts(bindings, pending.id, pending.key) : [];
  function change(id: ShortcutCommand, key: string | null) {
    setProblem("");
    if (key && shortcutConflicts(bindings, id, key).length) setPending({ id, key });
    else { assign(id, key); setRecording(null); setPending(null); }
  }
  function cancel() { setRecording(null); setPending(null); setProblem(""); lastShift.current = 0; }
  const normalize = (value: string) => value.toLowerCase().replace(/command|cmd|meta/g, "⌘").replace(/control|ctrl/g, "⌃").replace(/option|alt/g, "⌥").replace(/shift/g, "⇧").replace(/[+\s]/g, "");
  const rows = shortcutIds.filter(id => normalize(`${shortcutCommands[id].label} ${formatShortcut(bindings[id])} ${bindings[id] ?? ""}`).includes(normalize(query)));
  return <>
    <div className="settings-scroll shortcut-settings">
      <header className="appearance-heading"><h1>Горячие клавиши</h1><p>Сочетания JetBrains для macOS. Изменения действуют во всех проектах.</p></header>
      <div className="shortcut-toolbar"><label><Icon name="search" /><input aria-label="Найти команду или сочетание" placeholder="Найти команду или сочетание…" value={query} onChange={event => setQuery(event.target.value)}
        onKeyDown={event => {
          if (event.metaKey || event.ctrlKey || event.altKey) {
            const key = shortcutFromEvent(event.nativeEvent);
            if (key) { event.preventDefault(); event.stopPropagation(); setQuery(formatShortcut(key)); }
          }
        }} /></label><button onClick={() => { reset(); cancel(); }}>Сбросить все</button></div>
      {pending && <section className="shortcut-conflict" role="alert">
        <p><kbd>{formatShortcut(pending.key)}</kbd> уже назначено: {conflicts.map(id => `«${shortcutCommands[id].label}»`).join(", ")}. Прежнее назначение будет отключено.</p>
        <button onClick={() => { assign(pending.id, pending.key); cancel(); }}>Переназначить</button><button onClick={cancel}>Отмена</button>
      </section>}
      <div className="shortcut-list">
        {rows.map(id => <section className="shortcut-row" key={id} aria-label={shortcutCommands[id].label}>
          <div className="appearance-row-label">{shortcutCommands[id].label}<span>{shortcutCommands[id].scope === "editor" ? "В редакторе" : "Во всём приложении"}</span></div>
          <div className="shortcut-actions">
            {recording === id ? <div className="shortcut-recorder">
              <input autoFocus readOnly aria-label={`Новое сочетание: ${shortcutCommands[id].label}`} placeholder="Нажмите сочетание…" onKeyDown={event => {
                event.preventDefault(); event.stopPropagation();
                if (event.key === "Escape") { cancel(); return; }
                if (event.repeat || event.nativeEvent.isComposing) return;
                let key = shortcutFromEvent(event.nativeEvent);
                if (event.key === "Shift" && !event.metaKey && !event.ctrlKey && !event.altKey) {
                  if (lastShift.current && Date.now() - lastShift.current < 350) { key = "DoubleShift"; lastShift.current = 0; }
                  else { lastShift.current = Date.now(); return; }
                } else lastShift.current = 0;
                if (!key) return;
                const message = shortcutProblem(id, key);
                if (message) setProblem(message);
                else change(id, key);
              }} /><button onClick={cancel}>Отмена</button>
              {problem && <p role="alert" className="error">{problem}</p>}
            </div> : <>
              <button className="shortcut-binding" aria-label={`Изменить сочетание: ${shortcutCommands[id].label}`} onClick={() => { cancel(); setRecording(id); }}><kbd>{formatShortcut(bindings[id])}</kbd></button>
              <button className="ide-icon-button" aria-label={`Отключить сочетание: ${shortcutCommands[id].label}`} title="Отключить сочетание" disabled={!bindings[id]} onClick={() => change(id, null)}><Icon name="close" /></button>
              <button className="ide-icon-button" aria-label={`Вернуть по умолчанию: ${shortcutCommands[id].label}`} title={`По умолчанию: ${formatShortcut(defaultShortcuts[id])}`} disabled={bindings[id] === defaultShortcuts[id]} onClick={() => change(id, defaultShortcuts[id])}><Icon name="refresh" /></button>
            </>}
          </div>
        </section>)}
        {!rows.length && <p className="muted">Команды не найдены.</p>}
      </div>
    </div>
    <footer className="appearance-footer">{error ? <p role="alert" className="error"><Icon name="info" />{error}</p> : <p role="status"><Icon name="check" />Изменения применяются сразу</p>}</footer>
  </>;
}
