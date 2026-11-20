use crate::{
    core::Core,
    editor, executors,
    store::{Result, Store},
    workspace_code_trust::WorkspaceCodeTrust,
};
use lsp_server::Message;
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{BufReader, Read},
    path::{Path, PathBuf},
    process::{ChildStdin, Command, Stdio},
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{ipc::Channel, Manager, State};
use url::Url;

#[derive(Default)]
pub struct Languages {
    servers: HashMap<String, Server>,
    closing: bool,
}

struct Server {
    workspace_id: String,
    language: String,
    root: PathBuf,
    _child: executors::ProbeChild,
    input: ChildStdin,
    readable: Arc<Mutex<HashSet<PathBuf>>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tool {
    language: String,
    available: bool,
    prerequisite: Option<String>,
}

fn tool_path(directory: &Path, language: &str) -> Result<Option<PathBuf>> {
    let (private, name) = match language {
        "go" => (directory.join("go/bin/gopls"), "gopls"),
        "typescript" => (
            directory.join("typescript/node_modules/.bin/typescript-language-server"),
            "typescript-language-server",
        ),
        _ => return Err("язык не поддерживается".into()),
    };
    Ok(private
        .is_file()
        .then_some(private)
        .or_else(|| executors::executable(name))
        .or_else(|| {
            if language != "go" {
                return None;
            }
            let path = PathBuf::from(std::env::var_os("HOME")?).join("go/bin/gopls");
            path.is_file().then_some(path)
        }))
}

fn tools_directory(app: &tauri::AppHandle) -> Result<PathBuf> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("languages"))
}

#[tauri::command(async)]
pub fn language_tools(app: tauri::AppHandle) -> Result<Vec<Tool>> {
    let directory = tools_directory(&app)?;
    ["go", "typescript"]
        .into_iter()
        .map(|language| {
            let available = tool_path(&directory, language)?.is_some();
            let prerequisite = if language == "go" {
                executors::executable("go")
                    .is_none()
                    .then(|| "Установите Go, затем повторите проверку.".into())
            } else {
                if executors::executable("node").is_none() {
                    Some("Установите Node.js с npm, затем повторите проверку.".into())
                } else if !available && executors::executable("npm").is_none() {
                    Some("Для установки поддержки TypeScript / JavaScript требуется npm.".into())
                } else {
                    None
                }
            };
            Ok(Tool {
                language: language.into(),
                available,
                prerequisite,
            })
        })
        .collect()
}

#[tauri::command(async)]
pub fn install_language_tool(app: tauri::AppHandle, language: String) -> Result<()> {
    let directory = tools_directory(&app)?;
    if tool_path(&directory, &language)?.is_some() {
        return Ok(());
    }
    fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let staging = tempfile::tempdir_in(&directory).map_err(|e| e.to_string())?;
    let mut command = match language.as_str() {
        "go" => {
            let mut command =
                Command::new(executors::executable("go").ok_or("сначала установите Go")?);
            fs::create_dir(staging.path().join("bin")).map_err(|e| e.to_string())?;
            command
                .args(["install", "golang.org/x/tools/gopls@v0.22.0"])
                .env("GOBIN", staging.path().join("bin"))
                .env("GOTOOLCHAIN", "local");
            command
        }
        "typescript" => {
            let mut command = Command::new(
                executors::executable("npm").ok_or("сначала установите Node.js с npm")?,
            );
            command
                .args([
                    "install",
                    "--ignore-scripts",
                    "--no-audit",
                    "--no-fund",
                    "--prefix",
                ])
                .arg(staging.path())
                .args(["typescript-language-server@6.1.0", "typescript@6"])
                .env("npm_config_cache", directory.join("npm-cache"));
            command
        }
        _ => return Err("язык не поддерживается".into()),
    };
    command
        .current_dir(staging.path())
        .env("PATH", executors::search_path());
    let (success, output) = executors::capture(&mut command, Duration::from_secs(300), true)?;
    if !success {
        return Err(format!("поддержка языка не установлена: {}", output.trim()));
    }
    fs::rename(staging.path(), directory.join(&language))
        .map_err(|e| format!("установка не завершена: {e}"))?;
    Ok(())
}

fn file_path(uri: &str) -> Result<PathBuf> {
    let url = Url::parse(uri).map_err(|e| e.to_string())?;
    if url.scheme() != "file" || url.fragment().is_some() || url.query().is_some() {
        return Err("нужен адрес локального файла".into());
    }
    let path = url
        .to_file_path()
        .map_err(|_| "адрес файла не поддерживается")?;
    if path.components().any(|part| part.as_os_str() == ".git") {
        return Err("служебные файлы Git недоступны".into());
    }
    let path = fs::canonicalize(path).map_err(|e| e.to_string())?;
    if path.components().any(|part| part.as_os_str() == ".git") {
        return Err("служебные файлы Git недоступны".into());
    }
    Ok(path)
}

fn observe_uris(value: &Value, root: &Path, readable: &mut HashSet<PathBuf>) {
    match value {
        Value::Object(object) => {
            for (key, value) in object {
                let uri = if ["uri", "targetUri"].contains(&key.as_str()) {
                    value.as_str()
                } else if key.starts_with("file:") {
                    Some(key.as_str())
                } else {
                    None
                };
                if let Some(path) = uri
                    .and_then(|uri| file_path(uri).ok())
                    .filter(|path| !path.starts_with(root) && path.is_file())
                {
                    readable.insert(path);
                }
                observe_uris(value, root, readable);
            }
        }
        Value::Array(values) => {
            for value in values {
                observe_uris(value, root, readable);
            }
        }
        _ => {}
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Started {
    id: String,
    root_uri: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerEvent {
    message: Option<String>,
    error: Option<String>,
}

#[tauri::command(async)]
pub fn start_language_server(
    app: tauri::AppHandle,
    core: State<'_, Arc<Mutex<Core>>>,
    languages: State<'_, Mutex<Languages>>,
    trust: State<'_, WorkspaceCodeTrust>,
    workspace_id: String,
    language: String,
    confirm_trust: bool,
    events: Channel<ServerEvent>,
) -> Result<Option<Started>> {
    let root = editor::root(
        &core.lock().map_err(|e| e.to_string())?.store,
        &workspace_id,
    )?;
    let executable =
        tool_path(&tools_directory(&app)?, &language)?.ok_or("поддержка языка не установлена")?;
    if language == "typescript" {
        if !trust.check(&app, &workspace_id, &root, confirm_trust)? {
            return Ok(None);
        }
        if editor::root(
            &core.lock().map_err(|e| e.to_string())?.store,
            &workspace_id,
        )? != root
        {
            return Err("путь пространства изменился".into());
        }
    }
    let mut command = if language == "typescript" {
        let mut command =
            Command::new(executors::executable("node").ok_or("сначала установите Node.js")?);
        command.arg(executable).arg("--stdio");
        command
    } else {
        Command::new(executable)
    };
    command
        .current_dir(&root)
        .env("PATH", executors::search_path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = executors::ProbeChild::spawn(&mut command)?;
    let input = child.0.stdin.take().ok_or("ввод сервера недоступен")?;
    let output = child.0.stdout.take().ok_or("вывод сервера недоступен")?;
    let mut errors = child.0.stderr.take().ok_or("ошибки сервера недоступны")?;
    let recent_errors = Arc::new(Mutex::new(Vec::<u8>::new()));
    let collected_errors = recent_errors.clone();
    std::thread::spawn(move || {
        let mut buffer = [0; 4096];
        while let Ok(count) = errors.read(&mut buffer) {
            if count == 0 {
                break;
            }
            if let Ok(mut output) = collected_errors.lock() {
                output.extend_from_slice(&buffer[..count]);
                let discard = output.len().saturating_sub(8192);
                output.drain(..discard);
            }
        }
    });
    let readable = Arc::new(Mutex::new(HashSet::new()));
    let granted = readable.clone();
    let server_root = root.clone();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(output);
        let error = loop {
            match Message::read(&mut reader) {
                Ok(Some(message)) => {
                    let value = match serde_json::to_value(&message) {
                        Ok(value) => value,
                        Err(e) => break e.to_string(),
                    };
                    if let Ok(mut paths) = granted.lock() {
                        observe_uris(&value, &server_root, &mut paths);
                    }
                    if events
                        .send(ServerEvent {
                            message: Some(value.to_string()),
                            error: None,
                        })
                        .is_err()
                    {
                        return;
                    }
                }
                Ok(None) => break "языковой сервер завершился; повторите подключение".into(),
                Err(e) => break format!("соединение с языковым сервером прервано: {e}"),
            }
        };
        let details = recent_errors
            .lock()
            .map(|bytes| String::from_utf8_lossy(&bytes).trim().to_string())
            .unwrap_or_default();
        let error = if details.is_empty() {
            error
        } else {
            format!("{error}\n{details}")
        };
        let _ = events.send(ServerEvent {
            message: None,
            error: Some(error),
        });
    });
    let id = uuid::Uuid::new_v4().to_string();
    let root_uri = Url::from_directory_path(&root)
        .map_err(|_| "путь пространства не поддерживается")?
        .to_string();
    let mut languages = languages.lock().map_err(|e| e.to_string())?;
    if languages.closing {
        return Err("приложение завершает работу".into());
    }
    languages
        .servers
        .retain(|_, server| server.workspace_id != workspace_id || server.language != language);
    languages.servers.insert(
        id.clone(),
        Server {
            workspace_id,
            language,
            root,
            _child: child,
            input,
            readable,
        },
    );
    Ok(Some(Started { id, root_uri }))
}

#[tauri::command(async)]
pub fn send_language_message(
    languages: State<'_, Mutex<Languages>>,
    id: String,
    message: String,
) -> Result<()> {
    let message: Message = serde_json::from_str(&message).map_err(|e| e.to_string())?;
    let mut languages = languages.lock().map_err(|e| e.to_string())?;
    let server = languages
        .servers
        .get_mut(&id)
        .ok_or("соединение с сервером закрыто")?;
    message.write(&mut server.input).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn stop_language_server(languages: State<'_, Mutex<Languages>>, id: String) -> Result<()> {
    languages
        .lock()
        .map_err(|e| e.to_string())?
        .servers
        .remove(&id);
    Ok(())
}

pub fn stop_all(languages: &Mutex<Languages>) {
    if let Ok(mut languages) = languages.lock() {
        languages.closing = true;
        languages.servers.clear();
    }
}

fn remembered_file(store: &Store, workspace_id: &str, root: &Path, path: &Path) -> Result<bool> {
    store.connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM language_files WHERE workspace_id=?1 AND root=?2 AND path=?3)",
        rusqlite::params![workspace_id, root.to_str().ok_or("путь не поддерживает UTF-8")?, path.to_str().ok_or("путь не поддерживает UTF-8")?],
        |row| row.get(0),
    ).map_err(|e| e.to_string())
}

fn remember_file(store: &Store, workspace_id: &str, root: &Path, path: &Path) -> Result<()> {
    store
        .connection
        .execute(
            "INSERT OR IGNORE INTO language_files(workspace_id,root,path) VALUES(?1,?2,?3)",
            rusqlite::params![
                workspace_id,
                root.to_str().ok_or("путь не поддерживает UTF-8")?,
                path.to_str().ok_or("путь не поддерживает UTF-8")?
            ],
        )
        .map_err(|e| format!("ссылка на зависимость не сохранена: {e}"))?;
    Ok(())
}

#[tauri::command(async)]
pub fn read_language_file(
    core: State<'_, Arc<Mutex<Core>>>,
    languages: State<'_, Mutex<Languages>>,
    workspace_id: String,
    uri: String,
) -> Result<editor::Document> {
    let root = editor::root(
        &core.lock().map_err(|e| e.to_string())?.store,
        &workspace_id,
    )?;
    let path = file_path(&uri)?;
    if let Ok(relative) = path.strip_prefix(&root) {
        return editor::open(
            core.inner(),
            &workspace_id,
            relative.to_str().ok_or("путь не поддерживает UTF-8")?,
        );
    }
    let allowed = languages
        .lock()
        .map_err(|e| e.to_string())?
        .servers
        .values()
        .any(|server| {
            server.workspace_id == workspace_id
                && server.root == root
                && server
                    .readable
                    .lock()
                    .is_ok_and(|paths| paths.contains(&path))
        });
    if !allowed
        && !remembered_file(
            &core.lock().map_err(|e| e.to_string())?.store,
            &workspace_id,
            &root,
            &path,
        )?
    {
        return Err("файл не был возвращён языковым сервером".into());
    }
    let body = fs::File::open(&path)
        .and_then(|file| {
            let mut body = String::new();
            file.take(4 * 1024 * 1024 + 1).read_to_string(&mut body)?;
            Ok(body)
        })
        .map_err(|e| e.to_string())?;
    if body.len() > 4 * 1024 * 1024 {
        return Err("файл зависимости слишком большой для редактора".into());
    }
    editor::validate_text(&body)?;
    if allowed {
        remember_file(
            &core.lock().map_err(|e| e.to_string())?.store,
            &workspace_id,
            &root,
            &path,
        )?;
    }
    Ok(editor::Document {
        path: uri,
        base: body.clone(),
        disk: Some(body.clone()),
        body,
        disk_error: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opened_dependency_is_remembered_only_for_its_workspace_and_root() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("workspace");
        fs::create_dir(&root).unwrap();
        let mut store = Store::open(&temp.path().join("state.db")).unwrap();
        store.register_folder("Проект", &root, None).unwrap();
        let workspace = store.snapshot().unwrap().workspaces[0].clone();
        let root = PathBuf::from(workspace.path);
        let dependency = temp.path().join("dependency.go");
        assert!(!remembered_file(&store, &workspace.id, &root, &dependency).unwrap());
        remember_file(&store, &workspace.id, &root, &dependency).unwrap();
        drop(store);
        let store = Store::open(&temp.path().join("state.db")).unwrap();
        assert!(remembered_file(&store, &workspace.id, &root, &dependency).unwrap());
        assert!(!remembered_file(&store, "other", &root, &dependency).unwrap());
        assert!(!remembered_file(&store, &workspace.id, temp.path(), &dependency).unwrap());
        assert!(!remembered_file(&store, &workspace.id, &root, &root.join("other.go")).unwrap());
    }

    #[test]
    fn only_local_server_locations_grant_external_files() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("with space.go");
        fs::write(&file, "package dependency").unwrap();
        let uri = Url::from_file_path(&file).unwrap().to_string();
        let mut granted = HashSet::new();
        observe_uris(
            &serde_json::json!({"contents": uri}),
            Path::new("/workspace"),
            &mut granted,
        );
        assert!(granted.is_empty());
        observe_uris(
            &serde_json::json!({"result": [{"targetUri": uri}]}),
            Path::new("/workspace"),
            &mut granted,
        );
        assert!(granted.contains(&fs::canonicalize(file).unwrap()));
        assert!(file_path("https://example.org/file.go").is_err());
        assert!(file_path("file:///workspace/.git/config").is_err());
    }

    #[test]
    fn lsp_transport_round_trips_utf8_and_consecutive_messages() {
        let message: Message = serde_json::from_value(serde_json::json!({"jsonrpc":"2.0","id":1,"method":"textDocument/hover","params":{"text":"привет 🦀"}})).unwrap();
        let mut bytes = Vec::new();
        message.write(&mut bytes).unwrap();
        message.write(&mut bytes).unwrap();
        let mut reader = BufReader::new(bytes.as_slice());
        for _ in 0..2 {
            assert_eq!(
                serde_json::to_value(Message::read(&mut reader).unwrap().unwrap()).unwrap(),
                serde_json::to_value(&message).unwrap()
            );
        }
        assert!(Message::read(&mut reader).unwrap().is_none());
    }
}
