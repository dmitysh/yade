use crate::{
    conversations,
    core::Core,
    model::StoredEvent,
    store::{Result, Store},
};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager, State};

const SETTINGS_KEY: &str = "notifications";

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Kind {
    Completion,
    Input,
}

#[derive(Deserialize, Serialize)]
#[serde(default)]
pub(crate) struct Settings {
    completion: bool,
    input: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            completion: true,
            input: true,
        }
    }
}

impl Settings {
    fn load(store: &Store) -> Result<Self> {
        store
            .setting(SETTINGS_KEY)?
            .map(serde_json::from_value)
            .transpose()
            .map(|settings| settings.unwrap_or_default())
            .map_err(|error| format!("не удалось прочитать настройки уведомлений: {error}"))
    }

    fn enabled(&self, kind: Kind) -> bool {
        match kind {
            Kind::Completion => self.completion,
            Kind::Input => self.input,
        }
    }

    fn save(store: &Store, kind: Kind, enabled: bool) -> Result<Self> {
        let mut settings = Self::load(store)?;
        match kind {
            Kind::Completion => settings.completion = enabled,
            Kind::Input => settings.input = enabled,
        }
        store.save_setting(SETTINGS_KEY, &serde_json::json!(settings))?;
        Ok(settings)
    }
}

#[tauri::command(async)]
pub(crate) fn load_notification_settings(core: State<'_, Arc<Mutex<Core>>>) -> Result<Settings> {
    Settings::load(&core.lock().map_err(|error| error.to_string())?.store)
}

#[tauri::command]
pub(crate) async fn set_notification_enabled(
    core: State<'_, Arc<Mutex<Core>>>,
    kind: Kind,
    enabled: bool,
) -> Result<Settings> {
    if enabled {
        #[cfg(target_os = "macos")]
        macos::authorize().await?;
        #[cfg(not(target_os = "macos"))]
        return Err("Системные уведомления доступны в приложении Yade для macOS".into());
    }
    Settings::save(
        &core.lock().map_err(|error| error.to_string())?.store,
        kind,
        enabled,
    )
}

fn run_notification(event: &StoredEvent) -> Option<Kind> {
    match event.kind.as_str() {
        "request" => Some(Kind::Input),
        "message_completed"
            if event.payload["questions"]
                .as_array()
                .is_some_and(|questions| !questions.is_empty()) =>
        {
            Some(Kind::Input)
        }
        "state" if event.payload["state"] == "completed" => Some(Kind::Completion),
        _ => None,
    }
}

pub(crate) fn publish_run_event(
    app: &tauri::AppHandle,
    executor: &str,
    event: &StoredEvent,
) -> Result<()> {
    app.emit("run-event", event)
        .map_err(|error| format!("событие {executor} не доставлено: {error}"))?;
    if let Some(kind) = run_notification(event) {
        let core = app.state::<Arc<Mutex<Core>>>();
        let title = core.lock().ok().and_then(|core| {
            Settings::load(&core.store)
                .ok()?
                .enabled(kind)
                .then_some(())?;
            conversations::session(&core.store, &event.context.session_id)
                .ok()
                .map(|session| session.title)
        });
        if let Some(title) = title {
            show(kind, executor, &title);
        }
    }
    Ok(())
}

pub(crate) fn terminal_notification(
    core: &Mutex<Core>,
    kind: Kind,
    executor: &str,
    workspace_id: &str,
) {
    let executor = if executor == "codex" {
        "Codex"
    } else {
        "Claude Code"
    };
    let workspace = core.lock().ok().and_then(|core| {
        Settings::load(&core.store)
            .ok()?
            .enabled(kind)
            .then_some(())?;
        core.store.workspace(workspace_id).ok()
    });
    if let Some(workspace) = workspace {
        show(kind, executor, &format!("Терминал · {}", workspace.name));
    }
}

fn show(kind: Kind, executor: &str, body: &str) {
    let action = match kind {
        Kind::Completion => "завершил работу",
        Kind::Input => "ожидает ответа",
    };
    let title = format!("{executor} {action}");
    #[cfg(target_os = "macos")]
    macos::show(&title, body);
    #[cfg(not(target_os = "macos"))]
    let _ = (title, body);
}

#[cfg(target_os = "macos")]
#[path = "notifications_macos.rs"]
mod macos;
#[cfg(target_os = "macos")]
pub(crate) fn prepare(store: &Store) {
    macos::prepare();
    if Settings::load(store).is_ok_and(|settings| settings.completion || settings.input) {
        tauri::async_runtime::spawn(async {
            let _ = macos::authorize().await;
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Context;
    use serde_json::json;

    #[test]
    fn settings_are_on_by_default_and_saved_independently() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("state.sqlite3");
        let store = Store::open(&path).unwrap();
        let settings = Settings::load(&store).unwrap();
        assert!(settings.enabled(Kind::Input));
        assert!(settings.enabled(Kind::Completion));
        Settings::save(&store, Kind::Input, false).unwrap();
        drop(store);
        let settings = Settings::load(&Store::open(&path).unwrap()).unwrap();
        assert!(settings.enabled(Kind::Completion));
        assert!(!settings.enabled(Kind::Input));
    }

    #[test]
    fn only_new_requests_and_successful_completions_notify() {
        let mut event = StoredEvent {
            context: Context {
                workspace_id: "workspace".into(),
                session_id: "session".into(),
                run_id: "run".into(),
            },
            sequence: 1,
            kind: "request".into(),
            payload: json!({"method":"item/tool/requestUserInput","params":{"isBlocking":false}}),
        };
        assert_eq!(run_notification(&event), Some(Kind::Input));
        event.kind = "request_resolved".into();
        assert_eq!(run_notification(&event), None);
        event.kind = "message_completed".into();
        assert_eq!(run_notification(&event), None);
        event.payload = json!({"questions":[{"title":"Выбор"}]});
        assert_eq!(run_notification(&event), Some(Kind::Input));
        event.kind = "state".into();
        for state in ["waiting", "failed", "error", "interrupted", "completed"] {
            event.payload = json!({"state":state});
            assert_eq!(
                run_notification(&event),
                (state == "completed").then_some(Kind::Completion)
            );
        }
    }
}
