use crate::store::Result;
use serde::{Deserialize, Serialize};
use std::{
    ffi::OsString,
    io::Read,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::OnceLock,
    thread,
    time::{Duration, Instant},
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Availability {
    pub executor: String,
    pub path: Option<PathBuf>,
    pub version: Option<String>,
    pub state: String,
    pub reason: String,
    pub action: String,
}

static SEARCH_PATH: OnceLock<OsString> = OnceLock::new();
static RUNTIME_DIRECTORY: OnceLock<PathBuf> = OnceLock::new();

pub(crate) fn initialize(resource_directory: &Path) {
    let runtime = resource_directory.join("runtime");
    let _ = RUNTIME_DIRECTORY.set(runtime.clone());
    let shell = std::env::var_os("SHELL").unwrap_or_else(|| "/bin/zsh".into());
    let login_path = capture(
        Command::new(shell).args(["-ilc", "printf '\\0%s\\0' \"$PATH\""]),
        Duration::from_secs(5),
        false,
    )
    .ok()
    .filter(|(success, _)| *success)
    .and_then(|(_, text)| text.split('\0').nth(1).map(OsString::from));
    let _ = SEARCH_PATH.set(tool_path(
        std::env::var_os("PATH").unwrap_or_default(),
        login_path,
        std::env::var_os("HOME"),
        (!cfg!(debug_assertions)).then(|| runtime.join("bin")),
    ));
}

fn tool_path(
    inherited: OsString,
    login: Option<OsString>,
    home: Option<OsString>,
    runtime_bin: Option<PathBuf>,
) -> OsString {
    let mut directories: Vec<PathBuf> = runtime_bin.into_iter().collect();
    directories.extend(std::env::split_paths(&login.unwrap_or(inherited)));
    if let Some(home) = home {
        for suffix in [".local/bin", ".cargo/bin", ".npm-global/bin"] {
            directories.push(PathBuf::from(&home).join(suffix));
        }
    }
    directories.extend(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].map(PathBuf::from));
    directories.retain(|path| path.is_absolute());
    std::env::join_paths(directories).unwrap_or_else(|_| "/usr/bin:/bin".into())
}

pub(crate) fn search_path() -> OsString {
    SEARCH_PATH.get().cloned().unwrap_or_else(|| {
        tool_path(
            std::env::var_os("PATH").unwrap_or_default(),
            None,
            std::env::var_os("HOME"),
            None,
        )
    })
}

pub fn executable(name: &str) -> Option<PathBuf> {
    find_executable(
        name,
        &std::env::split_paths(&search_path()).collect::<Vec<_>>(),
    )
}

pub(crate) fn claude_command(script: &str) -> Result<Command> {
    if cfg!(debug_assertions) {
        let node = executable("node")
            .ok_or("для разработки подключения Claude Code нужна среда Node.js")?;
        let mut command = Command::new(node);
        command.arg(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../executors")
                .join(script),
        );
        return Ok(command);
    }
    bundled_claude_command(
        RUNTIME_DIRECTORY
            .get()
            .ok_or("не определён каталог ресурсов приложения")?,
        script,
    )
}

pub(crate) fn bundled_claude_command(directory: &Path, script: &str) -> Result<Command> {
    let node = directory.join("bin/node");
    let script = directory.join(script);
    if !node.is_file() || !script.is_file() {
        return Err("в сборке отсутствует среда Claude Code; переустановите приложение".into());
    }
    let mut command = Command::new(node);
    command.arg(script);
    Ok(command)
}

fn find_executable(name: &str, directories: &[PathBuf]) -> Option<PathBuf> {
    directories.iter().map(|p| p.join(name)).find(|p| {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            p.metadata()
                .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        }
        #[cfg(not(unix))]
        p.is_file()
    })
}

pub fn environment(executor: &str) -> Vec<(OsString, OsString)> {
    let mut variables: Vec<_> = std::env::vars_os()
        .filter(|(key, _)| !blocked_variable(executor, &key.to_string_lossy()))
        .filter(|(key, _)| key != "PATH")
        .collect();
    variables.push(("PATH".into(), search_path()));
    variables
}

fn blocked_variable(executor: &str, key: &str) -> bool {
    match executor {
        "codex" => ["OPENAI_API_KEY", "CODEX_API_KEY"].contains(&key),
        "claude" => [
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_AUTH_TOKEN",
            "CLAUDE_CODE_OAUTH_TOKEN",
            "AWS_BEARER_TOKEN_BEDROCK",
            "ANTHROPIC_CUSTOM_HEADERS",
            "CLAUDECODE",
            "CLAUDE_CODE_USE_BEDROCK",
            "CLAUDE_CODE_USE_VERTEX",
            "CLAUDE_CODE_USE_FOUNDRY",
        ]
        .contains(&key),
        _ => false,
    }
}

pub(crate) struct ProbeChild(pub Child);

impl ProbeChild {
    pub fn spawn(command: &mut Command) -> Result<Self> {
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        command
            .spawn()
            .map(Self)
            .map_err(|e| format!("не удалось запустить проверку: {e}"))
    }

    fn completed(&mut self) -> Result<Option<bool>> {
        #[cfg(unix)]
        {
            let mut status = unsafe { std::mem::zeroed::<libc::siginfo_t>() };
            let result = unsafe {
                libc::waitid(
                    libc::P_PID,
                    self.0.id(),
                    &mut status,
                    libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
                )
            };
            if result != 0 {
                return Err(std::io::Error::last_os_error().to_string());
            }
            Ok((unsafe { status.si_pid() } != 0)
                .then(|| status.si_code == libc::CLD_EXITED && unsafe { status.si_status() } == 0))
        }
        #[cfg(not(unix))]
        self.0
            .try_wait()
            .map(|status| status.map(|s| s.success()))
            .map_err(|e| e.to_string())
    }
}

impl Drop for ProbeChild {
    fn drop(&mut self) {
        // Дескриптор ещё не завершённого процесса удерживает PID его группы.
        #[cfg(unix)]
        unsafe {
            libc::kill(-(self.0.id() as i32), libc::SIGKILL);
        }
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

pub(crate) fn capture(
    command: &mut Command,
    timeout: Duration,
    from_stderr: bool,
) -> Result<(bool, String)> {
    command
        .stdin(Stdio::null())
        .stdout(if from_stderr {
            Stdio::null()
        } else {
            Stdio::piped()
        })
        .stderr(if from_stderr {
            Stdio::piped()
        } else {
            Stdio::null()
        });
    let mut child = ProbeChild::spawn(command)?;
    let output: Box<dyn Read + Send> = if from_stderr {
        Box::new(child.0.stderr.take().ok_or("статус входа недоступен")?)
    } else {
        Box::new(child.0.stdout.take().ok_or("вывод проверки недоступен")?)
    };
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = output
            .take(262145)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())
            .and_then(|_| {
                if bytes.len() > 262144 {
                    Err("слишком большой ответ проверки".into())
                } else {
                    String::from_utf8(bytes).map_err(|e| e.to_string())
                }
            });
        let _ = sender.send(result);
    });
    let deadline = Instant::now() + timeout;
    let text = receiver
        .recv_timeout(timeout)
        .map_err(|_| "проверка не ответила вовремя")??;
    loop {
        if let Some(success) = child.completed()? {
            return Ok((success, text));
        }
        if Instant::now() >= deadline {
            return Err("проверка не завершилась вовремя".into());
        }
        thread::sleep(Duration::from_millis(10));
    }
}

pub fn discover(executor: &str, cwd: &Path) -> Availability {
    let neutral_directory = (executor == "claude").then(std::env::temp_dir);
    discover_path(
        executor,
        neutral_directory.as_deref().unwrap_or(cwd),
        executable(executor),
    )
}

fn discover_path(executor: &str, cwd: &Path, path: Option<PathBuf>) -> Availability {
    let mut result = Availability {
        executor: executor.into(),
        path,
        version: None,
        state: "missing".into(),
        reason: format!("{executor} не найден"),
        action: format!("Установите {executor} и повторите проверку."),
    };
    let Some(path) = result.path.clone() else {
        return result;
    };
    let check = || -> Result<String> {
        let mut command = Command::new(&path);
        command
            .current_dir(cwd)
            .env_clear()
            .envs(environment(executor));
        let (success, output) = capture(command.arg("--version"), Duration::from_secs(15), false)?;
        let version = output
            .split_whitespace()
            .find(|s| s.chars().next().is_some_and(|c| c.is_ascii_digit()))
            .ok_or("версия CLI не распознана")?
            .to_string();
        if !success {
            return Err("CLI не смог сообщить версию".into());
        }
        Ok(version)
    };
    let version = match check() {
        Ok(version) => version,
        Err(reason) => {
            result.state = "error".into();
            result.reason = reason;
            return result;
        }
    };
    result.version = Some(version);
    let mut command = Command::new(path);
    command
        .current_dir(cwd)
        .env_clear()
        .envs(environment(executor));
    let args: &[&str] = if executor == "codex" {
        &["login", "status"]
    } else {
        &["auth", "status", "--json"]
    };
    // Codex сообщает статус в stderr; содержимое никогда не передаётся в интерфейс.
    let auth = if executor == "codex" {
        command.args(args);
        capture(&mut command, Duration::from_secs(15), true).and_then(|(success, text)| {
            let authenticated = parse_codex_auth(&text)?;
            if authenticated && !success {
                return Err("CLI отклонил проверку входа".into());
            }
            Ok(authenticated)
        })
    } else {
        capture(command.args(args), Duration::from_secs(15), false)
            .and_then(|(success, output)| parse_claude_auth(success, &output))
    };
    match auth {
        Ok(true) => {
            result.state = "ready".into();
            result.reason =
                "штатный подписочный вход найден; доступ к ответу проверяется при выполнении"
                    .into();
            result.action.clear();
        }
        Ok(false) => {
            result.state = "loginRequired".into();
            result.reason = "требуется штатный вход по подписке".into();
            result.action = if executor == "codex" {
                "Выполните codex login в терминале."
            } else {
                "Выполните claude auth login --claudeai в терминале."
            }
            .into();
        }
        Err(reason) => {
            result.state = "error".into();
            result.reason = reason;
            result.action = "Проверьте CLI в терминале и повторите проверку.".into();
        }
    }
    result
}

fn parse_codex_auth(text: &str) -> Result<bool> {
    if text.contains("Logged in using ChatGPT") {
        Ok(true)
    } else if text.contains("Not logged in") || text.contains("Logged in using an API key") {
        Ok(false)
    } else {
        Err("статус входа Codex не распознан; проверьте совместимость CLI".into())
    }
}

fn parse_claude_auth(success: bool, text: &str) -> Result<bool> {
    let value: serde_json::Value =
        serde_json::from_str(text).map_err(|_| "статус входа Claude Code не распознан")?;
    match value["loggedIn"].as_bool() {
        Some(false) => Ok(false),
        Some(true) => Ok(success
            && value["authMethod"] == "claude.ai"
            && value["subscriptionType"]
                .as_str()
                .is_some_and(|s| !s.is_empty())),
        None => Err("статус входа Claude Code не распознан".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn timed_out_probe_is_terminated_and_reaped() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("probe.pid");
        let result = capture(
            Command::new("/bin/sh")
                .args(["-c", "echo $$ > \"$1\"; exec /bin/sleep 30", "probe"])
                .arg(&path),
            Duration::from_millis(100),
            false,
        );
        assert!(result.unwrap_err().contains("вовремя"));
        let pid: i32 = std::fs::read_to_string(path)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::ESRCH)
        );
    }
    #[test]
    fn subscription_status_never_accepts_api_keys_or_unknown_output() {
        assert!(parse_codex_auth("Logged in using ChatGPT").unwrap());
        assert!(!parse_codex_auth("Not logged in").unwrap());
        assert!(!parse_codex_auth("Logged in using an API key").unwrap());
        assert!(parse_codex_auth("unexpected").is_err());
        assert!(parse_claude_auth(
            true,
            r#"{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"pro"}"#
        )
        .unwrap());
        assert!(!parse_claude_auth(true, r#"{"loggedIn":true,"authMethod":"api_key"}"#).unwrap());
        assert!(!parse_claude_auth(false, r#"{"loggedIn":false}"#).unwrap());
        assert!(parse_claude_auth(true, "invalid").is_err());
    }
    #[test]
    fn credentials_are_removed_without_mixing_profiles() {
        for key in [
            "ANTHROPIC_API_KEY",
            "CLAUDE_CODE_OAUTH_TOKEN",
            "CLAUDE_CODE_USE_BEDROCK",
        ] {
            assert!(blocked_variable("claude", key));
        }
        assert!(blocked_variable("codex", "OPENAI_API_KEY"));
        assert!(!blocked_variable("codex", "CODEX_HOME"));
        assert!(!blocked_variable("claude", "CLAUDE_CONFIG_DIR"));
        assert!(!blocked_variable("claude", "HTTPS_PROXY"));
    }
    #[test]
    fn lookup_requires_executable_file() {
        let temp = tempfile::tempdir().unwrap();
        assert!(find_executable("codex", &[temp.path().into()]).is_none());
        std::fs::create_dir(temp.path().join("codex")).unwrap();
        assert!(find_executable("codex", &[temp.path().into()]).is_none());
    }
    #[test]
    fn finder_path_keeps_login_tools_and_the_bundled_node() {
        let path = tool_path(
            "/usr/bin:/bin".into(),
            Some("/Users/test/.nvm/versions/node/v26.8.1/bin:/custom/bin:.:".into()),
            Some("/Users/test".into()),
            Some("/Applications/Yade.app/Contents/Resources/runtime/bin".into()),
        );
        let directories = std::env::split_paths(&path).collect::<Vec<_>>();
        assert_eq!(
            directories[0],
            Path::new("/Applications/Yade.app/Contents/Resources/runtime/bin")
        );
        assert!(directories.contains(&PathBuf::from("/Users/test/.nvm/versions/node/v26.8.1/bin")));
        assert!(directories.contains(&PathBuf::from("/custom/bin")));
        assert!(directories.contains(&PathBuf::from("/Users/test/.local/bin")));
        assert!(directories.contains(&PathBuf::from("/usr/bin")));
        assert!(directories.iter().all(|directory| directory.is_absolute()));
    }

    #[test]
    fn bundled_runtime_never_falls_back_to_a_development_installation() {
        let temp = tempfile::tempdir().unwrap();
        assert!(bundled_claude_command(temp.path(), "claude-bridge.ts").is_err());
        std::fs::create_dir(temp.path().join("bin")).unwrap();
        std::fs::write(temp.path().join("bin/node"), "").unwrap();
        std::fs::write(temp.path().join("claude-bridge.ts"), "").unwrap();
        let command = bundled_claude_command(temp.path(), "claude-bridge.ts").unwrap();
        assert_eq!(command.get_program(), temp.path().join("bin/node"));
        assert_eq!(
            command.get_args().next().unwrap(),
            temp.path().join("claude-bridge.ts")
        );
        assert!(bundled_claude_command(temp.path(), "claude-settings.mjs").is_err());
    }

    #[test]
    #[ignore = "проверяет ресурсы собранной .app и установленные инструменты без отправки сообщений"]
    fn installed_application_discovers_tools_from_a_finder_environment() {
        let app = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target/release/bundle/macos/Yade.app/Contents/Resources");
        initialize(&app);
        let runtime = app.join("runtime");
        assert!(runtime.join("bin/node").is_file());
        let cwd = tempfile::tempdir().unwrap();
        for name in ["codex", "claude"] {
            let available = discover(name, cwd.path());
            println!("{name}: {} {:?}", available.state, available.version);
            assert!(
                available.path.is_some(),
                "{} {}",
                available.reason,
                available.action
            );
            assert!(available.version.is_some(), "{}", available.reason);
            let missing = discover_path(name, cwd.path(), None);
            assert_eq!(missing.state, "missing");
            assert!(missing.action.contains(name));
        }
        assert!(crate::workspaces::git(cwd.path(), &["--version"])
            .unwrap()
            .starts_with("git version"));
        let mut command = bundled_claude_command(&runtime, "claude-settings.mjs").unwrap();
        command
            .arg(executable("claude").unwrap())
            .arg("{}");
        command.env_clear().envs(environment("claude"));
        let (success, output) = capture(&mut command, Duration::from_secs(30), false).unwrap();
        assert!(success, "{output}");
        assert!(
            !serde_json::from_str::<serde_json::Value>(&output).unwrap()["models"]
                .as_array()
                .unwrap()
                .is_empty()
        );
    }
    #[cfg(unix)]
    #[test]
    fn discovery_distinguishes_missing_and_login_required() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        assert_eq!(discover_path("codex", temp.path(), None).state, "missing");
        let path = temp.path().join("codex");
        std::fs::write(&path, "#!/bin/sh\nif [ \"$1\" = --version ]; then echo codex-cli 0.1.0; else echo 'Not logged in' >&2; exit 1; fi\n").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(
            discover_path("codex", temp.path(), Some(path)).state,
            "loginRequired"
        );
    }
    #[cfg(unix)]
    #[test]
    fn discovery_accepts_any_cli_version() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        for (executor, auth) in [
            ("codex", "echo 'Logged in using ChatGPT' >&2"),
            (
                "claude",
                r#"echo '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"pro"}'"#,
            ),
        ] {
            let path = temp.path().join(executor);
            for version in ["0.1.0", "0.167.1", "2.1.142", "99.0.0-beta.1"] {
                std::fs::write(
                    &path,
                    format!("#!/bin/sh\nif [ \"$1\" = --version ]; then echo {executor} {version}; else {auth}; fi\n"),
                )
                .unwrap();
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
                let result = discover_path(executor, temp.path(), Some(path.clone()));
                assert_eq!(
                    result.state, "ready",
                    "{executor} {version}: {}",
                    result.reason
                );
                assert_eq!(result.version.as_deref(), Some(version));
                assert!(result.action.is_empty());
            }
        }
    }
    #[test]
    #[ignore = "проверяет установленные локальные CLI без отправки сообщений"]
    fn local_discovery() {
        let cwd = std::env::current_dir().unwrap();
        for executor in ["codex", "claude"] {
            let result = discover(executor, &cwd);
            println!("{executor}: {} {:?}", result.state, result.version);
            assert!(result.path.is_some());
            assert!(result.version.is_some());
        }
    }
}
