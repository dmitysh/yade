import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Icon } from "./Ide";
import SettingsSelect from "./SettingsSelect";
import type { Session, Workspace } from "./types";

export interface Availability {
  executor: string; path: string | null; version: string | null;
  state: string; reason: string; action: string;
}
export interface Settings {
  model: string | null; approvalPolicy: string | null; sandbox: string | null; permissionMode: string | null;
  workMode: string | null; reasoningEffort: string | null; fastMode: boolean | null;
}
interface Choice { value: string; label: string }
export interface ModelChoice extends Choice { reasoningEfforts?: string[]; defaultReasoningEffort?: string | null; supportsFastMode?: boolean; supportsAutoMode?: boolean }
export interface Catalog {
  models: ModelChoice[]; workModes: Choice[]; approvalPolicies: Choice[]; sandboxes: Choice[]; permissionModes: Choice[]; warnings: string[];
  defaultModel?: string | null; defaultReasoningEffort?: string | null;
}
export const defaults: Settings = { model: null, approvalPolicy: null, sandbox: null, permissionMode: null, workMode: null, reasoningEffort: null, fastMode: null };
export function withExecutorDefaults(settings: Settings, catalog: Catalog): Settings {
  const model = settings.model ?? catalog.defaultModel ?? null;
  const choice = catalog.models.find(item => item.value === model);
  const effort = model === catalog.defaultModel ? catalog.defaultReasoningEffort ?? choice?.defaultReasoningEffort : choice?.defaultReasoningEffort;
  return { ...defaults, ...settings, model, reasoningEffort: settings.reasoningEffort ?? (effort && choice?.reasoningEfforts?.includes(effort) ? effort : null) };
}
export const effortNames: Record<string, string> = { none: "Без рассуждения", minimal: "Минимальные", low: "Низкие", medium: "Средние", high: "Высокие", xhigh: "Очень высокие", max: "Макс.", ultra: "Предельные" };
const names: Record<string, string> = { codex: "Codex", claude: "Claude Code" };

export default function ExecutorSettings({ workspace, session }: { workspace?: Workspace; session?: Session }) {
  const [availability, setAvailability] = useState<Availability[]>([]);
  const [executor, setExecutor] = useState(session?.executor ?? "codex");
  const [selectedSession, setSelectedSession] = useState(!!session);
  const [settings, setSettings] = useState(defaults);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [revision, setRevision] = useState(0);
  const target = workspace ? { workspaceId: workspace.id, sessionId: selectedSession ? session?.id ?? null : null, executor } : null;
  const available = availability.find(a => a.executor === executor);
  const active = selectedSession && session && !["ready", "completed", "failed", "error", "interrupted", "stopped"].includes(session.state);
  const model = catalog?.models.find(item => item.value === settings.model);
  const permissionModes = catalog?.permissionModes.filter(item => item.value !== "auto" || model?.supportsAutoMode) ?? [];

  useEffect(() => {
    let ignore = false;
    setAvailability([]);
    invoke<Availability[]>("executor_availability").then(value => { if (!ignore) setAvailability(value); })
      .catch(reason => { if (!ignore) setError(String(reason)); });
    return () => { ignore = true; };
  }, [revision]);

  useEffect(() => {
    let ignore = false;
    setCatalog(null); setSettings(defaults); setError(""); setSaved("");
    setBusy(false);
    if (!target || available?.state !== "ready") return;
    setBusy(true);
    Promise.all([
      invoke<Settings>("load_executor_settings", { target }),
      invoke<Catalog>("inspect_executor_settings", { target }),
    ]).then(([value, choices]) => {
      if (!ignore) { setSettings(withExecutorDefaults(value, choices)); setCatalog(choices); }
    }).catch(reason => { if (!ignore) setError(String(reason)); })
      .finally(() => { if (!ignore) setBusy(false); });
    return () => { ignore = true; };
  }, [workspace?.id, session?.id, executor, selectedSession, available, revision]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!target) return;
    setBusy(true); setError(""); setSaved("");
    try {
      await invoke("save_executor_settings", { target, settings });
      setSaved("Параметры проверены и сохранены для следующего запуска.");
    } catch (reason) { setError(`Параметры не применены и не сохранены: ${String(reason)}`); }
    finally { setBusy(false); }
  }

  function field(key: Exclude<keyof Settings, "fastMode" | "workMode">, label: string, choices: Choice[]) {
    return <SettingsSelect label={label} value={settings[key]} disabled={busy || !!active} choices={choices}
      allowDefault={key !== "model" && key !== "reasoningEffort"}
      placeholder={key === "model" ? "Выберите модель" : undefined}
      icon={key === "reasoningEffort" ? "effort" : undefined}
      change={value => { const next = { ...settings, [key]: value,
        ...(key === "model" ? { reasoningEffort: null, fastMode: null } : {}),
        ...(key === "model" && settings.permissionMode === "auto" && !catalog?.models.find(item => item.value === value)?.supportsAutoMode ? { permissionMode: null } : {}),
        ...(key === "permissionMode" ? { workMode: value === "plan" ? "plan" : "default" } : {}),
      }; setSettings(catalog ? withExecutorDefaults(next, catalog) : next); setSaved(""); }} />;
  }

  return <section className="executor-settings" aria-label="Настройки исполнителей">
    <div className="executor-settings-intro"><h2>Исполнители</h2><p>Параметры для следующих запусков</p>
      {session && <SettingsSelect label="Область настроек" disabled={busy} value={selectedSession ? "session" : "workspace"} allowDefault={false}
        choices={[{ value: "session", label: `Сессия «${session.title}»` }, { value: "workspace", label: "Пространство" }]}
        change={value => { setSelectedSession(value === "session"); if (value === "session") setExecutor(session.executor); }} />}
      <SettingsSelect label="Исполнитель" value={executor} disabled={busy || selectedSession} allowDefault={false}
        choices={[{ value: "codex", label: "Codex" }, { value: "claude", label: "Claude Code" }]} change={value => setExecutor(value!)} />
    </div>
    <details className="executor-settings-availability" open={available?.state !== "ready"}><summary><Icon name="terminal" /><span>Установленные исполнители</span><span>{available?.state === "ready" ? "Готов к работе" : "Проверить"}</span><Icon name="chevron" /></summary>
      {!availability.length && !error && <p role="status">Проверка установленных CLI…</p>}
      {availability.map(a => <div className="executor-settings-status" key={a.executor}>
        <strong>{names[a.executor]} <small>{a.version}</small></strong>
        {a.path && <p className="path">{a.path}</p>}
        <p>{a.reason}</p>{a.action && <p>{a.action}</p>}
      </div>)}
      <button type="button" disabled={busy} onClick={() => setRevision(r => r + 1)}><Icon name="refresh" />Повторить проверку CLI</button>
    </details>
    {!workspace && <p>Выберите рабочее пространство для настройки параметров.</p>}
    {active && <p>Для изменения параметров сначала остановите выбранную сессию.</p>}
    {busy && <p role="status">Проверка параметров…</p>}
    {error && <p role="alert" className="error">{error}</p>}
    {catalog && <form onSubmit={save}>
      <div className="conversation-settings-body">
        {catalog.warnings.map((warning, i) => <p role="note" key={i}>{warning}</p>)}
        {field("model", "Модель", catalog.models)}
        {!!catalog.workModes.length && <fieldset className="conversation-settings-modes" disabled={busy || !!active}><legend>Режим работы</legend><div>
          {[{ value: null, label: "По умолчанию" }, ...catalog.workModes].map(({ value, label }) => <button type="button" key={value ?? "inherited"}
            aria-pressed={settings.workMode === value} onClick={() => { setSettings({ ...settings, workMode: value,
              ...(value === "default" && settings.permissionMode === "plan" ? { permissionMode: null } : {}),
            }); setSaved(""); }}>{label}</button>)}
        </div></fieldset>}
        {!!model?.reasoningEfforts?.length && field("reasoningEffort", "Усилия рассуждения", model.reasoningEfforts.map(value => ({ value, label: effortNames[value] ?? value })))}
      </div>
      {model?.supportsFastMode && <div className="conversation-settings-fast"><Icon name="bolt" /><div><strong>Быстрый режим</strong>
        <p>{settings.fastMode === null ? "По настройкам исполнителя" : "Снижает задержку ответа"}</p>
        {settings.fastMode !== null && <button type="button" className="executor-settings-reset" disabled={busy || !!active}
          onClick={() => { setSettings({ ...settings, fastMode: null }); setSaved(""); }}>По умолчанию</button>}
      </div><button type="button" role="switch" aria-label="Быстрый режим" aria-checked={settings.fastMode === true} disabled={busy || !!active}
        onClick={() => { setSettings({ ...settings, fastMode: settings.fastMode !== true }); setSaved(""); }}><span /></button></div>}
      {!!(catalog.approvalPolicies.length || catalog.sandboxes.length || permissionModes.length) && <div className="conversation-settings-sections"><details open><summary><Icon name="shield" /><span>Доступы</span><span>Для {names[executor]}</span><Icon name="chevron" /></summary>
        {!!catalog.approvalPolicies.length && field("approvalPolicy", "Запросы разрешений", catalog.approvalPolicies)}
        {!!catalog.sandboxes.length && field("sandbox", "Доступ к файлам", catalog.sandboxes)}
        {!!permissionModes.length && field("permissionMode", "Режим разрешений", permissionModes)}
      </details></div>}
      <div className="executor-settings-actions"><p><Icon name="info" />{selectedSession ? `Для сессии «${session?.title}»` : `Для пространства «${workspace?.name}»`}</p>
        <button type="submit" disabled={busy || !!active}>Проверить и сохранить параметры</button>
      </div>
    </form>}
    {saved && <p role="status">{saved}</p>}
  </section>;
}
