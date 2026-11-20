import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Icon } from "./Ide";

export default function SettingsSelect({ label, value, choices, disabled = false, placeholder = "По настройкам исполнителя", allowDefault = true, icon, hideLabel = false, required = false, describedBy, title, search, menuHeader, onOpen, change }: {
  label: string; value: string | null; choices: { value: string; label: string; icon?: string; description?: ReactNode }[]; disabled?: boolean;
  placeholder?: string; allowDefault?: boolean; icon?: string; hideLabel?: boolean; required?: boolean; describedBy?: string; title?: string; search?: string;
  menuHeader?: ReactNode; onOpen?: () => void;
  change: (value: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const searchInput = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const options: typeof choices = [...(allowDefault ? [{ value: "", label: placeholder }] : []), ...choices];
  if (value && !choices.some(option => option.value === value)) options.push({ value, label: `${value} — недоступно` });
  const selected = options.find(option => option.value === (value ?? ""));
  const filtered = options.filter(option => option.label.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  function show() { if (!open) onOpen?.(); setOpen(true); }

  useEffect(() => {
    if (!open) return;
    setQuery("");
    (search ? searchInput.current : root.current?.querySelector<HTMLElement>('[aria-selected="true"]:not(:disabled)') ?? root.current?.querySelector<HTMLElement>('[role="option"]:not(:disabled)'))?.focus();
    function outside(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open, search]);

  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);

  return <div className="settings-select" ref={root} onBlur={event => {
    if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }} onKeyDown={event => {
    if (event.key === "Escape" && open) {
      event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus();
    }
  }}>
    <span className={`settings-select-label${hideLabel ? " ide-visually-hidden" : ""}`} id={`${id}-label`}>{label}</span>
    {required && <input className="ide-visually-hidden" tabIndex={-1} aria-hidden="true" required disabled={disabled} value={value ?? ""}
      onChange={() => {}} onInvalid={event => { event.preventDefault(); show(); }} />}
    <button type="button" ref={trigger} className="settings-select-trigger" role="combobox" aria-labelledby={`${id}-label`} aria-describedby={`${id}-value${describedBy ? ` ${describedBy}` : ""}`} aria-required={required || undefined} title={title}
      aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? `${id}-options` : undefined} disabled={disabled}
      onClick={() => { if (open) setOpen(false); else show(); }} onKeyDown={event => {
        if (["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); show(); }
      }}>
      {icon && <Icon name={icon} />}<span id={`${id}-value`}>{selected?.label ?? placeholder}</span><Icon name="chevron" />
    </button>
    {open && <div className="settings-select-options" onKeyDown={event => {
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      if (event.target === searchInput.current && ["Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)'));
      if (!items.length) return;
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      const index = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
        : current < 0 ? event.key === "ArrowDown" ? 0 : items.length - 1
        : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[index].focus();
    }}>
      {menuHeader}
      {search && <input className="settings-select-search" ref={searchInput} aria-label={search} placeholder={search} value={query}
        onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === "Enter") event.preventDefault(); }} />}
      <div id={`${id}-options`} role="listbox" aria-labelledby={`${id}-label`}>
      {filtered.map(option => <button type="button" role="option" key={option.value} aria-selected={option.value === (value ?? "")} tabIndex={-1}
        disabled={!!option.value && !choices.some(choice => choice.value === option.value)}
        onClick={() => { setOpen(false); trigger.current?.focus(); change(option.value || null); }}>
        <Icon name="check" />{option.icon && <Icon name={option.icon} />}<span>{option.label}{option.description && <> <small>{option.description}</small></>}</span>
      </button>)}
      </div>
      {!filtered.length && <p className="settings-select-empty" role="status">Ничего не найдено</p>}
    </div>}
  </div>;
}
