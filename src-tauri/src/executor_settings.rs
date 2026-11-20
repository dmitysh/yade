use crate::{
    executors,
    model::Workspace,
    store::{Result, Store},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Read, Write},
    path::Path,
    process::{Command, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Target {
    pub workspace_id: String,
    pub session_id: Option<String>,
    pub executor: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    pub model: Option<String>,
    pub approval_policy: Option<String>,
    pub sandbox: Option<String>,
    pub permission_mode: Option<String>,
    pub work_mode: Option<String>,
    pub reasoning_effort: Option<String>,
    pub fast_mode: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Choice {
    pub value: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    pub value: String,
    pub label: String,
    #[serde(default)]
    pub reasoning_efforts: Vec<String>,
    #[serde(default)]
    pub default_reasoning_effort: Option<String>,
    #[serde(default)]
    pub supports_fast_mode: bool,
    #[serde(default)]
    pub supports_auto_mode: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub models: Vec<Model>,
    #[serde(default)]
    pub default_model: Option<String>,
    #[serde(default)]
    pub default_reasoning_effort: Option<String>,
    pub work_modes: Vec<Choice>,
    pub approval_policies: Vec<Choice>,
    pub sandboxes: Vec<Choice>,
    pub permission_modes: Vec<Choice>,
    pub warnings: Vec<String>,
}

impl Target {
    pub fn validate(&self, store: &Store, writing: bool) -> Result<Workspace> {
        if !["codex", "claude"].contains(&self.executor.as_str()) {
            return Err("неизвестный исполнитель".into());
        }
        let workspace = store.workspace(&self.workspace_id)?;
        if workspace.archived || workspace.operation_state != "ready" {
            return Err("пространство недоступно".into());
        }
        if let Some(id) = &self.session_id {
            let session = store
                .snapshot()?
                .sessions
                .into_iter()
                .find(|s| {
                    &s.id == id
                        && s.workspace_id == self.workspace_id
                        && s.executor == self.executor
                })
                .ok_or("сессия принадлежит другому пространству или исполнителю")?;
            if writing && session.state == "needs_reconciliation" {
                return Err("проверьте прежний запуск и дождитесь завершения его процессов".into());
            }
            if writing
                && ![
                    "ready",
                    "completed",
                    "failed",
                    "error",
                    "interrupted",
                    "stopped",
                ]
                .contains(&session.state.as_str())
            {
                return Err("сначала остановите выбранную сессию".into());
            }
            if writing
                && store.runs(id)?.iter().any(|r| {
                    ![
                        "ready",
                        "completed",
                        "failed",
                        "error",
                        "interrupted",
                        "stopped",
                    ]
                    .contains(&r.state.as_str())
                })
            {
                return Err("сначала остановите выбранный запуск".into());
            }
        }
        crate::workspaces::folder_path(Path::new(&workspace.path))?;
        Ok(workspace)
    }

    fn key(&self) -> String {
        if let Some(id) = &self.session_id {
            format!("session-settings:{id}")
        } else {
            format!("executor-settings:{}:{}", self.workspace_id, self.executor)
        }
    }
}

pub fn load(store: &Store, target: &Target) -> Result<Settings> {
    target.validate(store, false)?;
    let mut value = store.setting(&target.key())?;
    if value.is_none() && target.session_id.is_some() {
        value = store.setting(
            &Target {
                session_id: None,
                ..target.clone()
            }
            .key(),
        )?;
    }
    value
        .map(serde_json::from_value)
        .transpose()
        .map_err(|e| e.to_string())
        .map(|s| s.unwrap_or_default())
}

pub fn save(store: &Store, target: &Target, settings: &Settings) -> Result<()> {
    target.validate(store, true)?;
    validate_settings(&target.executor, settings)?;
    store.save_setting(
        &target.key(),
        &serde_json::to_value(settings).map_err(|e| e.to_string())?,
    )
}

fn validate_settings(executor: &str, settings: &Settings) -> Result<()> {
    if settings
        .work_mode
        .as_deref()
        .is_some_and(|s| !["default", "plan"].contains(&s))
    {
        return Err("неподдерживаемый режим работы".into());
    }
    if settings.reasoning_effort.as_deref().is_some_and(|s| {
        ![
            "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
        ]
        .contains(&s)
    }) {
        return Err("неподдерживаемые усилия рассуждения".into());
    }
    if settings.model.as_ref().is_some_and(|s| s.trim().is_empty()) {
        return Err("укажите модель или выберите штатную настройку".into());
    }
    if executor == "codex" {
        if settings.permission_mode.is_some() {
            return Err("режим Claude Code нельзя передать Codex".into());
        }
        if settings
            .approval_policy
            .as_deref()
            .is_some_and(|s| !["untrusted", "on-request", "never", "on-failure"].contains(&s))
        {
            return Err("неподдерживаемая политика разрешений Codex".into());
        }
        if settings
            .sandbox
            .as_deref()
            .is_some_and(|s| !["read-only", "workspace-write", "danger-full-access"].contains(&s))
        {
            return Err("неподдерживаемый режим песочницы".into());
        }
    } else {
        if settings.approval_policy.is_some() || settings.sandbox.is_some() {
            return Err("настройки Codex нельзя передать Claude Code".into());
        }
        if settings.permission_mode.as_deref().is_some_and(|s| {
            ![
                "default",
                "acceptEdits",
                "plan",
                "dontAsk",
                "bypassPermissions",
                "auto",
            ]
            .contains(&s)
        }) {
            return Err("неподдерживаемый режим разрешений Claude Code".into());
        }
    }
    Ok(())
}

pub fn codex_params(cwd: &Path, settings: &Settings) -> Value {
    let mut params = json!({"cwd": cwd});
    if let Some(model) = &settings.model {
        params["model"] = json!(model);
    }
    if let Some(policy) = &settings.approval_policy {
        params["approvalPolicy"] = json!(policy);
    }
    if let Some(sandbox) = &settings.sandbox {
        params["sandbox"] = json!(sandbox);
    }
    if let Some(effort) = &settings.reasoning_effort {
        params["config"] = json!({"model_reasoning_effort": effort});
    }
    if let Some(fast) = settings.fast_mode {
        params["serviceTier"] = json!(if fast { "priority" } else { "default" });
    }
    params
}

pub fn codex_turn_params(settings: &Settings, accepted: &Value) -> Result<Value> {
    let mut params = json!({});
    if let Some(mode) = &settings.work_mode {
        let model = accepted["model"]
            .as_str()
            .ok_or("Codex не вернул выбранную модель")?;
        params["collaborationMode"] = json!({"mode":mode,"settings":{
            "model":model,
            "reasoning_effort":settings.reasoning_effort.as_ref().map_or_else(|| accepted["reasoningEffort"].clone(), |effort| json!(effort)),
            "developer_instructions":null,
        }});
    }
    Ok(params)
}

pub fn inspect(target: &Target, workspace: &Workspace, settings: &Settings) -> Result<Catalog> {
    validate_settings(&target.executor, settings)?;
    let cwd = Path::new(&workspace.path);
    let available = executors::discover(&target.executor, cwd);
    if available.state != "ready" {
        return Err(format!("{} {}", available.reason, available.action));
    }
    let path = available.path.ok_or("CLI отсутствует")?;
    if target.executor == "codex" {
        inspect_codex(&path, cwd, settings)
    } else {
        inspect_claude(&path, settings)
    }
}

fn choices(values: &[(&str, &str)]) -> Vec<Choice> {
    values
        .iter()
        .map(|(value, label)| Choice {
            value: (*value).into(),
            label: (*label).into(),
        })
        .collect()
}

struct CodexProbe {
    child: executors::ProbeChild,
    output: mpsc::Receiver<Result<Value>>,
    next_id: u32,
}

impl CodexProbe {
    fn open(path: &Path, cwd: &Path) -> Result<Self> {
        let mut child = executors::ProbeChild::spawn(
            Command::new(path)
                .arg("app-server")
                .current_dir(cwd)
                .env_clear()
                .envs(executors::environment("codex"))
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null()),
        )?;
        let stdout = child.0.stdout.take().ok_or("вывод Codex недоступен")?;
        let (sender, output) = mpsc::sync_channel(16);
        thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut bytes = Vec::new();
                let packet = match (&mut reader).take(262145).read_until(b'\n', &mut bytes) {
                    Ok(0) => return,
                    Ok(_) if bytes.len() > 262144 => Err("слишком большой пакет Codex".into()),
                    Ok(_) => serde_json::from_slice(&bytes)
                        .map_err(|_| "повреждённый ответ Codex".into()),
                    Err(e) => Err(e.to_string()),
                };
                let failed = packet.is_err();
                if sender.send(packet).is_err() || failed {
                    return;
                }
            }
        });
        let mut probe = Self {
            child,
            output,
            next_id: 0,
        };
        probe.request(
            "initialize",
            json!({"clientInfo":{"name":"yade","version":env!("CARGO_PKG_VERSION")},"capabilities":{"experimentalApi":true}}),
        )?;
        probe.send(json!({"method":"initialized"}))?;
        Ok(probe)
    }

    fn send(&mut self, value: Value) -> Result<()> {
        let input = self.child.0.stdin.as_mut().ok_or("ввод Codex недоступен")?;
        writeln!(input, "{value}")
            .and_then(|_| input.flush())
            .map_err(|e| e.to_string())
    }

    fn request(&mut self, method: &str, params: Value) -> Result<Value> {
        self.next_id += 1;
        let id = self.next_id;
        self.send(json!({"id":id,"method":method,"params":params}))?;
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            let packet = self
                .output
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .map_err(|e| format!("Codex не ответил на {method}: {e}"))??;
            if packet.get("method").is_none() && packet["id"] == id {
                if let Some(error) = packet.get("error") {
                    return Err(format!(
                        "Codex отклонил {method}: {}",
                        error["message"].as_str().unwrap_or("ошибка протокола")
                    ));
                }
                return packet
                    .get("result")
                    .cloned()
                    .ok_or("в ответе Codex отсутствует результат".into());
            }
            if packet.get("method").is_some() && packet.get("id").is_some() {
                self.send(json!({"id":packet["id"],"error":{"code":-32601,"message":"проверка настроек не выполняет действия"}}))?;
            }
        }
    }
}

fn codex_supports_fast_mode(model: &Value) -> bool {
    model["serviceTiers"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|tier| tier["id"] == "priority")
        || model["additionalSpeedTiers"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|tier| tier == "fast")
}

fn inspect_codex(path: &Path, cwd: &Path, settings: &Settings) -> Result<Catalog> {
    let mut probe = CodexProbe::open(path, cwd)?;
    if probe.request("account/read", json!({"refreshToken":false}))?["account"]["type"] != "chatgpt"
    {
        return Err("Codex требует штатного входа через ChatGPT".into());
    }
    let config = probe.request("config/read", json!({"cwd":cwd,"includeLayers":true}))?;
    if config["config"]["model_provider"]
        .as_str()
        .is_some_and(|p| p != "openai")
    {
        return Err("в штатной конфигурации Codex выбран другой поставщик; выберите подписочный профиль OpenAI в CLI".into());
    }
    let mut catalog = Catalog {
        approval_policies: choices(&[
            ("untrusted", "Спрашивать для недоверенных команд"),
            ("on-request", "По запросу исполнителя"),
            ("never", "Не запрашивать"),
            ("on-failure", "При ошибке"),
        ]),
        sandboxes: choices(&[
            ("read-only", "Только чтение"),
            ("workspace-write", "Запись в пространстве"),
            ("danger-full-access", "Полный доступ"),
        ]),
        ..Catalog::default()
    };
    if let Some(layers) = config["layers"].as_array() {
        for layer in layers {
            if let Some(reason) = layer["disabledReason"].as_str() {
                catalog.warnings.push(reason.into());
            }
        }
    }
    let mut cursor = Value::Null;
    loop {
        let models = probe.request("model/list", json!({"cursor":cursor,"limit":100}))?;
        for model in models["data"]
            .as_array()
            .ok_or("Codex не вернул каталог моделей")?
        {
            if model["hidden"] == true {
                continue;
            }
            catalog.models.push(Model {
                value: model["model"]
                    .as_str()
                    .ok_or("модель без идентификатора")?
                    .into(),
                label: model["displayName"]
                    .as_str()
                    .ok_or("модель без названия")?
                    .into(),
                reasoning_efforts: model["supportedReasoningEfforts"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|effort| effort["reasoningEffort"].as_str().map(String::from))
                    .collect(),
                default_reasoning_effort: model["defaultReasoningEffort"]
                    .as_str()
                    .map(String::from),
                supports_fast_mode: codex_supports_fast_mode(model),
                supports_auto_mode: false,
            });
        }
        let next = models["nextCursor"].clone();
        if next.is_null() {
            break;
        }
        if next == cursor || catalog.models.len() > 1000 {
            return Err("некорректная пагинация моделей Codex".into());
        }
        cursor = next;
    }
    match probe.request("configRequirements/read", json!({})) {
        Ok(response) => {
            let requirements = &response["requirements"];
            for (field, values) in [
                ("allowedApprovalPolicies", &mut catalog.approval_policies),
                ("allowedSandboxModes", &mut catalog.sandboxes),
            ] {
                if let Some(allowed) = requirements[field].as_array() {
                    values.retain(|choice| allowed.iter().any(|value| value == &choice.value));
                }
            }
            if requirements["featureRequirements"]["fast_mode"] == false {
                for model in &mut catalog.models {
                    model.supports_fast_mode = false;
                }
            }
        }
        Err(reason) => {
            catalog.approval_policies.clear();
            catalog.sandboxes.clear();
            catalog.warnings.push(reason);
        }
    }
    match probe.request("collaborationMode/list", json!({})) {
        Ok(response) => {
            let modes = response["data"]
                .as_array()
                .ok_or("Codex не вернул режимы работы")?;
            catalog.work_modes = choices(&[("default", "Выполнение"), ("plan", "План")]);
            catalog
                .work_modes
                .retain(|choice| modes.iter().any(|mode| mode["mode"] == choice.value));
        }
        Err(reason) => catalog.warnings.push(reason),
    }
    for (value, choices) in [
        (&settings.approval_policy, &catalog.approval_policies),
        (&settings.sandbox, &catalog.sandboxes),
        (&settings.work_mode, &catalog.work_modes),
    ] {
        if value
            .as_ref()
            .is_some_and(|value| !choices.iter().any(|choice| &choice.value == value))
        {
            return Err("выбранный режим недоступен в текущей конфигурации Codex".into());
        }
    }
    if settings
        .model
        .as_ref()
        .is_some_and(|m| !catalog.models.iter().any(|c| &c.value == m))
    {
        return Err("выбранная модель отсутствует в каталоге Codex; настройки не сохранены".into());
    }
    if settings.reasoning_effort.is_some() || settings.fast_mode == Some(true) {
        let model = settings
            .model
            .as_ref()
            .and_then(|id| catalog.models.iter().find(|m| &m.value == id))
            .ok_or("сначала выберите модель для настройки усилий и быстрого режима")?;
        if settings
            .reasoning_effort
            .as_ref()
            .is_some_and(|effort| !model.reasoning_efforts.contains(effort))
        {
            return Err("выбранная модель не поддерживает эти усилия рассуждения".into());
        }
        if settings.fast_mode == Some(true) && !model.supports_fast_mode {
            return Err("выбранная модель не поддерживает быстрый режим".into());
        }
    }
    let mut params = codex_params(cwd, settings);
    params["ephemeral"] = json!(true);
    let accepted = probe.request("thread/start", params)?;
    catalog.default_model = accepted["model"].as_str().map(String::from);
    catalog.default_reasoning_effort = accepted["reasoningEffort"].as_str().map(String::from);
    if settings
        .reasoning_effort
        .as_ref()
        .is_some_and(|effort| accepted["reasoningEffort"].as_str() != Some(effort.as_str()))
    {
        return Err("Codex не применил усилия рассуждения; настройки не сохранены".into());
    }
    if let Some(fast) = settings.fast_mode {
        let expected = if fast { "priority" } else { "default" };
        if accepted["serviceTier"] != expected
            && !(expected == "default" && accepted["serviceTier"].is_null())
        {
            return Err("Codex не применил быстрый режим; настройки не сохранены".into());
        }
    }
    if settings
        .model
        .as_ref()
        .is_some_and(|m| accepted["model"].as_str() != Some(m.as_str()))
    {
        return Err("Codex не применил выбранную модель; настройки не сохранены".into());
    }
    if settings
        .approval_policy
        .as_ref()
        .is_some_and(|p| accepted["approvalPolicy"].as_str() != Some(p.as_str()))
    {
        return Err(
            "Codex не применил выбранную политику разрешений; настройки не сохранены".into(),
        );
    }
    if let Some(sandbox) = &settings.sandbox {
        let expected = match sandbox.as_str() {
            "read-only" => "readOnly",
            "workspace-write" => "workspaceWrite",
            _ => "dangerFullAccess",
        };
        if accepted["sandbox"]["type"] != expected {
            return Err(
                "Codex не применил выбранный режим песочницы; настройки не сохранены".into(),
            );
        }
    }
    Ok(catalog)
}

fn inspect_claude(path: &Path, settings: &Settings) -> Result<Catalog> {
    let (success, output) = executors::capture(
        executors::claude_command("claude-settings.mjs")?
            .arg(path)
            .arg(serde_json::to_string(settings).map_err(|e| e.to_string())?)
            .current_dir(std::env::temp_dir())
            .env_clear()
            .envs(executors::environment("claude")),
        Duration::from_secs(30),
        false,
    )?;
    if !success {
        let error: Value = serde_json::from_str(&output).unwrap_or_default();
        return Err(error["error"]
            .as_str()
            .unwrap_or("Claude Code не смог проверить настройки; проверьте CLI")
            .into());
    }
    serde_json::from_str(&output).map_err(|_| "повреждённый ответ проверки Claude Code".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Session;

    #[test]
    fn fast_mode_uses_native_service_tier_and_legacy_catalog_metadata() {
        for (model, expected) in [
            (json!({"serviceTiers":[{"id":"priority"}]}), true),
            (json!({"additionalSpeedTiers":["fast"]}), true),
            (json!({"serviceTiers":[{"id":"flex"}]}), false),
            (json!({"serviceTiers":[],"additionalSpeedTiers":[]}), false),
            (json!({}), false),
        ] {
            assert_eq!(codex_supports_fast_mode(&model), expected, "{model}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn native_inspection_keeps_configuration_and_surfaces_rejection() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("codex");
        std::fs::write(&path, r#"#!/bin/sh
while IFS= read -r request; do
  case "$request" in
    *'"method":"initialize"'*) echo '{"id":1,"result":{}}';;
    *'"method":"account/read"'*) echo '{"id":2,"result":{"account":{"type":"chatgpt"}}}';;
    *'"method":"config/read"'*) echo '{"id":3,"result":{"config":{"model_provider":"openai"},"layers":[{"disabledReason":"нет доверия проекту"}]}}';;
    *'"method":"model/list"'*) echo '{"id":4,"result":{"data":[{"model":"allowed","displayName":"Доступная модель","hidden":false,"defaultReasoningEffort":"high","supportedReasoningEfforts":[{"reasoningEffort":"high"}],"serviceTiers":[{"id":"priority"}]}],"nextCursor":null}}';;
    *'"method":"configRequirements/read"'*) echo '{"id":5,"result":{"requirements":{"allowedApprovalPolicies":["on-request","never"],"allowedSandboxModes":["read-only"]}}}';;
    *'"method":"collaborationMode/list"'*) echo '{"id":6,"result":{"data":[{"mode":"default"},{"mode":"plan"}]}}';;
    *'"method":"thread/start"'*)
      printf '%s' "$request" > received.json
      case "$request" in
        *'"approvalPolicy":"never"'*) echo '{"id":7,"error":{"message":"политика запрещена"}}';;
        *) echo '{"id":7,"result":{"model":"allowed","approvalPolicy":"on-request","sandbox":{"type":"readOnly"},"reasoningEffort":"high","serviceTier":"priority"}}';;
      esac;;
  esac
done
"#).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        let catalog = inspect_codex(&path, temp.path(), &Settings::default()).unwrap();
        assert_eq!(catalog.warnings, ["нет доверия проекту"]);
        assert_eq!(catalog.models[0].reasoning_efforts, ["high"]);
        assert_eq!(catalog.default_model.as_deref(), Some("allowed"));
        assert_eq!(catalog.default_reasoning_effort.as_deref(), Some("high"));
        assert_eq!(catalog.models[0].default_reasoning_effort.as_deref(), Some("high"));
        assert!(catalog.models[0].supports_fast_mode);
        assert_eq!(
            catalog
                .approval_policies
                .iter()
                .map(|c| c.value.as_str())
                .collect::<Vec<_>>(),
            ["on-request", "never"]
        );
        assert_eq!(
            catalog
                .sandboxes
                .iter()
                .map(|c| c.value.as_str())
                .collect::<Vec<_>>(),
            ["read-only"]
        );
        assert_eq!(
            catalog
                .work_modes
                .iter()
                .map(|c| c.value.as_str())
                .collect::<Vec<_>>(),
            ["default", "plan"]
        );
        let packet: Value = serde_json::from_str(
            &std::fs::read_to_string(temp.path().join("received.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(
            packet["params"],
            json!({"cwd":temp.path(),"ephemeral":true})
        );
        let rejected = Settings {
            approval_policy: Some("never".into()),
            ..Settings::default()
        };
        assert!(inspect_codex(&path, temp.path(), &rejected)
            .unwrap_err()
            .contains("политика запрещена"));
        let missing = Settings {
            model: Some("missing".into()),
            ..Settings::default()
        };
        assert!(inspect_codex(&path, temp.path(), &missing)
            .unwrap_err()
            .contains("отсутствует в каталоге"));
        let settings = Settings {
            model: Some("allowed".into()),
            reasoning_effort: Some("high".into()),
            fast_mode: Some(true),
            ..Settings::default()
        };
        inspect_codex(&path, temp.path(), &settings).unwrap();
        let packet: Value = serde_json::from_str(
            &std::fs::read_to_string(temp.path().join("received.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(packet["params"]["serviceTier"], "priority");
        assert!(inspect_codex(
            &path,
            temp.path(),
            &Settings {
                reasoning_effort: Some("max".into()),
                ..settings.clone()
            }
        )
        .unwrap_err()
        .contains("не поддерживает"));
        assert!(inspect_codex(
            &path,
            temp.path(),
            &Settings {
                sandbox: Some("danger-full-access".into()),
                ..Settings::default()
            }
        )
        .unwrap_err()
        .contains("недоступен"));

        let script = std::fs::read_to_string(&path)
            .unwrap()
            .replace(
                "\"allowedSandboxModes\":[\"read-only\"]",
                "\"allowedSandboxModes\":[],\"featureRequirements\":{\"fast_mode\":false}",
            )
            .replace(
                "{\"mode\":\"default\"},{\"mode\":\"plan\"}",
                "{\"mode\":\"default\"}",
            );
        std::fs::write(&path, script).unwrap();
        let catalog = inspect_codex(&path, temp.path(), &Settings::default()).unwrap();
        assert!(catalog.sandboxes.is_empty());
        assert!(!catalog.models[0].supports_fast_mode);
        assert_eq!(catalog.work_modes.len(), 1);
        assert!(inspect_codex(&path, temp.path(), &settings)
            .unwrap_err()
            .contains("не поддерживает быстрый режим"));
        assert!(inspect_codex(
            &path,
            temp.path(),
            &Settings {
                work_mode: Some("plan".into()),
                ..Settings::default()
            }
        )
        .unwrap_err()
        .contains("недоступен"));
    }

    #[test]
    fn native_parameters_preserve_defaults_and_do_not_mix_executors() {
        let cwd = Path::new("/workspace");
        assert_eq!(
            codex_params(cwd, &Settings::default()),
            json!({"cwd":"/workspace"})
        );
        let settings = Settings {
            model: Some("chosen".into()),
            approval_policy: Some("on-request".into()),
            sandbox: Some("read-only".into()),
            ..Settings::default()
        };
        assert_eq!(
            codex_params(cwd, &settings),
            json!({"cwd":"/workspace","model":"chosen","approvalPolicy":"on-request","sandbox":"read-only"})
        );
        assert!(validate_settings("claude", &settings).is_err());
        assert!(validate_settings(
            "codex",
            &Settings {
                permission_mode: Some("plan".into()),
                ..Settings::default()
            }
        )
        .is_err());
        assert!(validate_settings(
            "codex",
            &Settings {
                approval_policy: Some("unsupported".into()),
                ..Settings::default()
            }
        )
        .is_err());
    }

    #[test]
    fn conversation_parameters_reach_native_thread_and_turn_without_changing_old_defaults() {
        let legacy: Settings = serde_json::from_value(
            json!({"model":null,"approvalPolicy":null,"sandbox":null,"permissionMode":null}),
        )
        .unwrap();
        assert_eq!(legacy, Settings::default());
        assert_eq!(codex_turn_params(&legacy, &json!({})).unwrap(), json!({}));
        let settings = Settings {
            work_mode: Some("plan".into()),
            reasoning_effort: Some("high".into()),
            fast_mode: Some(true),
            ..Settings::default()
        };
        assert_eq!(
            codex_params(Path::new("/workspace"), &settings),
            json!({"cwd":"/workspace","config":{"model_reasoning_effort":"high"},"serviceTier":"priority"})
        );
        assert_eq!(
            codex_turn_params(&settings, &json!({"model":"chosen"})).unwrap(),
            json!({"collaborationMode":{"mode":"plan","settings":{"model":"chosen","reasoning_effort":"high","developer_instructions":null}}})
        );
        assert!(codex_turn_params(&settings, &json!({})).is_err());
        assert_eq!(
            codex_params(
                Path::new("/workspace"),
                &Settings {
                    fast_mode: Some(false),
                    ..Settings::default()
                }
            )["serviceTier"],
            "default"
        );
        assert!(validate_settings(
            "codex",
            &Settings {
                work_mode: Some("unknown".into()),
                ..Settings::default()
            }
        )
        .is_err());
        assert!(validate_settings(
            "claude",
            &Settings {
                reasoning_effort: Some("unknown".into()),
                ..Settings::default()
            }
        )
        .is_err());
    }

    #[test]
    fn settings_are_persisted_for_the_selected_workspace_executor_and_session() {
        let temp = tempfile::tempdir().unwrap();
        let database = temp.path().join("state.sqlite3");
        let mut store = Store::open(&database).unwrap();
        store.register_folder("Первый", temp.path(), None).unwrap();
        let second_path = temp.path().join("second");
        std::fs::create_dir(&second_path).unwrap();
        store.register_folder("Второй", &second_path, None).unwrap();
        let snapshot = store.snapshot().unwrap();
        let first = &snapshot.workspaces[0].id;
        let second = &snapshot.workspaces[1].id;
        for (id, executor, workspace) in [
            ("a", "codex", first),
            ("b", "claude", first),
            ("c", "codex", second),
        ] {
            store
                .insert_session(&Session {
                    id: id.into(),
                    executor: executor.into(),
                    workspace_id: workspace.clone(),
                    title: id.into(),
                    external_id: None,
                    state: "ready".into(),
                    last_activity_at: 0,
                })
                .unwrap();
        }
        let target = Target {
            workspace_id: first.clone(),
            session_id: Some("a".into()),
            executor: "codex".into(),
        };
        let chosen = Settings {
            model: Some("chosen".into()),
            work_mode: Some("plan".into()),
            reasoning_effort: Some("high".into()),
            fast_mode: Some(true),
            ..Settings::default()
        };
        save(&store, &target, &chosen).unwrap();
        assert!(load(
            &store,
            &Target {
                session_id: Some("b".into()),
                ..target.clone()
            }
        )
        .is_err());
        assert!(load(
            &store,
            &Target {
                workspace_id: second.clone(),
                ..target.clone()
            }
        )
        .is_err());
        assert_eq!(
            load(
                &store,
                &Target {
                    session_id: None,
                    ..target.clone()
                }
            )
            .unwrap(),
            Settings::default()
        );
        let claude = Target {
            executor: "claude".into(),
            session_id: None,
            ..target.clone()
        };
        assert_eq!(load(&store, &claude).unwrap(), Settings::default());
        save(
            &store,
            &claude,
            &Settings {
                permission_mode: Some("plan".into()),
                ..Settings::default()
            },
        )
        .unwrap();
        assert_eq!(load(&store, &target).unwrap(), chosen);
        assert_eq!(
            load(
                &store,
                &Target {
                    session_id: Some("b".into()),
                    ..claude.clone()
                }
            )
            .unwrap()
            .permission_mode
            .as_deref(),
            Some("plan")
        );
        drop(store);
        let store = Store::open(&database).unwrap();
        assert_eq!(load(&store, &target).unwrap(), chosen);
        store
            .connection
            .execute("UPDATE sessions SET state='ready' WHERE id='a'", [])
            .unwrap();
        store
            .insert_run(&crate::model::Run {
                id: "running".into(),
                session_id: "a".into(),
                state: "running".into(),
            })
            .unwrap();
        assert!(save(&store, &target, &Settings::default()).is_err());
        assert_eq!(
            load(&store, &claude).unwrap().permission_mode.as_deref(),
            Some("plan")
        );
        store
            .connection
            .execute("UPDATE sessions SET state='running' WHERE id='a'", [])
            .unwrap();
        assert!(save(&store, &target, &Settings::default()).is_err());
        assert_eq!(load(&store, &target).unwrap(), chosen);
    }

    #[test]
    #[ignore = "инициализация установленного Codex без отправки сообщения"]
    fn local_codex_catalog_and_configuration() {
        let path = executors::executable("codex").unwrap();
        let cwd = std::env::current_dir().unwrap();
        let catalog = inspect_codex(&path, &cwd, &Settings::default()).unwrap();
        assert!(!catalog.models.is_empty());
        println!(
            "Codex: {} моделей, {} отключённых слоёв конфигурации",
            catalog.models.len(),
            catalog.warnings.len()
        );
        let settings = Settings {
            model: Some(catalog.models[0].value.clone()),
            approval_policy: Some("on-request".into()),
            sandbox: Some("read-only".into()),
            reasoning_effort: catalog.models[0].reasoning_efforts.first().cloned(),
            fast_mode: catalog.models[0].supports_fast_mode.then_some(true),
            ..Settings::default()
        };
        inspect_codex(&path, &cwd, &settings).unwrap();
        assert!(inspect_codex(
            &path,
            &cwd,
            &Settings {
                model: Some("unsupported-model".into()),
                ..Settings::default()
            }
        )
        .is_err());
    }
}
