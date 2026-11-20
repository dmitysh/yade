import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Icon } from "./Ide";

const labels = { completion: "Завершение работы", input: "Запрос ответа" };
type Kind = keyof typeof labels;
type Settings = Record<Kind, boolean>;

export default function NotificationSettings() {
  const [settings, setSettings] = useState<Settings>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let ignore = false;
    invoke<Settings>("load_notification_settings").then(value => {
      if (!ignore) setSettings(value);
    }, reason => {
      if (!ignore) setError(String(reason));
    });
    return () => { ignore = true; };
  }, []);

  async function toggle(kind: Kind, enabled: boolean) {
    setPending(true);
    setError("");
    try {
      setSettings(await invoke<Settings>("set_notification_enabled", { kind, enabled }));
    } catch (reason) {
      setError(String(reason));
    } finally {
      setPending(false);
    }
  }

  return <>
    <div className="settings-scroll">
      <header className="appearance-heading"><h1>Уведомления</h1><p>Системные уведомления macOS для разговоров и встроенных терминалов</p></header>
      {settings && (Object.keys(labels) as Kind[]).map(kind => <div className="appearance-row" key={kind}>
        <label htmlFor={`notify-${kind}`}>{labels[kind]}</label>
        <div className="appearance-toggle"><span>{settings[kind] ? "Включено" : "Выключено"}</span>
          <button id={`notify-${kind}`} type="button" role="switch" aria-checked={settings[kind]} disabled={pending}
            onClick={() => void toggle(kind, !settings[kind])}><span /></button>
        </div>
      </div>)}
    </div>
    {error && <footer className="appearance-footer"><p role="alert" className="error"><Icon name="info" />{error}</p></footer>}
  </>;
}
