import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { defaults, effortNames, withExecutorDefaults } from "./ExecutorSettings";
import type { Catalog, Settings } from "./ExecutorSettings";
import { Icon } from "./Ide";
import SettingsSelect from "./SettingsSelect";
import type { Session, Workspace } from "./types";

export default function ConversationSettings({ session, workspace, disabled, saving }: {
  session: Session; workspace: Workspace; disabled: boolean; saving: (busy: boolean) => void;
}) {
  const [settings, setSettings] = useState<Settings>(defaults);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [revision, setRevision] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const target = { workspaceId: workspace.id, sessionId: session.id, executor: session.executor };
  const model = catalog?.models.find(item => item.value === settings.model);
  const efforts = model?.reasoningEfforts ?? [];
  const permissionModes = catalog?.permissionModes.filter(item => item.value !== "auto" || model?.supportsAutoMode) ?? [];
  const locked = disabled || busy || loading || !catalog;

  useEffect(() => {
    let ignore = false;
    setCatalog(null); setSettings(defaults); setSaved(false); setError("");
    if (workspace.deleted || workspace.archived || workspace.operationState !== "ready") { setLoading(false); return; }
    setLoading(true);
    Promise.all([
      invoke<Settings>("load_executor_settings", { target }),
      invoke<Catalog>("inspect_executor_settings", { target }),
    ]).then(([value, choices]) => {
      if (!ignore) { setSettings(withExecutorDefaults(value, choices)); setCatalog(choices); }
    }).catch(reason => { if (!ignore) setError(`Параметры недоступны: ${String(reason)}`); })
      .finally(() => { if (!ignore) setLoading(false); });
    return () => { ignore = true; };
  }, [revision, workspace.id, session.id, session.executor, workspace.deleted, workspace.archived, workspace.operationState]);

  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector<HTMLButtonElement>("button")?.focus();
    function outside(event: MouseEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    function escape(event: KeyboardEvent) {
      if (event.key === "Escape") { event.preventDefault(); setOpen(false); trigger.current?.focus(); }
    }
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("mousedown", outside); document.removeEventListener("keydown", escape); };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const form = root.current?.closest("form");
    if (!form) return;
    const measure = () => {
      const heading = form.closest(".conversation")?.querySelector(".conversation-heading")?.getBoundingClientRect().bottom ?? 8;
      panel.current?.style.setProperty("--settings-space", `${Math.max(120, form.getBoundingClientRect().top - heading - 8)}px`);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(form);
    window.addEventListener("resize", measure);
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); };
  }, [open]);

  async function update(next: Settings) {
    if (locked) return;
    next = withExecutorDefaults(next, catalog!);
    const previous = settings;
    setSettings(next); setBusy(true); saving(true); setError(""); setSaved(false);
    try {
      await invoke("save_executor_settings", { target, settings: next });
      setSaved(true);
    } catch (reason) {
      setSettings(previous); setError(`Параметры не сохранены: ${String(reason)}`);
    } finally { setBusy(false); saving(false); }
  }

  function field(key: "model" | "approvalPolicy" | "sandbox" | "permissionMode", label: string, choices: { value: string; label: string }[]) {
    return <SettingsSelect label={label} value={settings[key]} disabled={locked} choices={choices}
      allowDefault={key !== "model"} placeholder={key === "model" ? "Выберите модель" : undefined}
      change={value => void update({ ...settings, [key]: value,
        ...(key === "model" ? { reasoningEffort: null, fastMode: null } : {}),
        ...(key === "model" && settings.permissionMode === "auto" && !catalog?.models.find(item => item.value === value)?.supportsAutoMode ? { permissionMode: null } : {}),
        ...(key === "permissionMode" ? { workMode: value === "plan" ? "plan" : "default" } : {}),
      })} />;
  }

  return <div className="conversation-settings" ref={root}>
    <div className="conversation-settings-toolbar">
      <button type="button" className="conversation-setting-chip" disabled={busy || disabled} onClick={() => setOpen(true)}>
        <Icon name="sparkles" />{model?.label ?? settings.model ?? "Модель исполнителя"}<Icon name="chevron" />
      </button>
      {model?.supportsFastMode && <button type="button" className="conversation-setting-chip conversation-fast-chip" aria-pressed={settings.fastMode === true} disabled={locked}
        onClick={() => void update({ ...settings, fastMode: settings.fastMode !== true })}>
        <Icon name="bolt" />Быстрый режим
      </button>}
      <button type="button" ref={trigger} className="conversation-settings-trigger" aria-label="Параметры диалога" title="Параметры диалога"
        aria-expanded={open} aria-controls={`conversation-settings-${session.id}`} onClick={() => setOpen(value => !value)} disabled={workspace.deleted || workspace.archived}>
        <Icon name="sliders" />
      </button>
    </div>
    {open && <section ref={panel} id={`conversation-settings-${session.id}`} className="conversation-settings-panel" role="dialog" aria-label="Параметры диалога" aria-busy={loading || busy}>
      <div className="conversation-settings-heading"><strong>Параметры диалога</strong>
        <button type="button" className="ide-icon-button" aria-label="Закрыть параметры диалога" onClick={() => { setOpen(false); trigger.current?.focus(); }}><Icon name="close" /></button>
        <p>Для следующих сообщений в этом чате</p>
      </div>
      <div className="conversation-settings-body">
        {loading && <p role="status">Загрузка параметров…</p>}
        {disabled && <p className="muted">Изменение параметров доступно после завершения выполнения в активном пространстве.</p>}
        {error && <p role="alert" className="error">{error}<button type="button" disabled={busy || loading} onClick={() => setRevision(value => value + 1)}>Повторить проверку</button></p>}
        {catalog?.warnings.map((warning, i) => <p role="note" key={i}>{warning}</p>)}
        {catalog && <>
          {field("model", "Модель", catalog.models)}
          {!!catalog.workModes.length && <fieldset className="conversation-settings-modes" disabled={locked}><legend>Режим работы</legend><div>
            {catalog.workModes.map(({ value, label }) => <button key={value} type="button"
              aria-pressed={(settings.workMode ?? (settings.permissionMode === "plan" ? "plan" : "default")) === value}
              onClick={() => void update({ ...settings, workMode: value, ...(value === "default" && settings.permissionMode === "plan" ? { permissionMode: null } : {}) })}>{label}</button>)}
          </div></fieldset>}
          {!!efforts.length && <div className="conversation-settings-efforts">
            <SettingsSelect label="Усилия рассуждения" value={settings.reasoningEffort} disabled={locked} icon="effort" allowDefault={false}
              choices={efforts.map(value => ({ value, label: effortNames[value] ?? value }))} change={value => void update({ ...settings, reasoningEffort: value })} />
          </div>}
        </>}
      </div>
      {model?.supportsFastMode && <div className="conversation-settings-fast"><Icon name="bolt" /><div><strong>Быстрый режим</strong><p>{settings.fastMode === null ? "По настройкам исполнителя" : "Снижает задержку ответа"}</p></div>
        <button type="button" role="switch" aria-label="Быстрый режим" aria-checked={settings.fastMode === true} disabled={locked}
          onClick={() => void update({ ...settings, fastMode: settings.fastMode !== true })}><span /></button>
      </div>}
      <div className="conversation-settings-sections">
        {catalog && !!(catalog.approvalPolicies.length || catalog.sandboxes.length || permissionModes.length) && <details><summary><Icon name="shield" /><span>Доступы</span><span>{(catalog.approvalPolicies.find(item => item.value === settings.approvalPolicy)?.label
          ?? permissionModes.find(item => item.value === settings.permissionMode)?.label) ?? "По умолчанию"}</span><Icon name="chevron" /></summary>
          {!!catalog.approvalPolicies.length && field("approvalPolicy", "Запросы разрешений", catalog.approvalPolicies)}
          {!!catalog.sandboxes.length && field("sandbox", "Доступ к файлам", catalog.sandboxes)}
          {!!permissionModes.length && field("permissionMode", "Режим разрешений", permissionModes)}
        </details>}
      </div>
      <footer role="status"><Icon name="info" />{busy ? "Проверка и сохранение…" : saved ? "Настройки сохранены для этого чата" : "Настройки сохраняются для этого чата"}</footer>
    </section>}
  </div>;
}
