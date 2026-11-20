use crate::store::Result;
use portable_pty::CommandBuilder;
use serde::Serialize;
use std::{fs, io::Read, path::Path, sync::Mutex};

const INPUT_READY: &str = "function _yade_input_ready() {
  builtin printf '\\e]777;%s;B\\a' \"$_yade_token\"
  [[ -e $_yade_directory/started ]] || builtin print -rn -- ready > \"$_yade_directory/started\"
}
";

const RAW_READY_HOOK: &str = "function _yade_raw_ready() {
  _yade_input_ready
  precmd_functions=( ${precmd_functions:#_yade_raw_ready} )
}
precmd_functions+=(_yade_raw_ready)
";

pub(crate) struct Shell {
    pub directory: tempfile::TempDir,
    pub token: String,
    pub editor_lock: Mutex<()>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Editor {
    pub request: u64,
    pub command: String,
    pub cursor: usize,
    pub suggestion: String,
    pub command_known: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Context {
    pub cwd: String,
    pub home: String,
    pub branch: String,
    pub command: String,
}

impl Shell {
    pub fn configure(command: &mut CommandBuilder) -> Result<Option<Self>> {
        if !cfg!(target_os = "macos")
            || command
                .get_argv()
                .first()
                .and_then(|s| Path::new(s).file_name())
                != Some("zsh".as_ref())
            || !command.get_argv().iter().any(|arg| arg == "-i")
            || !command.get_argv().iter().any(|arg| arg == "-l")
        {
            return Ok(None);
        }
        let directory = tempfile::Builder::new()
            .prefix("yade-terminal-")
            .tempdir()
            .map_err(|e| e.to_string())?;
        let token = uuid::Uuid::new_v4().to_string();
        let quote = |value: &str| format!("'{}'", value.replace('\'', "'\\''"));
        let original = command
            .get_env("ZDOTDIR")
            .map(|s| s.to_string_lossy().into_owned());
        let root = quote(&directory.path().to_string_lossy());
        for name in [".zshenv", ".zprofile", ".zshrc", ".zlogin"] {
            let mut script = if name == ".zshenv" {
                format!(
                    "typeset -g _yade_directory={root}\ntypeset -g _yade_token={}\n{INPUT_READY}{}\n",
                    quote(&token),
                    original
                        .as_ref()
                        .map(|value| format!("ZDOTDIR={}", quote(value)))
                        .unwrap_or_else(|| "unset ZDOTDIR".into())
                )
            } else {
                "if (( _yade_zdotdir_set )); then ZDOTDIR=$_yade_zdotdir; else unset ZDOTDIR; fi\n"
                    .into()
            };
            if name == ".zshrc" {
                // Системный /etc/zshrc выбирает историю, пока ZDOTDIR указывает на временный каталог.
                script.push_str(&format!(
                    "if [[ ${{HISTFILE-}} == {root}/.zsh_history ]]; then HISTFILE=${{ZDOTDIR:-$HOME}}/.zsh_history; fi\n"
                ));
            }
            script.push_str(&format!("[[ -r ${{ZDOTDIR:-$HOME}}/{name} ]] && builtin source -- \"${{ZDOTDIR:-$HOME}}/{name}\"\n"));
            if name == ".zlogin" {
                script.push_str(&format!("if [[ -o zle ]]; then\nbuiltin source -- {root}/integration.zsh\nelse\n{RAW_READY_HOOK}fi\n"));
            } else {
                script.push_str(&format!("if [[ -o rcs ]]; then\ntypeset -g _yade_zdotdir_set=${{+ZDOTDIR}}\ntypeset -g _yade_zdotdir=${{ZDOTDIR-}}\nZDOTDIR={root}\nelse\n{RAW_READY_HOOK}fi\n"));
            }
            fs::write(directory.path().join(name), script).map_err(|e| e.to_string())?;
        }
        fs::write(
            directory.path().join("integration.zsh"),
            include_str!("terminal_shell.zsh"),
        )
        .map_err(|e| e.to_string())?;
        command.env("ZDOTDIR", directory.path());
        Ok(Some(Self {
            directory,
            token,
            editor_lock: Mutex::new(()),
        }))
    }

    fn read(&self, name: &str) -> Result<String> {
        match fs::File::open(self.directory.path().join(name)) {
            Ok(file) => {
                let mut bytes = Vec::new();
                file.take(2 * 1024 * 1024)
                    .read_to_end(&mut bytes)
                    .map_err(|e| e.to_string())?;
                Ok(String::from_utf8_lossy(&bytes).into_owned())
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
            Err(error) => Err(error.to_string()),
        }
    }

    pub fn context(&self) -> Result<Context> {
        Ok(Context {
            cwd: self.read("cwd")?,
            home: self.read("home")?,
            branch: self.read("branch")?,
            command: self.read("command")?,
        })
    }

    pub fn editor(&self) -> Result<Option<Editor>> {
        let value = self.read("editor")?;
        if value.is_empty() {
            return Ok(None);
        }
        let fields: Vec<_> = value.split_terminator('\0').collect();
        if fields.len() != 5 {
            return Err("некорректное состояние редактора оболочки".into());
        }
        Ok(Some(Editor {
            request: fields[0]
                .parse()
                .map_err(|_| "некорректный запрос редактора оболочки")?,
            command: fields[1].into(),
            cursor: fields[2]
                .parse()
                .map_err(|_| "некорректная позиция курсора оболочки")?,
            suggestion: fields[3].into(),
            command_known: fields[4] == "1",
        }))
    }
}
