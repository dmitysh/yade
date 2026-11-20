import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { TerminalCommand, TerminalPrompt, type TerminalLocation } from "./TerminalPrompt";
import type { ShellEditor } from "./terminalShell";

export default function TerminalInput({ workspaceId, id, cwd, home, branch, active, restore, submit, interrupt, searchHistory, report }: {
  workspaceId: string; id: string; active: boolean;
  restore: { command: string; request: number } | null;
  submit: (command: string) => Promise<void>; interrupt: (command: string) => void; report: (reason: unknown) => void;
  searchHistory: (draft: string) => Promise<boolean>;
} & TerminalLocation) {
  const input = useRef<HTMLTextAreaElement>(null);
  const highlight = useRef<HTMLPreElement>(null);
  const [text, setText] = useState("");
  const [suggestion, setSuggestion] = useState("");
  const [known, setKnown] = useState(false);
  const [busy, setBusy] = useState(false);
  const draft = useRef({ text: "", cursor: 0, end: 0, serial: 0 });
  const queue = useRef(Promise.resolve(true));
  const sequence = useRef(Date.now() * 1000);
  const latest = useRef({ request: 0, serial: 0, action: "change" });
  const mounted = useRef(true);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  function apply(value: ShellEditor) {
    if (!mounted.current || value.request !== latest.current.request || draft.current.serial !== latest.current.serial) return;
    const cursor = Array.from(value.command).slice(0, value.cursor).join("").length;
    if (value.command !== draft.current.text || (latest.current.action !== "change" && cursor !== draft.current.cursor)) {
      draft.current = { ...draft.current, text: value.command, cursor, end: cursor };
      setText(value.command);
      const serial = draft.current.serial;
      requestAnimationFrame(() => {
        if (draft.current.serial === serial) input.current?.setSelectionRange(cursor, cursor);
      });
    }
    setSuggestion(draft.current.cursor === draft.current.end ? value.suggestion : "");
    setKnown(value.commandKnown);
  }
  function sync(action = "change") {
    const value = { ...draft.current };
    const request = ++sequence.current;
    latest.current = { request, serial: value.serial, action };
    queue.current = queue.current.then(async () => {
      if (!mounted.current || draft.current.serial !== value.serial) return false;
      const response = await invoke<ShellEditor>("edit_terminal", {
        workspaceId, id, command: value.text, cursor: Array.from(value.text.slice(0, value.cursor)).length, request, action,
      });
      apply(response);
      return true;
    }).catch(reason => { if (mounted.current) report(reason); return false; });
  }
  function change(value: string, cursor: number, end = cursor) {
    const changed = value !== draft.current.text;
    draft.current = { text: value, cursor, end, serial: draft.current.serial + 1 };
    setText(value);
    if (changed) setKnown(false);
    if (changed || cursor !== end) setSuggestion("");
    sync();
  }
  function clear() {
    draft.current = { text: "", cursor: 0, end: 0, serial: draft.current.serial + 1 };
    setText(""); setSuggestion(""); setKnown(false);
  }
  useEffect(() => {
    if (active) { input.current?.focus(); sync(); }
  }, [active]);
  useEffect(() => {
    if (!restore) return;
    change(restore.command, restore.command.length);
    input.current?.focus();
    input.current?.setSelectionRange(restore.command.length, restore.command.length);
  }, [restore]);
  useEffect(() => {
    if (input.current) { input.current.style.height = "0"; input.current.style.height = Math.min(200, Math.max(28, input.current.scrollHeight)) + "px"; }
  }, [text]);
  async function run() {
    if (busy) return;
    setBusy(true);
    await queue.current;
    const command = draft.current.text;
    if (!command.trim()) { setBusy(false); return; }
    clear();
    const serial = draft.current.serial;
    try {
      await submit(command);
    } catch (reason) {
      if (draft.current.serial === serial) {
        draft.current = { text: command, cursor: command.length, end: command.length, serial: serial + 1 };
        setText(command);
      }
      report(reason);
    }
    finally { if (mounted.current) setBusy(false); }
  }
  function findHistory() {
    setBusy(true);
    queue.current = queue.current.then(async synced => {
      try {
        if (synced && mounted.current && await searchHistory(draft.current.text) && mounted.current) clear();
      } catch (reason) {
        if (mounted.current) report(reason);
      } finally { if (mounted.current) setBusy(false); }
      return synced;
    });
  }
  return <div className="terminal-command-input">
    <TerminalPrompt cwd={cwd} home={home} branch={branch} />
    <div className="terminal-input-editor">
      <pre ref={highlight} aria-hidden="true" className="terminal-input-highlight"><TerminalCommand command={text} known={known} /><span className="terminal-input-suggestion">{suggestion}</span>{text.endsWith("\n") && !suggestion ? "\u200b" : ""}</pre>
      <textarea ref={input} rows={1} value={text} aria-label="Команда терминала" autoCapitalize="off" autoCorrect="off" spellCheck={false}
        readOnly={busy} placeholder="Введите команду"
        onChange={event => change(event.target.value, event.target.selectionStart, event.target.selectionEnd)}
        onSelect={event => {
          const element = event.currentTarget;
          if (element.value === draft.current.text && (element.selectionStart !== draft.current.cursor || element.selectionEnd !== draft.current.end)) {
            change(element.value, element.selectionStart, element.selectionEnd);
          }
        }}
        onScroll={event => { if (highlight.current) highlight.current.scrollTop = event.currentTarget.scrollTop; }}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (busy) { if (event.key === "Tab") event.preventDefault(); return; }
          const element = event.currentTarget;
          const plain = !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey;
          if (event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && (event.code === "KeyR" || event.key.toLowerCase() === "r")) {
            event.preventDefault();
            if (active && !event.repeat) findHistory();
          } else if (event.ctrlKey && event.key.toLowerCase() === "c" && element.selectionStart === element.selectionEnd) {
            event.preventDefault();
            const command = draft.current.text;
            clear();
            void queue.current.then(() => { if (mounted.current) interrupt(command); });
          } else if (event.key === "Tab" && !event.ctrlKey && !event.metaKey && !event.altKey) { event.preventDefault(); sync("complete"); }
          else if ((event.key === "ArrowRight" || event.key === "End") && suggestion && plain && element.selectionStart === text.length) {
            event.preventDefault(); sync("accept");
          } else if (event.key === "ArrowUp" && plain && element.selectionStart === element.selectionEnd && !text.slice(0, element.selectionStart).includes("\n")) {
            event.preventDefault(); sync("previous");
          } else if (event.key === "ArrowDown" && plain && element.selectionStart === element.selectionEnd && !text.slice(element.selectionEnd).includes("\n")) {
            event.preventDefault(); sync("next");
          } else if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void run(); }
        }} />
    </div>
  </div>;
}
